import { describe, expect, test, vi } from "bun:test";
import {
  DEFAULT_EPUB_READER_VIEW,
  DEFAULT_PDF_READER_VIEW,
  type ReaderView,
} from "../shared/contracts";
import {
  ReaderViewStore,
  sameReaderView,
  type ReaderViewTransport,
} from "./reader-view";

class FakeTransport implements ReaderViewTransport {
  readonly loads: string[] = [];
  readonly saves: Array<{ id: string; view: ReaderView }> = [];
  readonly keepalives: Array<{ id: string; view: ReaderView }> = [];
  loadResult: (id: string) => Promise<ReaderView | null> = async () => null;
  saveResult: (id: string, view: ReaderView) => Promise<ReaderView> = async (
    _id,
    view,
  ) => view;
  keepaliveResult: (id: string, view: ReaderView) => Promise<unknown> = async () =>
    undefined;

  load(id: string): Promise<ReaderView | null> {
    this.loads.push(id);
    return this.loadResult(id);
  }

  save(id: string, view: ReaderView): Promise<ReaderView> {
    this.saves.push({ id, view });
    return this.saveResult(id, view);
  }

  keepalive(id: string, view: ReaderView): Promise<unknown> {
    this.keepalives.push({ id, view });
    return this.keepaliveResult(id, view);
  }
}

const pdf = (scaleValue: string): ReaderView => ({
  ...DEFAULT_PDF_READER_VIEW,
  scaleValue,
});

const pdfWithMemory = (): ReaderView => ({
  ...DEFAULT_PDF_READER_VIEW,
  scaleValue: "1.5",
  scrollMemory: {
    pdf: [{ page: 1, left: 2, top: 3 }],
    translation: [{ key: "p1", offset: 0.25 }],
  },
});

function setup(): {
  transport: FakeTransport;
  failures: boolean[];
  store: ReaderViewStore;
} {
  const transport = new FakeTransport();
  const failures: boolean[] = [];
  const store = new ReaderViewStore(transport, (failed) =>
    failures.push(failed),
  );
  return { transport, failures, store };
}

describe("saving views", () => {
  test("a newer view survives an older held write", async () => {
    const { transport, failures, store } = setup();
    const held = Promise.withResolvers<ReaderView>();
    transport.saveResult = (_id, view) =>
      transport.saves.length === 1 ? held.promise : Promise.resolve(view);

    store.capture("book", pdf("1.5"));
    const first = store.flush();
    store.scrolled("book", pdfWithMemory());
    held.resolve(pdf("1.5"));

    expect(await first).toBe(true);
    expect(transport.saves.map((entry) => entry.view)).toEqual([
      pdf("1.5"),
      pdfWithMemory(),
    ]);
    const read = await store.load("book", () => true);
    expect(read.fetched).toBe(false);
    expect(read.view).toEqual(pdfWithMemory());
    expect(failures.at(-1)).toBe(false);
    store.dispose();
  });

  test("a rejected write is reported until a later attempt succeeds", async () => {
    const { transport, failures, store } = setup();
    transport.saveResult = async () => {
      throw new Error("offline");
    };
    store.capture("book", pdf("1.5"));
    expect(await store.flush()).toBe(false);
    expect(failures.at(-1)).toBe(true);

    transport.saveResult = async (_id, view) => view;
    store.scrolled("book", pdf("2"));
    expect(await store.flush()).toBe(true);
    expect((await store.load("book", () => true)).view).toEqual(pdf("2"));
    expect(failures.at(-1)).toBe(false);
    store.dispose();
  });

  test("retry queues failed views that are not already pending", async () => {
    const { transport, failures, store } = setup();
    transport.saveResult = async () => {
      throw new Error("offline");
    };
    store.capture("book", pdf("1.5"));
    expect(await store.flush()).toBe(false);

    transport.saveResult = async (_id, view) => view;
    store.retry();
    expect(failures.at(-1)).toBe(false);
    expect(await store.flush()).toBe(true);
    expect(transport.saves.at(-1)?.view).toEqual(pdf("1.5"));
    store.dispose();
  });
});

