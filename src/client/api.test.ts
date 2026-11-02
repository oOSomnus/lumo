import { describe, expect, test } from "bun:test";
import { ApiError, isTerminalLoginEvent, readNdjson } from "./api";
import {
  aiLoginEventSchema,
  translateStreamEventSchema,
  type AiLoginEvent,
  type TranslateStreamEvent,
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
