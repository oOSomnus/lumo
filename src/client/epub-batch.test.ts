import { describe, expect, test } from "bun:test";
import type { EpubLayoutSnapshot } from "../shared/epub";
import type { EpubPageLocation } from "./epub-bridge";
import {
  findUntranslatedEpubSections,
  isOpenTask,
  runEpubBatch,
  type EpubBatchOptions,
} from "./epub-batch";
import type { EnqueueTranslation } from "./translation-queue";

describe("isOpenTask", () => {
  const draft = { typst: "x", provider: "p", model: "m" };
  test("only waiting, running and draft-holding tasks block a new batch", () => {
    expect(isOpenTask(undefined)).toBe(false);
    for (const stage of ["queued", "preparing", "generating", "repairing", "validating", "saving"] as const) {
      expect(isOpenTask({ stage })).toBe(true);
    }
    expect(isOpenTask({ stage: "unsaved", draft })).toBe(true);
    expect(isOpenTask({ stage: "cancelled", draft })).toBe(true);
    expect(isOpenTask({ stage: "cancelled" })).toBe(false);
    expect(isOpenTask({ stage: "error" })).toBe(false);
    expect(isOpenTask({ stage: "saved" })).toBe(false);
  });
});

const layout: EpubLayoutSnapshot = {
  width: 700,
  height: 900,
  style: { fontSize: 18, fontFamily: "serif", lineHeight: 1.6, theme: "light" },
};

function location(sectionIndex: number, page: number, total: number): EpubPageLocation {
  return {
    sectionIndex,
    startCfi: `epubcfi(/6/${(sectionIndex + 1) * 2}!/4/${page})`,
    sourceCfi: `epubcfi(/6/${(sectionIndex + 1) * 2}!/4,/${page}/1:0,/${page}/1:9)`,
    unit: `page-${String(sectionIndex).padStart(2, "0")}${String(page).padStart(2, "0")}`.padEnd(69, "0"),
    page,
    total,
  };
}

function setup(
  pages: EpubPageLocation[],
  overrides: Partial<EpubBatchOptions> = {},
): { options: EpubBatchOptions; queued: EnqueueTranslation[]; found: number[] } {
  const queued: EnqueueTranslation[] = [];
  const found: number[] = [];
  const options: EpubBatchOptions = {
    bridge: {
      async *pages() {
        for (const page of pages) yield page;
      },
    },
    layout,
    sectionIndexes: [0, 1],
    documentId: "doc",
    language: "zh-CN",
    retranslate: false,
    saved: new Set(),
    isBusy: () => false,
    confirmRetranslate: async () => true,
    enqueue: (input) => queued.push(input),
    onFound: (count) => found.push(count),
    signal: new AbortController().signal,
    ...overrides,
  };
  return { options, queued, found };
}