describe("deletion", () => {
  test("a reply after deletion is ignored and the id can persist again", async () => {
    const { transport, store } = setup();
    const held = Promise.withResolvers<ReaderView>();
    transport.saveResult = () => held.promise;
    store.capture("book", pdf("1.5"));
    const saving = store.flush();
    await Promise.resolve();

    store.deleted("book");
    held.resolve(pdf("1.5"));
    expect(await saving).toBe(true);

    const afterDelete = await store.load("book", () => true);
    expect(afterDelete).toEqual({ view: null, fetched: true });
    expect(transport.loads).toEqual(["book"]);

    transport.saveResult = async (_id, view) => view;
    store.selected("book");
    store.capture("book", pdf("2"));
    expect(await store.flush()).toBe(true);
    expect(transport.saves.at(-1)?.view).toEqual(pdf("2"));
    expect((await store.load("book", () => true)).view).toEqual(pdf("2"));
    store.dispose();
  });

  test("a failed reply after deletion does not warn", async () => {
    const { transport, failures, store } = setup();
    const held = Promise.withResolvers<ReaderView>();
    transport.saveResult = () => held.promise;
    store.capture("book", pdf("1.5"));
    const saving = store.flush();
    await Promise.resolve();

    store.deleted("book");
    held.reject(new Error("offline"));
    expect(await saving).toBe(true);
    expect(failures.every((failed) => !failed)).toBe(true);
    store.dispose();
  });
});

describe("loading views", () => {
  test("pending and saved win over the server, and a fetched view is cached", async () => {
    const { transport, store } = setup();
    transport.saveResult = async (_id, view) => view;
    store.capture("book", pdfWithMemory());
    expect(await store.flush()).toBe(true);

    transport.loadResult = async () => pdf("2");
    expect((await store.load("book", () => true)).view).toEqual(pdfWithMemory());
    expect(transport.loads).toEqual([]);

    store.capture("book", pdf("2"));
    expect((await store.load("book", () => true)).view).toEqual(pdf("2"));
    expect(transport.loads).toEqual([]);

    transport.loadResult = async () => ({
      ...DEFAULT_EPUB_READER_VIEW,
      cfi: "epubcfi(/6/2!/4/2)",
    });
    const fetched = await store.load("other", () => true);
    expect(fetched.fetched).toBe(true);
    expect(fetched.view).toEqual({
      ...DEFAULT_EPUB_READER_VIEW,
      cfi: "epubcfi(/6/2!/4/2)",
    });
    expect((await store.load("other", () => true)).fetched).toBe(false);
    expect(transport.loads).toEqual(["other"]);
    store.dispose();
  });

  test("an empty or malformed server view is a fallback, not a cache entry", async () => {
    const { transport, store } = setup();
    transport.loadResult = async () => null;
    expect(await store.load("empty", () => true)).toEqual({
      view: null,
      fetched: true,
    });

    transport.loadResult = async () =>
      ({ format: "pdf", scaleValue: "nope" }) as unknown as ReaderView;
    expect(await store.load("bad", () => true)).toEqual({
      view: null,
      fetched: true,
    });
    expect(transport.loads).toEqual(["empty", "bad"]);
    store.dispose();
  });

  test("a reply for a replaced session is not cached", async () => {
    const { transport, store } = setup();
    const held = Promise.withResolvers<ReaderView | null>();
    transport.loadResult = () => held.promise;
    let current = true;
    const reading = store.load("book", () => current);
    current = false;
    held.resolve(pdf("1.5"));

    expect(await reading).toEqual({ view: null, fetched: false });
    current = true;
    transport.loadResult = async () => pdf("2");
    expect((await store.load("book", () => true)).fetched).toBe(true);
    expect(transport.loads).toEqual(["book", "book"]);
    store.dispose();
  });

  test("a fresh read ignores pending and saved views", async () => {
    const { transport, store } = setup();
    transport.saveResult = async (_id, view) => view;
    store.capture("book", pdf("1.5"));
    await store.flush();

    transport.loadResult = async () => pdf("2");
    const read = await store.load("book", () => true, true);
    expect(read).toEqual({ view: pdf("2"), fetched: true });
    store.dispose();
  });
});

