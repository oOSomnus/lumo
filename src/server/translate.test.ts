import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranslatePageInput, TranslateStreamEvent, TranslationContent } from "../shared/contracts";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { AiRuntime } from "./ai";
import { createAiRuntime } from "./ai";
import type { AiManager } from "./ai-settings";
import {
  getTranslation,
  openReaderDb,
  saveTranslation,
  storeDocument,
} from "./storage";
import { handleTranslate } from "./translate";

const directories: string[] = [];
const databases: Database[] = [];

function setup(): {
  directory: string;
  db: Database;
  documentId: string;
  input: TranslatePageInput;
} {
  const directory = mkdtempSync(join(tmpdir(), "lumo-translate-"));
  directories.push(directory);
  const db = openReaderDb(directory);
  databases.push(db);
  const document = storeDocument(
    db,
    { name: "doc.pdf", pageCount: 3 },
    new TextEncoder().encode("%PDF-1.7 translate fixture"),
  );
  return {
    directory,
    db,
    documentId: document.id,
    input: {
      documentId: document.id,
      pageNumber: 1,
      targetLanguage: "en",
      text: "Hello",
      imageBase64: "/9j/AAAA",
      force: false,
    },
  };
}

function context(
  db: Database,
  ai: Pick<AiManager, "getRuntime">,
): { db: Database; ai: Pick<AiManager, "getRuntime"> } {
  return { db, ai };
}

function ai(
  translate: AiRuntime["translatePage"],
  configured: Awaited<ReturnType<AiRuntime["checkConfigured"]>> = { ok: true },
): AiRuntime {
  return {
    checkConfigured: async () => configured,
    translatePage: translate,
    extractOutlinePage: async () => {
      throw new Error("unexpected outline request");
    },
  };
}

function manager(runtime: AiRuntime): Pick<AiManager, "getRuntime"> {
  return { getRuntime: async () => runtime };
}

function request(input: TranslatePageInput, signal?: AbortSignal): Request {
  return new Request("http://127.0.0.1:1234/api/translate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
}

function events(text: string): TranslateStreamEvent[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as TranslateStreamEvent);
}

function content(markdown: string): TranslationContent {
  return { markdown, provider: "mock", model: "vision" };
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("handleTranslate", () => {
  test("serves a cached translation without calling the provider", async () => {
    const { db, input } = setup();
    saveTranslation(db, input, content("# cached"));

    const response = await handleTranslate(
      request(input),
      context(db, manager(createAiRuntime(null, builtinModels()))),
    );
    const parsed = events(await response.text());

    expect(parsed).toEqual([
      { type: "done", translation: expect.objectContaining({ markdown: "# cached" }), cacheHit: true },
    ]);
  });

  test("streams deltas, saves the result and marks the page translated", async () => {
    const { db, documentId, input } = setup();
    const response = await handleTranslate(
      request(input),
      context(db, manager(ai(async (received, _signal, onText) => {
        expect(received).toEqual(input);
        onText({ contentIndex: 0, delta: "# Hello" });
        onText({ contentIndex: 1, delta: "\n\nWorld" });
        return content("# Hello\n\nWorld");
      }))),
    );
    const parsed = events(await response.text());

    expect(parsed.map((event) => event.type)).toEqual(["start", "delta", "delta", "saving", "done"]);
    expect(parsed[4]).toMatchObject({
      type: "done",
      cacheHit: false,
      translation: { markdown: "# Hello\n\nWorld", documentId, pageNumber: 1, targetLanguage: "en" },
    });
    expect(getTranslation(db, input)?.markdown).toBe("# Hello\n\nWorld");
  });

  test("pins each request to the runtime captured when it started", async () => {
    const { db, input } = setup();
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let startedA!: () => void;
    const reachedA = new Promise<void>((resolve) => {
      startedA = resolve;
    });
    const runtimeA = ai(async () => {
      startedA();
      await gateA;
      return { ...content("# A"), provider: "provider-a", model: "model-a" };
    });
    const runtimeB = ai(async () => ({
      ...content("# B"),
      provider: "provider-b",
      model: "model-b",
    }));
    let current = runtimeA;
    const active = { getRuntime: async () => current };

    const responseA = await handleTranslate(
      request(input),
      context(db, active),
    );
    await reachedA;
    current = runtimeB;
    const responseB = await handleTranslate(
      request({ ...input, pageNumber: 2 }),
      context(db, active),
    );
    releaseA();

    const [parsedA, parsedB] = await Promise.all([
      responseA.text().then(events),
      responseB.text().then(events),
    ]);
    expect(parsedA.at(-1)).toMatchObject({
      type: "done",
      translation: { provider: "provider-a", model: "model-a" },
    });
    expect(parsedB.at(-1)).toMatchObject({
      type: "done",
      translation: { provider: "provider-b", model: "model-b" },
    });
  });

  test("skips the cache when force is true", async () => {
    const { db, input } = setup();
    saveTranslation(db, input, content("# old"));
    const called = { value: false };

    const response = await handleTranslate(
      request({ ...input, force: true }),
      context(db, manager(ai(async () => {
        called.value = true;
        return content("# new");
      }))),
    );
    const parsed = events(await response.text());

    expect(called.value).toBe(true);
    expect(parsed.at(-1)).toMatchObject({ type: "done", translation: { markdown: "# new" } });
  });

  test("returns 503 before opening the stream when credentials are missing", async () => {
    const { db, input } = setup();
    const runtime = createAiRuntime(null, builtinModels());
    const pending = handleTranslate(request(input), context(db, manager(runtime)));
    await expect(pending).rejects.toMatchObject({ status: 503, code: "AI_NOT_CONFIGURED" });
  });

  test("returns the draft when saving fails", async () => {
    const { db, input } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const response = await handleTranslate(
      request(input),
      context(db, manager(ai(async () => {
        await gate;
        return content("# draft");
      }))),
    );
    db.exec("DROP TABLE translations");
    release();
    const parsed = events(await response.text());

    expect(parsed.at(-1)).toMatchObject({
      type: "error",
      error: { code: "STORAGE_ERROR" },
      draft: { markdown: "# draft" },
    });
  });

  test("stops without a terminal event when the client aborts", async () => {
    const { db, input } = setup();
    const controller = new AbortController();
    const response = await handleTranslate(
      request(input, controller.signal),
      context(db, manager(ai(async (_input, signal) => {
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        throw new Error("unreachable");
      }))),
    );
    controller.abort(new DOMException("cancelled", "AbortError"));
    const parsed = events(await response.text());

    expect(parsed.map((event) => event.type)).toEqual(["start"]);
  });
});
