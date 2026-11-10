import { afterEach, describe, expect, test } from "bun:test";
import type { EpubLayoutSnapshot } from "../shared/epub";
import type { EpubPageLocation, EpubPreparedUnit, EpubReadyInfo } from "./epub-bridge";
import { EpubBridgeClient } from "./epub-bridge-client";
import type { ParentMessage, ViewerMessage } from "./epub-protocol";

const ORIGIN = "http://127.0.0.1:4000";
const CFI = "epubcfi(/6/4!/4/2,/1:0,/1:9)";
const layout: EpubLayoutSnapshot = {
  width: 600,
  height: 800,
  style: { fontSize: 18, fontFamily: "serif", lineHeight: 1.6, theme: "light" },
};
const info: EpubReadyInfo = { sectionCount: 3, toc: [], fixedLayout: false };
const prepared: EpubPreparedUnit = { xhtml: "<p>x</p>", images: [] };

function pageAt(page: number): EpubPageLocation {
  return {
    sectionIndex: 0,
    startCfi: `epubcfi(/6/2!/4/${page})`,
    sourceCfi: `epubcfi(/6/2!/4,/${page}/1:0,/${page}/1:9)`,
    unit: `page-${String(page).padStart(64, "0")}`,
    page,
    total: 3,
  };
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

/** A client wired to a fake iframe whose script is played by the test. */
function setup() {
  const listeners = new Set<(event: MessageEvent<unknown>) => void>();
  const sent: ParentMessage[] = [];
  const events: string[] = [];
  const contentWindow = { postMessage: (message: ParentMessage) => void sent.push(message) };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { origin: ORIGIN },
      addEventListener: (_type: string, listener: (event: MessageEvent<unknown>) => void) =>
        listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: MessageEvent<unknown>) => void) =>
        listeners.delete(listener),
    },
  });
  const frame = { contentWindow, clientWidth: 600, clientHeight: 800 } as unknown as HTMLIFrameElement;
  const client = new EpubBridgeClient(frame, {
    onViewerReady: () => events.push("viewer-ready"),
    onReady: () => events.push("ready"),
    onRelocated: () => events.push("relocated"),
    onSelection: () => events.push("selection"),
    onShortcut: (shortcut) => events.push(`shortcut:${shortcut.type === "step" ? shortcut.direction : shortcut.type}`),
    onFatal: ({ code }) => events.push(`fatal:${code}`),
  });
  const deliver = (message: ViewerMessage, source: unknown = contentWindow): void => {
    for (const listener of [...listeners]) {
      listener({ source, origin: ORIGIN, data: message } as unknown as MessageEvent<unknown>);
    }
  };
  const requests = (op: string) =>
    sent.filter(
      (message): message is Extract<ParentMessage, { type: "request" }> =>
        message.type === "request" && message.request.op === op,
    );
  /** Opens generation `generation` and lets the viewer report it ready. */
  const openBook = (generation = 1): void => {
    client.open(new ArrayBuffer(8));
    deliver({ type: "ready", generation, info });
  };
  return { client, sent, events, deliver, requests, openBook };
}

