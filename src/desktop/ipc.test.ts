import { describe, expect, test } from "bun:test";
import type { LauncherSnapshot } from "../shared/desktop";
import { newerSnapshot, panelLocale } from "./ipc";

function snapshot(overrides: Partial<LauncherSnapshot>): LauncherSnapshot {
  return {
    revision: 0,
    version: "1.0.0",
    phase: "starting",
    webUiUrl: null,
    dataDirectory: null,
    uiLocale: null,
    failureCode: null,
    canRetry: false,
    update: { phase: "disabled", version: null, installMode: "in-app", errorCode: null },
    logs: [],
    ...overrides,
  };
}

describe("newerSnapshot", () => {
  test("a snapshot fetched late does not overwrite a newer event", () => {
    const running = snapshot({ revision: 7, phase: "running" });
    const fetched = snapshot({ revision: 3, phase: "starting" });
    expect(newerSnapshot(running, fetched)).toBe(running);
  });

  test("accepts the first snapshot, equal and newer revisions", () => {
    const first = snapshot({ revision: 1 });
    expect(newerSnapshot(null, first)).toBe(first);
    const same = snapshot({ revision: 1, phase: "failed" });
    expect(newerSnapshot(first, same)).toBe(same);
    const next = snapshot({ revision: 2 });
    expect(newerSnapshot(same, next)).toBe(next);
  });
});

describe("panelLocale", () => {
  test("prefers the library's locale once the server reported it", () => {
    expect(panelLocale(snapshot({ uiLocale: "en" }), "zh-CN")).toBe("en");
    expect(panelLocale(snapshot({ uiLocale: "zh-CN" }), "en-US")).toBe("zh-CN");
  });

  test("falls back to the system language before ready or after a database failure", () => {
    expect(panelLocale(null, "zh-TW")).toBe("zh-CN");
    expect(panelLocale(snapshot({}), "ZH")).toBe("zh-CN");
    expect(panelLocale(snapshot({}), "de-DE")).toBe("en");
  });
});
