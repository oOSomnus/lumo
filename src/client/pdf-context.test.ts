import { describe, expect, test } from "bun:test";
import { MAX_CONTEXT_IMAGE_BASE64_CHARS, MAX_TRANSLATION_CONTEXT_CHARS } from "../shared/limits";
import {
  encodeWithinContextBudget,
  pageHeadText,
  pageTailText,
  preparePdfTranslationPage,
} from "./pdf";
import type { ViewerBridge } from "./pdfBridge";

type Item = { str: string; hasEOL: boolean } | { type: string };

const item = (str: string, hasEOL = false): Item => ({ str, hasEOL });
const poison = {
  get str(): string {
    throw new Error("text layer unreadable");
  },
  hasEOL: false,
};

// Oracle: the same text extractPageText would produce for these items.
function pageText(items: readonly Item[]): string {
  let text = "";
  for (const entry of items) {
    if ("str" in entry) text += entry.str + (entry.hasEOL ? "\n" : " ");
  }
  return text.trim();
}

function randomItems(seed: number): Item[] {
  let state = seed;
  const next = (n: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % n;
  };
  return Array.from({ length: next(30) }, () => {
    if (next(5) === 0) return { type: "beginMarkedContent" };
    const str = Array.from({ length: next(7) }, () => "ab  c\n".charAt(next(6))).join("");
    return item(str, next(3) === 0);
  });
}

async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

describe("pageTailText and pageHeadText", () => {
  test("match the page text oracle on random items", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const items = randomItems(seed);
      const full = pageText(items);
      const limit = 1 + (seed % 25);
      expect(pageTailText(items, limit)).toBe(full.slice(-limit));
      expect(pageHeadText(items, limit)).toBe(full.slice(0, limit));
    }
  });

  test("never read items beyond the budget", () => {
    const words = Array.from({ length: 800 }, (_, i) => item(`w${i}`, true));
    expect(pageTailText([poison, ...words], 50)).toBe(pageText(words).slice(-50));
    expect(pageHeadText([...words, poison], 50)).toBe(pageText(words).slice(0, 50));
  });

  test("return exactly the budget for long pages", () => {
    const words = Array.from({ length: 800 }, (_, i) => item(`w${i}`, true));
    expect(pageTailText(words, MAX_TRANSLATION_CONTEXT_CHARS)).toHaveLength(
      MAX_TRANSLATION_CONTEXT_CHARS,
    );
    expect(pageHeadText(words, MAX_TRANSLATION_CONTEXT_CHARS)).toHaveLength(
      MAX_TRANSLATION_CONTEXT_CHARS,
    );
  });

  test("drop a split surrogate pair at the window edge", () => {
    expect(pageTailText([item("😀".repeat(1500) + "a")], 2000)).toBe("😀".repeat(999) + "a");
    expect(pageHeadText([item("a" + "😀".repeat(1500))], 2000)).toBe("a" + "😀".repeat(999));
  });

  test("return empty windows for whitespace-only pages", () => {
    expect(pageTailText([item("  "), item("\n", true)], 10)).toBe("");
    expect(pageHeadText([item(" ")], 10)).toBe("");
  });
});

describe("encodeWithinContextBudget", () => {
  test("steps the long edge down by three quarters until the image fits", async () => {
    const edges: number[] = [];
    const result = await encodeWithinContextBudget(async (edge) => {
      edges.push(edge);
      return "A".repeat(edge * 300);
    });
    expect(edges).toEqual([1000, 750]);
    expect(result).toHaveLength(750 * 300);
  });

  test("reject at one pixel when the image is still over budget", async () => {
    const edges: number[] = [];
    const oversize = "A".repeat(MAX_CONTEXT_IMAGE_BASE64_CHARS + 1);
    await expect(
      encodeWithinContextBudget(async (edge) => {
        edges.push(edge);
        return oversize;
      }),
    ).rejects.toMatchObject({ code: "PAGE_IMAGE_TOO_LARGE" });
    expect(edges.at(-1)).toBe(1);
    expect(edges.every((edge, i) => i === 0 || edge < (edges[i - 1] ?? 0))).toBe(true);
  });

  test("accept the image produced at one pixel", async () => {
    const oversize = "A".repeat(MAX_CONTEXT_IMAGE_BASE64_CHARS + 1);
    const result = await encodeWithinContextBudget(async (edge) =>
      edge === 1 ? "/9j/" : oversize,
    );
    expect(result).toBe("/9j/");
  });
});

type Canvas = { width: number; height: number; getContext: () => object; toDataURL: () => string };
type Render = { page: number; canvasHeight: number; offsetY: number; pageHeight: number };

// Fake document: every page is 800x1000 at scale 1 and renders to a JPEG stub.
function setup(pages: readonly (readonly Item[])[], current: number) {
  const requested: number[] = [];
  const cleanups: number[] = [];
  const renders: Render[] = [];
  const canvases: Canvas[] = [];
  const targetDocument = {
    createElement: () => {
      const canvas: Canvas = {
        width: 0,
        height: 0,
        getContext: () => ({}),
        toDataURL: () => "data:image/jpeg;base64,/9j/AAAA",
      };
      canvases.push(canvas);
      return canvas;
    },
  };
  const fakePage = (number: number) => ({
    getTextContent: async () => ({ items: pages[number - 1] ?? [] }),
    getViewport: ({ scale = 1, offsetY = 0 }: { scale?: number; offsetY?: number } = {}) => ({
      width: 800 * scale,
      height: 1000 * scale,
      offsetY,
    }),
    render: ({ canvas, viewport }: { canvas: Canvas; viewport: { height: number; offsetY: number } }) => {
      renders.push({
        page: number,
        canvasHeight: canvas.height,
        offsetY: viewport.offsetY,
        pageHeight: viewport.height,
      });
      return { promise: Promise.resolve(), cancel: () => {} };
    },
    cleanup: () => {
      cleanups.push(number);
    },
  });
  const bridge = {
    document: targetDocument,
    page: current,
    pageCount: pages.length,
    getPage: async (number: number) => {
      requested.push(number);
      return fakePage(number);
    },
  } as unknown as ViewerBridge;
  return { bridge, requested, cleanups, renders, canvases };
}

