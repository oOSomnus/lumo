import { describe, expect, test } from "bun:test";
import {
  toPdfJsOutline,
  ViewerBridge,
  ViewerBridgeError,
  type PdfJsOutlineNode,
  type PdfViewerApplicationLike,
} from "./pdfBridge";

interface RefLike {
  num: number;
  gen: number;
}

interface OutlineNodeLike {
  title: string;
  dest: string | unknown[] | null;
  url?: string | null;
  items: OutlineNodeLike[];
}

function node(
  title: string,
  dest: string | unknown[] | null,
  items: OutlineNodeLike[] = [],
  url: string | null = null,
): OutlineNodeLike {
  return { title, dest, items, url };
}

function bridge(
  outline: OutlineNodeLike[] | null,
  options: {
    destinations?: Record<string, unknown[] | null>;
    cached?: Map<number, number>;
    outlineError?: boolean;
  } = {},
): ViewerBridge {
  const destinations = options.destinations ?? {};
  const cached = options.cached ?? new Map<number, number>();
  const pdfDocument = {
    numPages: 10,
    getOutline: async () => {
      if (options.outlineError) throw new Error("outline unavailable");
      return outline as never;
    },
    getDestination: async (name: string) => {
      if (!(name in destinations)) throw new Error(`unknown destination ${name}`);
      return destinations[name] ?? null;
    },
    getPageIndex: async (ref: RefLike) => ref.num - 1,
    cachedPageNumber: (ref: RefLike) => cached.get(ref.num) ?? null,
    getPage: async () => {
      throw new Error("not used");
    },
    getData: async () => new Uint8Array(),
    saveDocument: async () => new Uint8Array(),
    annotationStorage: {
      size: 0,
      onSetModified: null,
      serializable: { hash: "" },
    },
  };
  const app = {
    initializedPromise: Promise.resolve(),
    eventBus: { on() {}, off() {} },
    pdfDocument,
    pdfViewer: {
      currentScaleValue: "page-fit",
      pagesRotation: 0,
      scrollMode: 3,
      spreadMode: 0,
      isInPresentationMode: false,
    },
    page: 1,
    pagesCount: 10,
    open: async () => {},
  };
  return new ViewerBridge(app as unknown as PdfViewerApplicationLike, {} as Window);
}

describe("ViewerBridge.getOutline", () => {
  test("resolves named, page-reference and integer destinations to 1-based pages", async () => {
    const result = await bridge(
      [
        node("Named", "chapter"),
        node("Reference", [{ num: 2, gen: 0 }]),
        node("Integer", [4]),
      ],
      {
        destinations: { chapter: [{ num: 1, gen: 0 }] },
        cached: new Map([[1, 1]]),
      },
    ).getOutline();

    expect(result).toEqual({
      entries: [
        { title: "Named", level: 1, pageNumber: 1 },
        { title: "Reference", level: 1, pageNumber: 2 },
        { title: "Integer", level: 1, pageNumber: 5 },
      ],
      skipped: 0,
    });
  });

  test("keeps a destination-less group when a descendant has a page", async () => {
    const result = await bridge([
      node("Part", null, [node("Chapter", [1])]),
    ]).getOutline();

    expect(result.entries).toEqual([
      { title: "Part", level: 1, pageNumber: 2 },
      { title: "Chapter", level: 2, pageNumber: 2 },
    ]);
    expect(result.skipped).toBe(0);
  });

  test("skips external and unresolvable leaves without dropping valid siblings", async () => {
    const result = await bridge(
      [
        node("Web", null, [], "https://example.com"),
        node("Broken", "missing"),
        node("", [2]),
        node("Valid", [3]),
      ],
      { destinations: { missing: null } },
    ).getOutline();

    expect(result.skipped).toBe(2);
    expect(result.entries).toEqual([
      { title: "3", level: 1, pageNumber: 3 },
      { title: "Valid", level: 1, pageNumber: 4 },
    ]);
  });

  test("returns an empty result when the PDF has no outline", async () => {
    await expect(bridge(null).getOutline()).resolves.toEqual({
      entries: [],
      skipped: 0,
    });
    await expect(bridge([]).getOutline()).resolves.toEqual({
      entries: [],
      skipped: 0,
    });
  });

  test("rejects a reversed outline instead of inventing ranges", async () => {
    const pending = bridge([
      node("Later", [4]),
      node("Earlier", [1]),
    ]).getOutline();
    await expect(pending).rejects.toBeInstanceOf(ViewerBridgeError);
    await expect(pending).rejects.toMatchObject({ code: "OUTLINE_INVALID" });
  });

  test("reports a native read failure separately from an invalid outline", async () => {
    await expect(bridge([], { outlineError: true }).getOutline()).rejects.toMatchObject({
      code: "PDF_OPEN_FAILED",
    });
  });

  test("rejects when the PDF is not open", async () => {
    const app = {
      initializedPromise: Promise.resolve(),
      eventBus: { on() {}, off() {} },
      pdfViewer: {},
      page: 1,
      pagesCount: 0,
      open: async () => {},
    };
    const missing = new ViewerBridge(
      app as unknown as PdfViewerApplicationLike,
      {} as Window,
    );
    await expect(missing.getOutline()).rejects.toMatchObject({
      code: "PDF_NOT_READY",
    });
  });
});

