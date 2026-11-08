import { z } from "zod";
import {
  DESKTOP_MAX_COMMAND_BYTES,
  type DesktopEvent,
} from "../shared/desktop";

const commandSchema = z.strictObject({ type: z.literal("shutdown") });

export function emitDesktopEvent(event: DesktopEvent): void {
  console.log(JSON.stringify(event));
}

function isShutdownCommand(line: Uint8Array): boolean {
  if (line.length > DESKTOP_MAX_COMMAND_BYTES) return false;
  try {
    return commandSchema.safeParse(JSON.parse(new TextDecoder().decode(line))).success;
  } catch {
    return false;
  }
}

/**
 * Reads launcher commands until the first valid shutdown command, a protocol violation,
 * or the end of input; the end of input means the launcher is gone and also stops the server.
 */
export async function watchDesktopControl(
  input: ReadableStream<Uint8Array>,
  handlers: { onShutdown: () => void; onInvalid: () => void },
): Promise<void> {
  let pending = Buffer.alloc(0);
  const reader = input.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending = Buffer.concat([pending, value]);
      for (let end = pending.indexOf(0x0a); end !== -1; end = pending.indexOf(0x0a)) {
        const line = pending.subarray(0, end);
        pending = pending.subarray(end + 1);
        if (line.length === 0) continue;
        if (isShutdownCommand(line)) return handlers.onShutdown();
        return handlers.onInvalid();
      }
      if (pending.length > DESKTOP_MAX_COMMAND_BYTES) return handlers.onInvalid();
    }
  } catch {
    // A broken input pipe means the launcher is gone, same as the end of input.
  }
  handlers.onShutdown();
}
