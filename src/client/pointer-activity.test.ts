import { describe, expect, test } from "bun:test";
import { watchPointerActivity } from "./pointer-activity";

function fakeDocument() {
  const listeners = new Set<(event: PointerEvent) => void>();
  const doc = {
    addEventListener: (type: string, listener: (event: PointerEvent) => void) => {
      if (type === "pointermove") listeners.add(listener);
    },
    removeEventListener: (type: string, listener: (event: PointerEvent) => void) => {
      if (type === "pointermove") listeners.delete(listener);
    },
  };
  const move = (timeStamp: number): void => {
    for (const listener of [...listeners]) listener({ timeStamp } as PointerEvent);
  };
  return { doc: doc as unknown as Document, listeners, move };
}

describe("watchPointerActivity", () => {
  test("reports the first move, then at most once per interval", () => {
    const { doc, move } = fakeDocument();
    let calls = 0;
    watchPointerActivity(doc, () => void (calls += 1), 200);
    move(1000);
    expect(calls).toBe(1);
    move(1100);
    move(1199);
    expect(calls).toBe(1);
    move(1200);
    expect(calls).toBe(2);
    move(1450);
    expect(calls).toBe(3);
  });

  test("stopping removes the listener", () => {
    const { doc, listeners, move } = fakeDocument();
    let calls = 0;
    const stop = watchPointerActivity(doc, () => void (calls += 1));
    expect(listeners.size).toBe(1);
    stop();
    expect(listeners.size).toBe(0);
    move(5000);
    expect(calls).toBe(0);
  });
});