describe("preparePdfTranslationPage", () => {
  test("send the nearest bounded text from each neighbour", async () => {
    const before = "a".repeat(2500) + "TAIL";
    const after = "HEAD" + "b".repeat(2500);
    const { bridge, requested } = setup([[item(before)], [item("target body")], [item(after)]], 2);
    const result = await preparePdfTranslationPage(bridge, 2, new AbortController().signal);
    expect(result).toMatchObject({ format: "pdf", text: "target body", imageBase64: "/9j/AAAA" });
    expect(Reflect.get(result, "context")).toEqual({
      previous: { text: before.slice(-2000) },
      next: { text: after.slice(0, 2000) },
    });
    expect(Reflect.has(result, "contextWarnings")).toBe(false);
    expect([...requested].sort()).toEqual([1, 2, 3]);
  });

  test("omit context keys when there are no neighbours", async () => {
    const { bridge, requested } = setup([[item("only page")]], 1);
    const result = await preparePdfTranslationPage(bridge, 1, new AbortController().signal);
    expect(Reflect.has(result, "context")).toBe(false);
    expect(Reflect.has(result, "contextWarnings")).toBe(false);
    expect(requested).toEqual([1]);
  });

  test("use only the existing side at the document edges", async () => {
    const first = setup([[item("one")], [item("two")]], 1);
    const firstResult = await preparePdfTranslationPage(first.bridge, 1, new AbortController().signal);
    expect(Reflect.get(firstResult, "context")).toEqual({ next: { text: "two" } });
    expect([...first.requested].sort()).toEqual([1, 2]);

    const last = setup([[item("one")], [item("two")]], 2);
    const lastResult = await preparePdfTranslationPage(last.bridge, 2, new AbortController().signal);
    expect(Reflect.get(lastResult, "context")).toEqual({ previous: { text: "one" } });
    expect([...last.requested].sort()).toEqual([1, 2]);
  });

  test("keep the target when a neighbour cannot be read", async () => {
    const { bridge } = setup([[poison], [item("target")], [item("after")]], 2);
    const result = await preparePdfTranslationPage(bridge, 2, new AbortController().signal);
    expect(result).toMatchObject({ text: "target", contextWarnings: ["previous"] });
    expect(Reflect.get(result, "context")).toEqual({ next: { text: "after" } });
  });

  test("reject with AbortError when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { bridge } = setup([[item("a")], [item("b")], [item("c")]], 2);
    const failure = await failureOf(preparePdfTranslationPage(bridge, 2, controller.signal));
    expect(failure.name).toBe("AbortError");
  });

  test("reject with AbortError when aborted while a neighbour is read", async () => {
    const controller = new AbortController();
    const aborting = {
      get str(): string {
        controller.abort();
        return "x";
      },
      hasEOL: false,
    };
    const { bridge } = setup([[item("a")], [item("b")], [aborting]], 2);
    const failure = await failureOf(preparePdfTranslationPage(bridge, 2, controller.signal));
    expect(failure.name).toBe("AbortError");
  });

  test("render only the facing 20 percent strip of a text-less neighbour", async () => {
    const { bridge, renders, canvases } = setup([[], [item("target")], []], 2);
    const result = await preparePdfTranslationPage(bridge, 2, new AbortController().signal);
    expect(Reflect.get(result, "context")).toEqual({
      previous: { imageBase64: "/9j/AAAA" },
      next: { imageBase64: "/9j/AAAA" },
    });
    // Previous keeps the bottom strip (offset moves the page up); next keeps the top strip.
    expect(renders.find((render) => render.page === 1)).toEqual({
      page: 1,
      canvasHeight: 250,
      offsetY: -1000,
      pageHeight: 1250,
    });
    expect(renders.find((render) => render.page === 3)).toEqual({
      page: 3,
      canvasHeight: 250,
      offsetY: 0,
      pageHeight: 1250,
    });
    expect(canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
  });

  test("release borrowed neighbours and the target except the viewer's page", async () => {
    const { bridge, cleanups } = setup([[item("1")], [item("2")], [item("3")], [item("4")]], 2);
    await preparePdfTranslationPage(bridge, 3, new AbortController().signal);
    expect([...cleanups].sort()).toEqual([3, 4]);
  });

  test("release a failed target unless it is the viewer's page", async () => {
    const pages = [[item("1")], [item("2")], [poison], [item("4")]];
    const onThree = setup(pages, 3);
    await expect(preparePdfTranslationPage(onThree.bridge, 3, new AbortController().signal)).rejects.toThrow();
    expect([...onThree.cleanups].sort()).toEqual([2, 4]);

    const onTwo = setup(pages, 2);
    await expect(preparePdfTranslationPage(onTwo.bridge, 3, new AbortController().signal)).rejects.toThrow();
    expect([...onTwo.cleanups].sort()).toEqual([3, 4]);
  });
});
