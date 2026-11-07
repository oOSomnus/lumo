import { describe, expect, test } from "bun:test";
import {
  ApiError,
  isTerminalLoginEvent,
  readNdjson,
  requestTranslation,
  saveTranslationRecord,
} from "./api";
import {
  aiLoginEventSchema,
  translateStreamEventSchema,
  type AiLoginEvent,
  type TranslatePageInput,
  type TranslateStreamEvent,
  type TranslationRecord,
  type TypstRepairProgress,
} from "../shared/contracts";

function streamResponse(chunks: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  );
}

function collect(response: Response): Promise<TranslateStreamEvent[]> {
  const events: TranslateStreamEvent[] = [];
  return readNdjson(response, translateStreamEventSchema, (event) =>
    events.push(event),
  ).then(() => events);
}

/** Runs `run` with a fake window (it supplies the access token) and a fake fetch, then restores both. */
async function withFakeFetch<T>(
  fakeFetch: (path: string, init: RequestInit) => Promise<Response>,
  run: () => Promise<T>,
): Promise<T> {
  const globals = globalThis as unknown as { window?: unknown; fetch: unknown };
  const previous = { window: globals.window, fetch: globals.fetch };
  globals.window = { location: { search: "?token=test" } };
  globals.fetch = fakeFetch;
  try {
    return await run();
  } finally {
    Object.assign(globals, previous);
  }
}