describe("EpubBridgeClient requests", () => {
  test("fail with EPUB_NOT_READY until the book reports ready", async () => {
    const { client } = setup();
    await expect(client.display(1)).rejects.toMatchObject({ code: "EPUB_NOT_READY" });
    await expect(client.prepare(CFI, null, new AbortController().signal)).rejects.toMatchObject({
      code: "EPUB_NOT_READY",
    });
  });

  test("a relocation reaches the reader before the move that caused it resolves", async () => {
    const { client, events, deliver, requests, openBook } = setup();
    openBook();
    const moved = client.display(2).then(() => events.push("resolved"));
    const [request] = requests("display");
    deliver({ type: "relocated", generation: 1, relocation: { ...pageAt(1), atStart: false, atEnd: false } });
    deliver({ type: "reply", generation: 1, id: request!.id, result: undefined });
    await moved;
    expect(events.slice(-2)).toEqual(["relocated", "resolved"]);
  });

  test("opening another book fails what is in flight and ignores the old book's replies", async () => {
    const { client, deliver, requests, openBook } = setup();
    openBook();
    const stale = client.next();
    const [request] = requests("next");
    client.open(new ArrayBuffer(8));
    await expect(stale).rejects.toMatchObject({ code: "DOCUMENT_CHANGED" });

    deliver({ type: "ready", generation: 2, info });
    const current = client.prev();
    deliver({ type: "reply", generation: 1, id: request!.id, result: undefined });
    deliver({ type: "reply", generation: 2, id: requests("prev")[0]!.id, result: undefined });
    await expect(current).resolves.toBeUndefined();
  });

  test("a key press in the book reaches the reader only for the current book once it is ready", () => {
    const { client, events, deliver, openBook } = setup();
    client.open(new ArrayBuffer(8));
    deliver({ type: "shortcut", generation: 1, shortcut: { type: "step", direction: "next" } });
    expect(events).toEqual([]);

    deliver({ type: "ready", generation: 1, info });
    deliver({ type: "shortcut", generation: 1, shortcut: { type: "step", direction: "next" } });
    deliver({ type: "shortcut", generation: 1, shortcut: { type: "step", direction: "prev" } });
    deliver({ type: "shortcut", generation: 0, shortcut: { type: "step", direction: "next" } });
    deliver({ type: "shortcut", generation: 2, shortcut: { type: "step", direction: "prev" } });
    expect(events).toEqual(["ready", "shortcut:next", "shortcut:prev"]);

    openBook(2);
    deliver({ type: "shortcut", generation: 1, shortcut: { type: "step", direction: "prev" } });
    expect(events.at(-1)).toBe("ready");
  });

  test("invalidating ends the old book's events at once, before the next book is opened", async () => {
    const { client, sent, events, deliver, requests, openBook } = setup();
    openBook();
    const pending = client.display(2);
    const [request] = requests("display");

    client.invalidate();
    await expect(pending).rejects.toMatchObject({ code: "DOCUMENT_CHANGED" });
    const before = events.length;
    deliver({ type: "relocated", generation: 1, relocation: { ...pageAt(1), atStart: true, atEnd: false } });
    deliver({ type: "selection", generation: 1, selection: null });
    deliver({ type: "shortcut", generation: 1, shortcut: { type: "step", direction: "next" } });
    deliver({ type: "ready", generation: 1, info });
    deliver({ type: "failure", generation: 1, id: null, code: "EPUB_OPEN_FAILED", message: "bad zip" });
    deliver({ type: "reply", generation: 1, id: request!.id, result: undefined });
    expect(events.slice(before)).toEqual([]);
    await expect(client.next()).rejects.toMatchObject({ code: "EPUB_NOT_READY" });

    client.open(new ArrayBuffer(8));
    const opened = sent.filter((message) => message.type === "open").at(-1)!;
    deliver({ type: "ready", generation: (opened as { generation: number }).generation, info });
    expect(events.slice(before)).toEqual(["ready"]);
  });

  test("ignores messages that do not come from its own iframe", () => {
    const { events, deliver } = setup();
    deliver({ type: "viewer-ready" }, {});
    expect(events).toEqual([]);
    deliver({ type: "viewer-ready" });
    expect(events).toEqual(["viewer-ready"]);
  });

  test("a failure of the book itself is reported as fatal, one of a request rejects that request", async () => {
    const { client, events, deliver, requests, openBook } = setup();
    openBook();
    const failing = client.display("epubcfi(/6/4!/4/2)");
    deliver({
      type: "failure",
      generation: 1,
      id: requests("display")[0]!.id,
      code: "EPUB_NAVIGATION_FAILED",
      message: "no such range",
    });
    await expect(failing).rejects.toMatchObject({ code: "EPUB_NAVIGATION_FAILED", message: "no such range" });
    expect(events).not.toContain("fatal:EPUB_NAVIGATION_FAILED");

    deliver({ type: "failure", generation: 1, id: null, code: "EPUB_OPEN_FAILED", message: "bad zip" });
    expect(events.at(-1)).toBe("fatal:EPUB_OPEN_FAILED");
  });
});