describe("leaving the page", () => {
  test("pagehide sends queued views without waiting or saving them", async () => {
    const { transport, failures, store } = setup();
    store.scrolled("book", pdf("1.5"));
    store.pagehide();

    expect(transport.keepalives).toEqual([
      { id: "book", view: pdf("1.5") },
    ]);
    expect(transport.saves).toEqual([]);
    expect((await store.load("book", () => true)).view).toEqual(pdf("1.5"));

    store.dispose();
    expect(failures).toEqual([]);
  });

  test("pagehide keeps an existing write failure visible", async () => {
    const { transport, failures, store } = setup();
    transport.saveResult = async () => {
      throw new Error("offline");
    };
    store.capture("book", pdf("1.5"));
    expect(await store.flush()).toBe(false);
    store.pagehide();
    expect(await store.flush()).toBe(false);
    expect(failures.at(-1)).toBe(true);
    store.dispose();
  });

  test("dispose cancels the delayed write", () => {
    vi.useFakeTimers();
    try {
      const { transport, store } = setup();
      store.scrolled("book", pdf("1.5"));
      store.dispose();
      vi.advanceTimersByTime(300);
      expect(transport.saves).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("change kinds", () => {
  test("changed reverting to saved drops the queued write, scrolled keeps it", async () => {
    const { transport, store } = setup();
    transport.saveResult = async (_id, view) => view;
    store.capture("book", pdf("1.5"));
    expect(await store.flush()).toBe(true);
    const saved = transport.saves.length;

    store.changed("book", pdf("2"));
    store.changed("book", pdf("1.5"));
    expect(await store.flush()).toBe(true);
    expect(transport.saves.length).toBe(saved);
    expect((await store.load("book", () => true)).view).toEqual(pdf("1.5"));

    store.scrolled("book", pdf("2"));
    store.scrolled("book", pdf("1.5"));
    expect((await store.load("book", () => true)).view).toEqual(pdf("2"));
    expect(await store.flush()).toBe(true);
    expect(transport.saves.at(-1)?.view).toEqual(pdf("2"));
    store.dispose();
  });

  test("capture replaces the queued view even with the saved one", async () => {
    const { transport, store } = setup();
    transport.saveResult = async (_id, view) => view;
    store.capture("book", pdf("1.5"));
    await store.flush();

    store.capture("book", pdf("2"));
    store.capture("book", pdf("1.5"));
    expect(await store.flush()).toBe(true);
    expect(transport.saves.map((entry) => entry.view)).toEqual([
      pdf("1.5"),
      pdf("1.5"),
    ]);
    store.dispose();
  });
});

describe("sameReaderView", () => {
  test("compares format-specific settings and scroll memory", () => {
    expect(sameReaderView(pdf("1.5"), pdf("1.5"))).toBe(true);
    expect(sameReaderView(pdf("1.5"), pdf("2"))).toBe(false);
    expect(
      sameReaderView(
        { ...DEFAULT_EPUB_READER_VIEW, cfi: "a" },
        { ...DEFAULT_EPUB_READER_VIEW, cfi: "b" },
      ),
    ).toBe(false);
    expect(
      sameReaderView(DEFAULT_PDF_READER_VIEW, DEFAULT_EPUB_READER_VIEW),
    ).toBe(false);
  });

  test("compares the translation zoom, with a missing one meaning automatic", () => {
    expect(
      sameReaderView(DEFAULT_PDF_READER_VIEW, {
        ...DEFAULT_PDF_READER_VIEW,
        translationZoom: "auto",
      }),
    ).toBe(true);
    expect(
      sameReaderView(DEFAULT_EPUB_READER_VIEW, {
        ...DEFAULT_EPUB_READER_VIEW,
        translationZoom: 1.5,
      }),
    ).toBe(false);
    expect(
      sameReaderView(
        { ...DEFAULT_PDF_READER_VIEW, translationZoom: "page-width" },
        { ...DEFAULT_PDF_READER_VIEW, translationZoom: "page-fit" },
      ),
    ).toBe(false);
  });

  test("queues a change that differs only in the translation zoom", async () => {
    const { transport, store } = setup();
    transport.loadResult = async () => DEFAULT_PDF_READER_VIEW;
    await store.load("doc", () => true);
    store.changed("doc", { ...DEFAULT_PDF_READER_VIEW, translationZoom: "auto" });
    await store.flush();
    expect(transport.saves).toEqual([]);
    store.changed("doc", { ...DEFAULT_PDF_READER_VIEW, translationZoom: 0.75 });
    await store.flush();
    expect(transport.saves).toEqual([
      { id: "doc", view: { ...DEFAULT_PDF_READER_VIEW, translationZoom: 0.75 } },
    ]);
  });
});
