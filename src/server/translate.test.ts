import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranslatePageInput, TranslateStreamEvent, TranslationContent, TypstRepair } from "../shared/contracts";
import { epubTranslationUnit } from "../shared/epub";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { AiRuntime } from "./ai";
import { AiError, createAiRuntime } from "./ai";
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
    { name: "doc.pdf", pageCount: 3, format: "pdf" },
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
      format: "pdf",
      text: "Hello",
      imageBase64: "/9j/AAAA",
      force: false,
    },
  };
}

// A repair carries identity and diagnostics only; the failed page never travels with it.
function repairOf(input: TranslatePageInput, repair: TypstRepair): TranslatePageInput {
  return {
    documentId: input.documentId,
    pageNumber: input.pageNumber,
    targetLanguage: input.targetLanguage,
    format: "pdf",
    force: input.force,
    repair,
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

function content(typst: string): TranslationContent {
  return { typst, provider: "mock", model: "vision" };
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
      {
        type: "cached",
        translation: expect.objectContaining({ typst: "# cached" }),
      },
    ]);
  });

  test("keeps selection and section caches independent", async () => {
    const { db, input } = setup();
    const selection = { ...input, unit: "sel-a1" };
    saveTranslation(db, selection, content("# selected"));
    const whole = await handleTranslate(
      request(input),
      context(db, manager(ai(async () => content("# whole")))),
    );
    expect(events(await whole.text()).at(-1)).toMatchObject({
      type: "generated",
      content: { typst: "# whole" },
    });
    const cached = await handleTranslate(
      request(selection),
      context(db, manager(createAiRuntime(null, builtinModels()))),
    );
    expect(events(await cached.text())).toEqual([
      {
        type: "cached",
        translation: expect.objectContaining({
          typst: "# selected",
          unit: "sel-a1",
        }),
      },
    ]);
  });

  test("streams deltas and returns generated content without saving it", async () => {
    const { db, documentId, input } = setup();
    const response = await handleTranslate(
      request(input),
      context(db, manager(ai(async (received, _signal, onText) => {
        expect(received).toEqual(input);
        onText({ contentIndex: 0, delta: "= Hello" });
        onText({ contentIndex: 1, delta: "\n\nWorld" });
        return content("= Hello\n\nWorld");
      }))),
    );
    const parsed = events(await response.text());

    expect(parsed.map((event) => event.type)).toEqual([
      "start",
      "delta",
      "delta",
      "generated",
    ]);
    expect(parsed[3]).toMatchObject({
      type: "generated",
      content: { typst: "= Hello\n\nWorld", provider: "mock", model: "vision" },
    });
    expect(getTranslation(db, input)).toBeNull();
    expect(documentId).toBe(input.documentId);
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
      type: "generated",
      content: { provider: "provider-a", model: "model-a" },
    });
    expect(parsedB.at(-1)).toMatchObject({
      type: "generated",
      content: { provider: "provider-b", model: "model-b" },
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
    expect(parsed.at(-1)).toMatchObject({
      type: "generated",
      content: { typst: "# new" },
    });
  });

  test("generates a repair candidate instead of serving the cache and never writes it", async () => {
    const { db, input } = setup();
    saveTranslation(db, input, content("# old"));
    const repair = { typst: "# old", diagnostics: "unclosed delimiter" };
    const received: TranslatePageInput[] = [];

    const fixed = await handleTranslate(
      request(repairOf(input, repair)),
      context(db, manager(ai(async (value) => {
        received.push(value);
        return content("# fixed");
      }))),
    );
    expect(events(await fixed.text()).at(-1)).toMatchObject({
      type: "generated",
      content: { typst: "# fixed" },
    });
    expect(received[0]).toEqual(repairOf(input, repair));

    const failed = await handleTranslate(
      request(repairOf(input, repair)),
      context(db, manager(ai(async () => {
        throw new AiError("AI_REQUEST_FAILED", "provider failed");
      }))),
    );
    expect(events(await failed.text()).at(-1)).toMatchObject({ type: "error" });
    expect(getTranslation(db, input)).toMatchObject({ typst: "# old" });
  });

  test("returns 503 before opening the stream when credentials are missing", async () => {
    const { db, input } = setup();
    const runtime = createAiRuntime(null, builtinModels());
    const pending = handleTranslate(request(input), context(db, manager(runtime)));
    await expect(pending).rejects.toMatchObject({ status: 503, code: "AI_NOT_CONFIGURED" });
  });

  test("rejects input whose format does not match the stored document", async () => {
    const { db, input } = setup();
    const sourceCfi = "epubcfi(/6/4!/4/2,/1:0,/1:9)";
    await expect(
      handleTranslate(
        request({
          documentId: input.documentId,
          pageNumber: 1,
          targetLanguage: "en",
          format: "epub",
          unit: await epubTranslationUnit("page", sourceCfi),
          sourceCfi,
          xhtml: "<p>Hello</p>",
          images: [],
          force: false,
        }),
        context(db, manager(ai(async () => content("= ignored")))),
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "INVALID_REQUEST",
      message: "translation input format does not match the document",
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

  test("relays repair progress between start and the generated translation", async () => {
    const { db, input } = setup();
    const repairInput = repairOf(input, {
      typst: "#strong[open",
      diagnostics: "error: unclosed delimiter",
    });
    const response = await handleTranslate(
      request(repairInput),
      context(
        db,
        manager(
          ai(async (_input, _signal, _onText, onRepair) => {
            onRepair?.({ phase: "requesting", replyAttempt: 1 });
            onRepair?.({ phase: "applied", replyAttempt: 1, change: { mode: "edits", count: 1 } });
            return content("#strong[open]");
          }),
        ),
      ),
    );

    expect(events(await response.text())).toEqual([
      { type: "start" },
      { type: "repair", progress: { phase: "requesting", replyAttempt: 1 } },
      {
        type: "repair",
        progress: { phase: "applied", replyAttempt: 1, change: { mode: "edits", count: 1 } },
      },
      { type: "generated", content: content("#strong[open]") },
    ]);
  });

  test("ends with an error, not a translation, when repair fails after reporting progress", async () => {
    const { db, input } = setup();
    const repairInput = repairOf(input, {
      typst: "#strong[open",
      diagnostics: "error: unclosed delimiter",
    });
    const response = await handleTranslate(
      request(repairInput),
      context(
        db,
        manager(
          ai(async (_input, _signal, _onText, onRepair) => {
            onRepair?.({ phase: "requesting", replyAttempt: 1 });
            onRepair?.({
              phase: "rejected",
              replyAttempt: 1,
              error: { code: "INVALID_AI_OUTPUT", message: "model returned invalid Typst repair JSON" },
            });
            throw new AiError("INVALID_AI_OUTPUT", "model returned invalid Typst repair JSON");
          }),
        ),
      ),
    );

    const parsed = events(await response.text());
    expect(parsed.map((event) => event.type)).toEqual(["start", "repair", "repair", "error"]);
    expect(parsed.at(-1)).toMatchObject({ type: "error", error: { code: "INVALID_AI_OUTPUT" } });
  });

  test("drops repair progress that arrives after the client aborts", async () => {
    const { db, input } = setup();
    const repairInput = repairOf(input, {
      typst: "#strong[open",
      diagnostics: "error: unclosed delimiter",
    });
    const controller = new AbortController();
    const aborted = Promise.withResolvers<never>();
    const response = await handleTranslate(
      request(repairInput, controller.signal),
      context(
        db,
        manager(
          ai(async (_input, signal, _onText, onRepair) => {
            signal.addEventListener(
              "abort",
              () => {
                onRepair?.({ phase: "requesting", replyAttempt: 2 });
                aborted.reject(signal.reason);
              },
              { once: true },
            );
            return aborted.promise;
          }),
        ),
      ),
    );
    controller.abort(new DOMException("cancelled", "AbortError"));

    expect(events(await response.text()).map((event) => event.type)).toEqual(["start"]);
  });

  test("generates an EPUB page or selection only for the CFI its unit names", async () => {
    const { db } = setup();
    const book = storeDocument(
      db,
      { name: "book.epub", pageCount: 2, format: "epub" },
      new TextEncoder().encode("PK\u0003\u0004translate fixture"),
    );
    const sourceCfi = "epubcfi(/6/4!/4/2,/1:0,/1:9)";
    const page = await epubTranslationUnit("page", sourceCfi);
    const selection = await epubTranslationUnit("selection", sourceCfi);
    for (const unit of [page, selection]) {
      const response = await handleTranslate(
        request({
          documentId: book.id,
          pageNumber: 1,
          targetLanguage: "en",
          format: "epub",
          unit,
          sourceCfi,
          xhtml: "<p>Hello</p>",
          images: [],
          force: false,
        }),
        context(db, manager(ai(async () => content("= ok")))),
      );
      expect(events(await response.text()).at(-1)).toMatchObject({ type: "generated" });
    }
  });

  test("refuses an EPUB unit that belongs to another range, for generation and repair", async () => {
    const { db } = setup();
    const book = storeDocument(
      db,
      { name: "book.epub", pageCount: 2, format: "epub" },
      new TextEncoder().encode("PK\u0003\u0004translate fixture"),
    );
    const sourceCfi = "epubcfi(/6/4!/4/2,/1:0,/1:9)";
    const unit = await epubTranslationUnit("page", "epubcfi(/6/4!/4/2,/1:10,/1:19)");
    let called = false;
    const runtime = manager(ai(async () => {
      called = true;
      return content("= ignored");
    }));
    const generation: TranslatePageInput = {
      documentId: book.id,
      pageNumber: 1,
      targetLanguage: "en",
      format: "epub",
      unit,
      sourceCfi,
      xhtml: "<p>Hello</p>",
      images: [],
      force: false,
    };
    const repair: TranslatePageInput = {
      documentId: book.id,
      pageNumber: 1,
      targetLanguage: "en",
      format: "epub",
      unit,
      sourceCfi,
      force: false,
      repair: { typst: "#strong[open", diagnostics: "unclosed delimiter" },
    };
    await expect(handleTranslate(request(generation), context(db, runtime))).rejects.toMatchObject({
      status: 400,
      code: "INVALID_REQUEST",
    });
    await expect(handleTranslate(request(repair), context(db, runtime))).rejects.toMatchObject({
      status: 400,
      code: "INVALID_REQUEST",
    });
    expect(called).toBe(false);
  });
});