describe("runEpubBatch", () => {
  const pages = [location(0, 1, 2), location(0, 2, 2), location(1, 1, 1)];

  test("queues one batch task per page with the frozen layout and its position", async () => {
    const { options, queued, found } = setup(pages);
    expect(await runEpubBatch(options)).toEqual({ found: 3, queued: 3 });
    expect(found).toEqual([1, 2, 3]);
    expect(queued.map((task) => [task.pageNumber, task.epubPage])).toEqual([
      [1, { page: 1, total: 2 }],
      [1, { page: 2, total: 2 }],
      [2, { page: 1, total: 1 }],
    ]);
    for (const [index, task] of queued.entries()) {
      expect(task.sourceCfi).toBe(pages[index]!.sourceCfi);
      expect(task.unit).toBe(pages[index]!.unit);
      expect(task.epubLayout).toBe(layout);
      expect(task.priority).toBe("batch");
      expect(task.force).toBe(false);
    }
  });

  test("queues a page as soon as it is found, before later pages exist", async () => {
    const queued: EnqueueTranslation[] = [];
    let queuedWhenSecondRequested = -1;
    const { options } = setup([], {
      bridge: {
        async *pages() {
          yield pages[0]!;
          queuedWhenSecondRequested = queued.length;
          yield pages[1]!;
        },
      },
      enqueue: (input) => queued.push(input),
    });
    await runEpubBatch(options);
    expect(queuedWhenSecondRequested).toBe(1);
  });

  test("skips saved pages by unit and pages that already have a task", async () => {
    const { options, queued } = setup(pages, {
      saved: new Set([`1/${pages[0]!.unit}`]),
      isBusy: (pageNumber, unit) => pageNumber === 1 && unit === pages[1]!.unit,
    });
    expect(await runEpubBatch(options)).toEqual({ found: 3, queued: 1 });
    expect(queued.map((task) => task.unit)).toEqual([pages[2]!.unit]);
  });

  test("a saved page of another unit does not hide a page of the same section", async () => {
    const { options, queued } = setup(pages, {
      saved: new Set([`1/page-other`, `2/${pages[0]!.unit}`]),
    });
    await runEpubBatch(options);
    expect(queued).toHaveLength(3);
  });

  test("regenerating asks once with the saved count and queues nothing until confirmed", async () => {
    const asked: number[] = [];
    const queuedAtAsk: number[] = [];
    const queued: EnqueueTranslation[] = [];
    const { options } = setup(pages, {
      retranslate: true,
      saved: new Set([`1/${pages[0]!.unit}`, `2/${pages[2]!.unit}`]),
      confirmRetranslate: async (count) => {
        asked.push(count);
        queuedAtAsk.push(queued.length);
        return true;
      },
      enqueue: (input) => queued.push(input),
    });
    expect(await runEpubBatch(options)).toEqual({ found: 3, queued: 3 });
    expect(asked).toEqual([2]);
    expect(queuedAtAsk).toEqual([0]);
    expect(queued.every((task) => task.force)).toBe(true);
  });

  test("declining the regeneration queues nothing", async () => {
    const queued: EnqueueTranslation[] = [];
    const { options } = setup(pages, {
      retranslate: true,
      saved: new Set([`1/${pages[0]!.unit}`]),
      confirmRetranslate: async () => false,
      enqueue: (input) => queued.push(input),
    });
    expect(await runEpubBatch(options)).toBeNull();
    expect(queued).toEqual([]);
  });

  test("regenerating without saved pages does not ask", async () => {
    let asked = false;
    const { options, queued } = setup(pages, {
      retranslate: true,
      confirmRetranslate: async () => {
        asked = true;
        return true;
      },
    });
    await runEpubBatch(options);
    expect(asked).toBe(false);
    expect(queued).toHaveLength(3);
  });

  test("cancelling stops enumeration and rethrows the abort", async () => {
    const controller = new AbortController();
    const { options, queued } = setup([], {
      bridge: {
        async *pages(_sections, _layout, signal) {
          yield pages[0]!;
          controller.abort();
          signal.throwIfAborted();
          yield pages[1]!;
        },
      },
      signal: controller.signal,
    });
    await expect(runEpubBatch(options)).rejects.toMatchObject({ name: "AbortError" });
    expect(queued).toHaveLength(1);
  });

  test("an enumeration error is reported, not swallowed, and keeps what was queued", async () => {
    const failure = Object.assign(new Error("boom"), { code: "EPUB_NAVIGATION_FAILED" });
    const { options, queued } = setup([], {
      bridge: {
        async *pages() {
          yield pages[0]!;
          throw failure;
        },
      },
    });
    await expect(runEpubBatch(options)).rejects.toBe(failure);
    expect(queued).toHaveLength(1);
  });
});

describe("findUntranslatedEpubSections", () => {
  const pages = [location(0, 1, 2), location(0, 2, 2), location(1, 1, 1)];

  test("selects a section that has a screen page without a saved translation", async () => {
    const { options } = setup(pages, { saved: new Set([`1/${pages[0]!.unit}`]) });
    expect(await findUntranslatedEpubSections(options)).toEqual([1, 2]);
  });

  test("leaves out a section whose every screen page is saved, and everything when all are", async () => {
    const first = setup(pages, { saved: new Set([`1/${pages[0]!.unit}`, `1/${pages[1]!.unit}`]) });
    expect(await findUntranslatedEpubSections(first.options)).toEqual([2]);
    const all = setup(pages, { saved: new Set(pages.map((page) => `${page.sectionIndex + 1}/${page.unit}`)) });
    expect(await findUntranslatedEpubSections(all.options)).toEqual([]);
  });

  test("counts a section saved only at another layout as untranslated", async () => {
    // Its old translations stay in the database under other units; none belongs to a page of this layout.
    const { options } = setup(pages, {
      saved: new Set(["1/page-old-a", "1/page-old-b", `2/${pages[2]!.unit}`]),
    });
    expect(await findUntranslatedEpubSections(options)).toEqual([1]);
  });

  test("lists each section once, in order, and reports every page it locates", async () => {
    const { options, found } = setup([pages[2]!, pages[0]!, pages[1]!]);
    expect(await findUntranslatedEpubSections(options)).toEqual([1, 2]);
    expect(found).toEqual([1, 2, 3]);
  });

  test("cancelling stops enumeration and rethrows the abort", async () => {
    const controller = new AbortController();
    const { options, found } = setup([], {
      bridge: {
        async *pages(_sections, _layout, signal) {
          yield pages[0]!;
          controller.abort();
          signal.throwIfAborted();
          yield pages[1]!;
        },
      },
      signal: controller.signal,
    });
    await expect(findUntranslatedEpubSections(options)).rejects.toMatchObject({ name: "AbortError" });
    expect(found).toEqual([1]);
  });
});
