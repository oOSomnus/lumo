import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  OutlineHeading,
  OutlinePageInput,
  TranslationContent,
} from "../shared/contracts";
import type { AiRuntime } from "./ai";
import type { AiManager } from "./ai-settings";
import { handleOutlinePage } from "./outline";
import {
  listTranslations,
  openReaderDb,
  storeDocument,
} from "./storage";

const directories: string[] = [];
const databases: Database[] = [];

function setup(): {
  db: Database;
  documentId: string;
  input: OutlinePageInput;
} {
  const directory = mkdtempSync(join(tmpdir(), "lumo-outline-"));
  directories.push(directory);
  const db = openReaderDb(directory);
  databases.push(db);
  const document = storeDocument(
    db,
    { name: "outline.pdf", pageCount: 3 },
    new TextEncoder().encode("%PDF-1.7 outline fixture"),
  );
  return {
    db,
    documentId: document.id,
    input: {
      documentId: document.id,
      pageNumber: 2,
      text: "Chapter 1",
      imageBase64: "/9j/AAAA",
      previousHeadings: [],
    },
  };
}

function runtime(
  extract: AiRuntime["extractOutlinePage"],
  configured: Awaited<ReturnType<AiRuntime["checkConfigured"]>> = { ok: true },
): AiRuntime {
  return {
    checkConfigured: async () => configured,
    translatePage: async (): Promise<TranslationContent> => {
      throw new Error("unexpected translation request");
    },
    extractOutlinePage: extract,
  };
}

function manager(value: AiRuntime): Pick<AiManager, "getRuntime"> {
  return { getRuntime: async () => value };
}

function request(input: OutlinePageInput, signal?: AbortSignal): Request {
  return new Request("http://127.0.0.1:1234/api/outline-page", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("handleOutlinePage", () => {
  test("returns headings without writing translations", async () => {
    const { db, documentId, input } = setup();
    let received: OutlinePageInput | undefined;
    const response = await handleOutlinePage(
      request(input),
      {
        db,
        ai: manager(
          runtime(async (value) => {
            received = value;
            return [{ title: "Chapter 1", level: 1 }];
          }),
        ),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      headings: [{ title: "Chapter 1", level: 1 }],
    });
    expect(received).toEqual(input);
    expect(listTranslations(db, documentId, "en")).toEqual([]);
    expect(listTranslations(db, documentId, "zh-CN")).toEqual([]);
  });

  test("rejects unknown documents, out-of-range pages and invalid context", async () => {
    const { db, input } = setup();
    const ai = manager(runtime(async () => []));

    await expect(
      handleOutlinePage(request({ ...input, documentId: "a".repeat(64) }), {
        db,
        ai,
      }),
    ).rejects.toMatchObject({ status: 404, code: "DOCUMENT_NOT_FOUND" });
    await expect(
      handleOutlinePage(request({ ...input, pageNumber: 4 }), { db, ai }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });
    await expect(
      handleOutlinePage(
        request({
          ...input,
          previousHeadings: [
            { title: "Later", level: 1, pageNumber: 3 },
          ],
        }),
        { db, ai },
      ),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });
  });

  test("returns 503 before calling the model when AI is not configured", async () => {
    const { db, input } = setup();
    let called = false;
    const response = handleOutlinePage(request(input), {
      db,
      ai: manager(
        runtime(
          async () => {
            called = true;
            return [];
          },
          { ok: false, code: "AI_NOT_CONFIGURED", message: "missing" },
        ),
      ),
    });
    await expect(response).rejects.toMatchObject({
      status: 503,
      code: "AI_NOT_CONFIGURED",
    });
    expect(called).toBe(false);
  });

  test("rejects non-POST methods", async () => {
    const { db } = setup();
    const get = new Request("http://127.0.0.1:1234/api/outline-page");
    await expect(
      handleOutlinePage(get, { db, ai: manager(runtime(async () => [])) }),
    ).rejects.toMatchObject({ status: 405, code: "METHOD_NOT_ALLOWED" });
  });

  test("aborts the model when the request is aborted", async () => {
    const { db, input } = setup();
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    let aborted = false;
    const pending = handleOutlinePage(request(input, controller.signal), {
      db,
      ai: manager(
        runtime(
          (_value, signal) => {
            entered.resolve();
            if (signal.aborted) {
              aborted = true;
              return Promise.reject(signal.reason);
            }
            return new Promise((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  reject(signal.reason);
                },
                { once: true },
              );
            });
          },
        ),
      ),
    });
    await entered.promise;
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(pending).rejects.toMatchObject({ status: 499, code: "ABORTED" });
    expect(aborted).toBe(true);
  });

  test("rejects a late success after the request was aborted", async () => {
    const { db, input } = setup();
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const headings = Promise.withResolvers<OutlineHeading[]>();
    const pending = handleOutlinePage(request(input, controller.signal), {
      db,
      ai: manager(
        runtime((_value) => {
          entered.resolve();
          return headings.promise;
        }),
      ),
    });
    await entered.promise;
    controller.abort(new DOMException("cancelled", "AbortError"));
    headings.resolve([{ title: "Late", level: 1 }]);

    await expect(pending).rejects.toMatchObject({ status: 499, code: "ABORTED" });
  });

  test("times out with AI_TIMEOUT using a controllable timeout", async () => {
    const { db, input } = setup();
    let aborted = false;
    const pending = handleOutlinePage(
      request(input),
      {
        db,
        ai: manager(
          runtime(
            (_value, signal) =>
              new Promise((_resolve, reject) => {
                signal.addEventListener(
                  "abort",
                  () => {
                    aborted = true;
                    reject(signal.reason);
                  },
                  { once: true },
                );
              }),
          ),
        ),
      },
      5,
    );

    await expect(pending).rejects.toMatchObject({
      status: 504,
      code: "AI_TIMEOUT",
    });
    expect(aborted).toBe(true);
  });

  test("rejects a late success after the deadline", async () => {
    const { db, input } = setup();
    let lateResolved = false;
    const pending = handleOutlinePage(
      request(input),
      {
        db,
        ai: manager(
          runtime((_value, signal) => {
            const { promise, resolve } =
              Promise.withResolvers<OutlineHeading[]>();
            const finish = () => {
              lateResolved = true;
              resolve([{ title: "Late", level: 1 }]);
            };
            if (signal.aborted) finish();
            else signal.addEventListener("abort", finish, { once: true });
            return promise;
          }),
        ),
      },
      5,
    );

    await expect(pending).rejects.toMatchObject({
      status: 504,
      code: "AI_TIMEOUT",
    });
    expect(lateResolved).toBe(true);
  });
});
