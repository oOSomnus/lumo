import { describe, expect, test } from "bun:test";
import type { DocumentRecord } from "../shared/contracts";
import {
  arrangeDocuments,
  DEFAULT_LIBRARY_PREFS,
  parseLibraryPrefs,
  parseSidebarCollapsed,
  readingProgress,
  relativeTime,
} from "./library-view";

function doc(id: string, name: string, createdAt: number, lastOpenedAt: number): DocumentRecord {
  return { id, name, size: 1, pageCount: 10, currentPage: 1, createdAt, lastOpenedAt, format: "pdf" };
}

const books = [
  doc("a", "Chapter 10.pdf", 3, 1),
  doc("b", "chapter 2.pdf", 1, 3),
  doc("c", "Ｒｅｐｏｒｔ.epub", 2, 2),
];

describe("arrangeDocuments", () => {
  test("recently read comes first by default, newest added first for added", () => {
    expect(arrangeDocuments(books, "", "recent", "en").map((d) => d.id)).toEqual(["b", "c", "a"]);
    expect(arrangeDocuments(books, "", "added", "en").map((d) => d.id)).toEqual(["a", "c", "b"]);
  });

  test("title order ignores case and compares numbers by value", () => {
    expect(arrangeDocuments(books, "", "title", "en").map((d) => d.id)).toEqual(["b", "a", "c"]);
  });

  test("search ignores case, surrounding space and full-width forms", () => {
    expect(arrangeDocuments(books, "  CHAPTER ", "recent", "en").map((d) => d.id)).toEqual(["b", "a"]);
    expect(arrangeDocuments(books, "report", "recent", "en").map((d) => d.id)).toEqual(["c"]);
    expect(arrangeDocuments(books, "missing", "recent", "en")).toEqual([]);
  });

  test("the input list is left in its order", () => {
    const input = [...books];
    arrangeDocuments(input, "", "title", "en");
    expect(input).toEqual(books);
  });
});

describe("stored preferences", () => {
  test("valid values are kept and anything else takes the default", () => {
    expect(parseLibraryPrefs('{"sort":"title","view":"list"}')).toEqual({ sort: "title", view: "list" });
    expect(parseLibraryPrefs('{"sort":"size","view":"list"}')).toEqual({ sort: "recent", view: "list" });
    for (const raw of [null, "", "not json", "null", "[]", '"grid"']) {
      expect(parseLibraryPrefs(raw)).toEqual(DEFAULT_LIBRARY_PREFS);
    }
  });

  test("the sidebar remembers only its two states", () => {
    expect(parseSidebarCollapsed("collapsed")).toBe(true);
    expect(parseSidebarCollapsed("expanded")).toBe(false);
    expect(parseSidebarCollapsed("true")).toBeNull();
    expect(parseSidebarCollapsed(null)).toBeNull();
  });
});

describe("readingProgress", () => {
  test("runs from the first page to the last, clamped and safe for empty books", () => {
    expect(readingProgress(1, 10)).toBe(0);
    expect(readingProgress(6, 11)).toBe(0.5);
    expect(readingProgress(10, 10)).toBe(1);
    expect(readingProgress(12, 10)).toBe(1);
    expect(readingProgress(1, 1)).toBe(0);
    expect(readingProgress(1, 0)).toBe(0);
    expect(readingProgress(0, 10)).toBe(0);
  });
});

describe("relativeTime", () => {
  const now = Date.UTC(2026, 10, 20, 12);
  test("picks the largest unit that fits", () => {
    expect(relativeTime("en", now - 10_000, now)).toBe("now");
    expect(relativeTime("en", now - 5 * 60_000, now)).toBe("5 minutes ago");
    expect(relativeTime("en", now - 24 * 3600_000, now)).toBe("yesterday");
    expect(relativeTime("en", now - 3 * 24 * 3600_000, now)).toBe("3 days ago");
    expect(relativeTime("en", now - 400 * 24 * 3600_000, now)).toBe("last year");
  });

  test("follows the interface language", () => {
    expect(relativeTime("zh-CN", now - 3 * 24 * 3600_000, now)).toBe("3天前");
  });
});