describe("EpubBridgeClient shared work", () => {
  test("identical prepares share one request and survive one caller leaving", async () => {
    const { client, sent, deliver, requests, openBook } = setup();
    openBook();
    const leaving = new AbortController();
    const first = client.prepare(CFI, layout, leaving.signal);
    const second = client.prepare(CFI, layout, new AbortController().signal);
    expect(requests("prepare")).toHaveLength(1);

    leaving.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(sent.some((message) => message.type === "cancel")).toBe(false);

    deliver({ type: "reply", generation: 1, id: requests("prepare")[0]!.id, result: prepared });
    await expect(second).resolves.toEqual(prepared);
  });

  test("the request is cancelled once its last caller leaves, and a later call starts a new one", async () => {
    const { client, sent, requests, openBook } = setup();
    openBook();
    const a = new AbortController();
    const b = new AbortController();
    const first = client.prepare(CFI, layout, a.signal);
    const second = client.prepare(CFI, layout, b.signal);
    a.abort();
    b.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(sent.filter((message) => message.type === "cancel")).toHaveLength(1);

    const third = client.prepare(CFI, layout, new AbortController().signal);
    expect(requests("prepare")).toHaveLength(2);
    void third.catch(() => undefined);
  });

  test("different layouts of one range are different requests", () => {
    const { client, requests, openBook } = setup();
    openBook();
    const signal = new AbortController().signal;
    void client.prepare(CFI, layout, signal).catch(() => undefined);
    void client.prepare(CFI, { ...layout, style: { ...layout.style, fontSize: 24 } }, signal).catch(() => undefined);
    void client.prepare(CFI, null, signal).catch(() => undefined);
    expect(requests("prepare")).toHaveLength(3);
  });
});

describe("EpubBridgeClient pages", () => {
  test("hands over one page at a time, acknowledges it and cancels when the consumer stops", async () => {
    const { client, sent, deliver, requests, openBook } = setup();
    openBook();
    const pages = client.pages([0], layout, new AbortController().signal);
    const first = pages.next();
    const id = requests("pages")[0]!.id;
    deliver({ type: "page", generation: 1, id, page: pageAt(1) });
    expect((await first).value).toEqual(pageAt(1));
    expect(sent.filter((message) => message.type === "ack")).toHaveLength(1);

    await pages.return(undefined);
    expect(sent.at(-1)).toMatchObject({ type: "cancel", id });
  });

  test("ends after done without cancelling, and rejects with the viewer's failure", async () => {
    const { client, sent, deliver, requests, openBook } = setup();
    openBook();
    const finished = client.pages([0], layout, new AbortController().signal);
    const drained = (async () => {
      const seen: number[] = [];
      for await (const page of finished) seen.push(page.page);
      return seen;
    })();
    const id = requests("pages")[0]!.id;
    deliver({ type: "page", generation: 1, id, page: pageAt(1) });
    deliver({ type: "page", generation: 1, id, page: pageAt(2) });
    deliver({ type: "done", generation: 1, id });
    expect(await drained).toEqual([1, 2]);
    expect(sent.some((message) => message.type === "cancel")).toBe(false);

    const broken = client.pages([1], layout, new AbortController().signal);
    const failed = broken.next();
    deliver({
      type: "failure",
      generation: 1,
      id: requests("pages")[1]!.id,
      code: "EPUB_PAGE_UNAVAILABLE",
      message: "gone",
    });
    await expect(failed).rejects.toMatchObject({ code: "EPUB_PAGE_UNAVAILABLE" });
  });

  test("aborting the signal stops the wait and cancels the viewer's work", async () => {
    const { client, sent, requests, openBook } = setup();
    openBook();
    const controller = new AbortController();
    const pending = client.pages([0], layout, controller.signal).next();
    const id = requests("pages")[0]!.id;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(sent.at(-1)).toMatchObject({ type: "cancel", id });
  });
});