describe("readNdjson", () => {
  test("handles lines split across chunks, including split UTF-8 sequences", async () => {
    const encoder = new TextEncoder();
    const first = JSON.stringify({
      type: "delta",
      contentIndex: 0,
      text: "日本語",
    });
    const second = JSON.stringify({ type: "start" });
    const bytes = encoder.encode(`${first}\n\n${second}\n${JSON.stringify({ type: "delta", contentIndex: 1, text: "tail" })}`);
    const split = bytes.findIndex((byte) => byte >= 0xe0) + 1;

    const events = await collect(streamResponse([bytes.slice(0, split), bytes.slice(split, split + 5), bytes.slice(split + 5)]));
    expect(events).toEqual([
      { type: "delta", contentIndex: 0, text: "日本語" },
      { type: "start" },
      { type: "delta", contentIndex: 1, text: "tail" },
    ]);
  });

  test("does not treat a login stream that ends early as connected", async () => {
    const events: AiLoginEvent[] = [];
    await readNdjson(
      streamResponse([
        new TextEncoder().encode(
          `${JSON.stringify({ type: "session", sessionId: "s" })}\n${JSON.stringify({
            type: "notification",
            event: { type: "info", message: "Starting" },
          })}\n`,
        ),
      ]),
      aiLoginEventSchema,
      (event) => events.push(event),
    );
    expect(events.some(isTerminalLoginEvent)).toBe(false);
  });

  test("rejects malformed JSON and unknown events", async () => {
    await expect(collect(streamResponse([new TextEncoder().encode("{not json}\n")]))).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      status: 502,
    });
    await expect(
      collect(streamResponse([new TextEncoder().encode('{"type":"other"}\n')])),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("requestTranslation", () => {
  const encoder = new TextEncoder();
  const page: TranslatePageInput = {
    documentId: "a".repeat(64),
    pageNumber: 1,
    targetLanguage: "zh-CN",
    format: "pdf",
    text: "",
    imageBase64: "/9j/AAAA",
    force: false,
  };
  const requesting = { type: "repair", progress: { phase: "requesting", replyAttempt: 1 } };

  function ndjson(lines: unknown[]): Uint8Array {
    return encoder.encode(lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  }

  async function translateFrom(
    chunks: Uint8Array[],
    onRepair: (progress: TypstRepairProgress) => void,
  ) {
    return withFakeFetch(
      async () => streamResponse(chunks),
      () => requestTranslation(page, { onRepair }),
    );
  }

  test("reports repair progress in order across a split UTF-8 sequence, before the result", async () => {
    const bytes = ndjson([
      { type: "start" },
      requesting,
      {
        type: "repair",
        progress: {
          phase: "rejected",
          replyAttempt: 1,
          error: { code: "INVALID_AI_OUTPUT", message: "修复 JSON 无效" },
        },
      },
      {
        type: "repair",
        progress: { phase: "applied", replyAttempt: 2, change: { mode: "edits", count: 1 } },
      },
      { type: "generated", content: { typst: "= 标题", provider: "custom", model: "repair-smoke" } },
    ]);
    const split = bytes.findIndex((byte) => byte >= 0xe0) + 1;
    const progress: TypstRepairProgress[] = [];

    const result = await translateFrom([bytes.slice(0, split), bytes.slice(split)], (event) =>
      progress.push(event),
    );

    expect(progress).toEqual([
      { phase: "requesting", replyAttempt: 1 },
      {
        phase: "rejected",
        replyAttempt: 1,
        error: { code: "INVALID_AI_OUTPUT", message: "修复 JSON 无效" },
      },
      { phase: "applied", replyAttempt: 2, change: { mode: "edits", count: 1 } },
    ]);
    expect(result).toEqual({
      cacheHit: false,
      content: { typst: "= 标题", provider: "custom", model: "repair-smoke" },
    });
  });

  test("treats a stream that ends after repair progress as interrupted, not as a success", async () => {
    await expect(translateFrom([ndjson([requesting])], () => {})).rejects.toMatchObject({
      code: "STREAM_INTERRUPTED",
    });
  });

  test("fails with the server's error code after repair progress", async () => {
    await expect(
      translateFrom(
        [
          ndjson([
            requesting,
            {
              type: "error",
              error: { code: "INVALID_AI_OUTPUT", message: "model returned invalid Typst repair JSON" },
            },
          ]),
        ],
        () => {},
      ),
    ).rejects.toMatchObject({ code: "INVALID_AI_OUTPUT" });
  });

  test("rejects an out-of-range reply number as an invalid response", async () => {
    await expect(
      translateFrom(
        [ndjson([{ type: "repair", progress: { phase: "requesting", replyAttempt: 3 } }])],
        () => {},
      ),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE", status: 502 });
  });

  test("answers a cached event with the saved translation and ignores whatever follows it", async () => {
    const saved: TranslationRecord = {
      documentId: "a".repeat(64),
      pageNumber: 1,
      targetLanguage: "zh-CN",
      typst: "= 已保存",
      provider: "custom",
      model: "saved",
      translatedAt: 1,
    };
    const result = await translateFrom(
      [
        ndjson([
          { type: "start" },
          { type: "cached", translation: saved },
          { type: "delta", contentIndex: 0, text: "late" },
          { type: "error", error: { code: "AI_REQUEST_FAILED", message: "late failure" } },
        ]),
      ],
      () => {},
    );

    expect(result).toEqual({ cacheHit: true, translation: saved });
  });

  test("an abort in the middle of the stream rejects as an abort, with no later delta and no partial result", async () => {
    const controller = new AbortController();
    const deltas: string[] = [];
    const seen = Promise.withResolvers<void>();
    const running = withFakeFetch(
      async (_path, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              stream.enqueue(ndjson([{ type: "start" }, { type: "delta", contentIndex: 0, text: "= par" }]));
              // Like fetch: the body fails with the signal's reason once the request is aborted.
              init.signal!.addEventListener("abort", () => stream.error(init.signal!.reason));
            },
          }),
        ),
      () =>
        requestTranslation(page, {
          signal: controller.signal,
          onDelta: ({ text }) => {
            deltas.push(text);
            seen.resolve();
          },
        }),
    );
    await seen.promise;
    controller.abort();

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(deltas).toEqual(["= par"]);
  });
});

describe("saveTranslationRecord", () => {
  const content = { typst: "= 标题", provider: "custom", model: "save-smoke" };

  async function savedBody(sourceCfi?: string): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> = {};
    await withFakeFetch(
      async (_path, init) => {
        body = JSON.parse(String(init.body));
        return Response.json({});
      },
      () => saveTranslationRecord("a".repeat(64), 1, "en", content, undefined, "page-x", sourceCfi),
    );
    return body;
  }

  test("sends the EPUB source CFI with the saved content", async () => {
    expect(await savedBody("epubcfi(/6/4!/4/2)")).toEqual({
      ...content,
      sourceCfi: "epubcfi(/6/4!/4/2)",
    });
  });

  test("sends no source CFI when the save has none", async () => {
    expect(await savedBody()).toEqual(content);
  });
});