describe("toPdfJsOutline", () => {
  test("nests entries by level with 0-based page destinations, expanded", () => {
    const tree = toPdfJsOutline([
      { title: "A", level: 1, pageNumber: 1 },
      { title: "A.1", level: 2, pageNumber: 2 },
      { title: "A.1.a", level: 3, pageNumber: 2 },
      { title: "A.2", level: 2, pageNumber: 4 },
      { title: "B", level: 1, pageNumber: 7 },
    ]);
    const shape = (nodes: PdfJsOutlineNode[]): unknown[] =>
      nodes.map((node) => [node.title, node.dest, node.count, shape(node.items)]);
    expect(shape(tree)).toEqual([
      [
        "A",
        [0, { name: "XYZ" }, null, null, null],
        2,
        [
          ["A.1", [1, { name: "XYZ" }, null, null, null], 1, [["A.1.a", [1, { name: "XYZ" }, null, null, null], 0, []]]],
          ["A.2", [3, { name: "XYZ" }, null, null, null], 0, []],
        ],
      ],
      ["B", [6, { name: "XYZ" }, null, null, null], 0, []],
    ]);
  });
});

describe("ViewerBridge.setSidebarOutline", () => {
  const imported = [
    { title: "Imported", level: 1, pageNumber: 1 },
    { title: "Part", level: 2, pageNumber: 2 },
  ];
  const nativeOutline = [{ title: "Native", dest: [0, { name: "Fit" }], items: [] }];

  /** A viewer whose sidebar behaves like the pinned PDF.js: replacing an outline resets it, and every render announces itself. */
  function sidebarApp(native: unknown[] | null = nativeOutline) {
    const listeners = new Map<string, Set<(event: unknown) => void>>();
    const eventBus = {
      on(name: string, listener: (event: unknown) => void) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name)!.add(listener);
      },
      off(name: string, listener: (event: unknown) => void) {
        listeners.get(name)?.delete(listener);
      },
      dispatch(name: string, event: unknown) {
        for (const listener of listeners.get(name) ?? []) listener(event);
      },
      count: (name: string) => listeners.get(name)?.size ?? 0,
    };
    const makeDocument = () => ({ numPages: 10, getOutline: async () => native });
    const outlineViewer = {
      rendered: [] as (unknown[] | null)[],
      resolved: [] as boolean[],
      _outline: null as unknown[] | null,
      _isPagesLoaded: true as boolean | null,
      _currentOutlineItemCapability: null as { resolve(value: boolean): void } | null,
      render({ outline }: { outline: unknown[] | null }) {
        if (this._outline) {
          this._outline = null;
          this._isPagesLoaded = null;
        }
        this._outline = outline;
        this.rendered.push(outline);
        this._currentOutlineItemCapability = { resolve: (value) => this.resolved.push(value) };
        eventBus.dispatch("outlineloaded", { source: this, outlineCount: outline?.length ?? 0 });
      },
    };
    const app = {
      initializedPromise: Promise.resolve(),
      eventBus,
      pdfDocument: makeDocument() as unknown,
      pdfOutlineViewer: outlineViewer as unknown,
      pdfViewer: {},
      page: 1,
      pagesCount: 10,
      open: async () => {},
    };
    const viewerBridge = new ViewerBridge(app as unknown as PdfViewerApplicationLike, {} as Window);
    return { app, eventBus, outlineViewer, viewerBridge, makeDocument };
  }

  const titles = (outline: unknown[] | null | undefined) =>
    (outline as { title: string }[] | null | undefined)?.map((node) => node.title) ?? null;

  test("shows the imported outline and puts it back after the viewer renders its own", async () => {
    const { eventBus, outlineViewer, viewerBridge } = sidebarApp();
    await viewerBridge.setSidebarOutline(imported);
    expect(titles(outlineViewer.rendered.at(-1))).toEqual(["Imported"]);
    expect(outlineViewer.rendered).toHaveLength(1);

    // PDF.js renders the native outline after the first page.
    outlineViewer.render({ outline: nativeOutline });
    await Promise.resolve();
    expect(titles(outlineViewer.rendered.at(-1))).toEqual(["Imported"]);
    expect(outlineViewer.rendered).toHaveLength(3);

    // Events from another tree view are not the outline's.
    eventBus.dispatch("outlineloaded", { source: {}, outlineCount: 0 });
    await Promise.resolve();
    expect(outlineViewer.rendered).toHaveLength(3);

    viewerBridge.destroy();
    expect(eventBus.count("outlineloaded")).toBe(0);
  });

  test("brings back the native outline only after an override", async () => {
    const { outlineViewer, viewerBridge } = sidebarApp();
    await viewerBridge.setSidebarOutline(null);
    expect(outlineViewer.rendered).toHaveLength(0);

    await viewerBridge.setSidebarOutline(imported);
    await viewerBridge.setSidebarOutline(null);
    expect(titles(outlineViewer.rendered.at(-1))).toEqual(["Native"]);
    await Promise.resolve();
    expect(outlineViewer.rendered).toHaveLength(2);

    const empty = sidebarApp(null);
    await empty.viewerBridge.setSidebarOutline(imported);
    await empty.viewerBridge.setSidebarOutline(null);
    expect(empty.outlineViewer.rendered.at(-1)).toBeNull();
  });

  test("forgets an override once another document is open", async () => {
    const { app, outlineViewer, viewerBridge, makeDocument } = sidebarApp();
    await viewerBridge.setSidebarOutline(imported);
    app.pdfDocument = makeDocument();
    outlineViewer.render({ outline: nativeOutline });
    await Promise.resolve();
    expect(titles(outlineViewer.rendered.at(-1))).toEqual(["Native"]);

    // Clearing an override that belonged to the old document leaves the new one alone.
    await viewerBridge.setSidebarOutline(null);
    expect(titles(outlineViewer.rendered.at(-1))).toEqual(["Native"]);
    expect(outlineViewer.rendered).toHaveLength(2);
  });

  test("keeps the current-item button working after replacing a rendered outline", async () => {
    const { outlineViewer, viewerBridge } = sidebarApp();
    outlineViewer.render({ outline: nativeOutline });
    outlineViewer.resolved.length = 0;
    await viewerBridge.setSidebarOutline(imported);
    expect(outlineViewer._isPagesLoaded).toBe(true);
    expect(outlineViewer.resolved).toEqual([true]);
  });

  test("does nothing without an outline sidebar or an open document", async () => {
    const { app, viewerBridge } = sidebarApp();
    app.pdfOutlineViewer = null;
    await expect(viewerBridge.setSidebarOutline(imported)).resolves.toBeUndefined();
    const closed = sidebarApp();
    closed.app.pdfDocument = undefined;
    await closed.viewerBridge.setSidebarOutline(imported);
    expect(closed.outlineViewer.rendered).toHaveLength(0);
  });
});
