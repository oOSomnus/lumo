import { describe, expect, test } from "bun:test";
import type { ReaderScrollMemory } from "../shared/contracts";
import {
  rememberPdfScroll,
  rememberTranslationScroll,
  sameScrollMemory,
  touchPdfScroll,
  touchTranslationScroll,
} from "./scroll-memory";

const empty = (): ReaderScrollMemory => ({ pdf: [], translation: [] });

describe("PDF scroll memory", () => {
  test("a repeated page replaces its position and moves to the front", () => {
    let memory = rememberPdfScroll(empty(), { page: 1, left: 10, top: 20 });
    memory = rememberPdfScroll(memory, { page: 2, left: 30, top: 40 });
    memory = rememberPdfScroll(memory, { page: 1, left: 11, top: 21 });
    expect(memory.pdf).toEqual([
      { page: 1, left: 11, top: 21 },
      { page: 2, left: 30, top: 40 },
    ]);
  });

  test("a sixth page evicts the least recently used one", () => {
    let memory = empty();
    for (const page of [1, 2, 3, 4, 5]) {
      memory = rememberPdfScroll(memory, { page, left: 0, top: page });
    }
    memory = rememberPdfScroll(memory, { page: 6, left: 0, top: 6 });
    expect(memory.pdf.map((entry) => entry.page)).toEqual([6, 5, 4, 3, 2]);
  });

  test("touching a page promotes it without replacing its position", () => {
    let memory = empty();
    for (const page of [1, 2, 3]) {
      memory = rememberPdfScroll(memory, { page, left: page, top: page });
    }
    const touched = touchPdfScroll(memory, 1);
    expect(touched.pdf.map((entry) => entry.page)).toEqual([1, 3, 2]);
    expect(touched.pdf[0]).toEqual({ page: 1, left: 1, top: 1 });
    expect(touchPdfScroll(memory, 9)).toBe(memory);
  });
});

describe("translation scroll memory", () => {
  test("different languages and units keep separate entries", () => {
    let memory = empty();
    memory = rememberTranslationScroll(memory, { key: "book-p1-zh-CN", offset: 0.2 });
    memory = rememberTranslationScroll(memory, { key: "book-p1-en", offset: 0.8 });
    expect(memory.translation).toEqual([
      { key: "book-p1-en", offset: 0.8 },
      { key: "book-p1-zh-CN", offset: 0.2 },
    ]);
  });

  test("an offset at either edge is kept and a new one replaces the old", () => {
    let memory = rememberTranslationScroll(empty(), { key: "k", offset: 0 });
    expect(memory.translation[0]?.offset).toBe(0);
    memory = rememberTranslationScroll(memory, { key: "k", offset: 1 });
    expect(memory.translation).toEqual([{ key: "k", offset: 1 }]);
  });

  test("touching a key promotes it without replacing its offset", () => {
    let memory = empty();
    for (const [key, offset] of [["a", 0.1], ["b", 0.2], ["c", 0.3]] as const) {
      memory = rememberTranslationScroll(memory, { key, offset });
    }
    expect(touchTranslationScroll(memory, "a").translation.map((entry) => entry.key)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });
});

describe("sameScrollMemory", () => {
  test("compares both lists in order", () => {
    const memory = rememberPdfScroll(empty(), { page: 1, left: 0, top: 0 });
    expect(sameScrollMemory(memory, { ...memory })).toBe(true);
    expect(sameScrollMemory(undefined, empty())).toBe(true);
    expect(sameScrollMemory(memory, { ...memory, pdf: [] })).toBe(false);
    expect(
      sameScrollMemory(memory, { ...memory, pdf: [{ page: 1, left: 0, top: 1 }] }),
    ).toBe(false);
  });
});
