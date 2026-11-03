import { describe, expect, test } from "bun:test";
import {
  ViewerBridge,
  ViewerBridgeError,
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
