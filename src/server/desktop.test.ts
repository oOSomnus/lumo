import { describe, expect, test } from "bun:test";
import {
  DESKTOP_MAX_COMMAND_BYTES,
  DESKTOP_SHUTDOWN_COMMAND,
} from "../shared/desktop";
import { watchDesktopControl } from "./desktop";

const encoder = new TextEncoder();

function input(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function outcome(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const calls: string[] = [];
  await watchDesktopControl(stream, {
    onShutdown: () => calls.push("shutdown"),
    onInvalid: () => calls.push("invalid"),
  });
  return calls;
}

describe("watchDesktopControl", () => {
  test("accepts the shutdown command even when it arrives in pieces", async () => {
    const half = Math.floor(DESKTOP_SHUTDOWN_COMMAND.length / 2);
    expect(
      await outcome(
        input(DESKTOP_SHUTDOWN_COMMAND.slice(0, half), `${DESKTOP_SHUTDOWN_COMMAND.slice(half)}\n`),
      ),
    ).toEqual(["shutdown"]);
  });

  test("treats the end of input as the launcher having gone away", async () => {
    expect(await outcome(input())).toEqual(["shutdown"]);
  });

  test("a command is acted on once; later input is not read", async () => {
    expect(await outcome(input(`${DESKTOP_SHUTDOWN_COMMAND}\nnot json\n`))).toEqual(["shutdown"]);
  });

  test.each([
    ["unknown command", '{"type":"restart"}\n'],
    ["extra fields", '{"type":"shutdown","force":true}\n'],
    ["malformed JSON", "shutdown\n"],
    ["a line over the size limit", `${"x".repeat(DESKTOP_MAX_COMMAND_BYTES + 1)}\n`],
    ["an unterminated line over the size limit", "x".repeat(DESKTOP_MAX_COMMAND_BYTES + 1)],
  ])("rejects %s without shutting down", async (_label, text) => {
    expect(await outcome(input(text))).toEqual(["invalid"]);
  });
});
