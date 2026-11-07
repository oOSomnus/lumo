import { describe, expect, test } from "bun:test";
import { outlineEntriesSchema } from "../shared/contracts";
import type { EpubTocEntry } from "./epub-bridge";
import { currentTocId, outlineFromEpubToc, visibleTocRows } from "./toc";

function entry(
  id: string,
  level: number,
  index: number | null,
  label = id,
): EpubTocEntry {
  return { id, label, level, href: index === null ? null : `c${index}.xhtml`, index };
}

const toc: EpubTocEntry[] = [
  entry("a", 1, 0),
  entry("a1", 2, 0),
  entry("a2", 2, 1),
  entry("b", 1, 2),
  entry("b1", 2, 2),
];

describe("visibleTocRows", () => {
  test("a collapsed group hides its descendants but not its siblings", () => {
    expect(visibleTocRows(toc, new Set()).map((row) => row.entry.id)).toEqual([
      "a",
      "a1",
      "a2",
      "b",
      "b1",
    ]);
    const rows = visibleTocRows(toc, new Set(["a"]));
    expect(rows.map((row) => row.entry.id)).toEqual(["a", "b", "b1"]);
    expect(rows.map((row) => row.hasChildren)).toEqual([true, true, false]);
  });

  test("collapsing a nested group keeps the outer group's other children", () => {
    const nested = [
      entry("a", 1, 0),
      entry("a1", 2, 0),
      entry("a1x", 3, 0),
      entry("a2", 2, 1),
    ];
    expect(
      visibleTocRows(nested, new Set(["a1"])).map((row) => row.entry.id),
    ).toEqual(["a", "a1", "a2"]);
  });
});

describe("currentTocId", () => {
  test("prefers the first entry of the section, else the last one before it", () => {
    expect(currentTocId(toc, 0)).toBe("a");
    expect(currentTocId(toc, 2)).toBe("b");
    expect(currentTocId(toc, 5)).toBe("b1");
    expect(currentTocId([entry("later", 1, 3)], 1)).toBeNull();
    expect(currentTocId(toc, null)).toBeNull();
  });
});

describe("outlineFromEpubToc", () => {
  test("keeps levels and maps sections to page numbers", () => {
    expect(outlineFromEpubToc(toc, 4)).toEqual([
      { title: "a", level: 1, pageNumber: 1 },
      { title: "a1", level: 2, pageNumber: 1 },
      { title: "a2", level: 2, pageNumber: 2 },
      { title: "b", level: 1, pageNumber: 3 },
      { title: "b1", level: 2, pageNumber: 3 },
    ]);
  });

  test("a group without a link takes its first linked descendant's section", () => {
    const grouped = [
      entry("part", 1, null),
      entry("missing", 2, null),
      entry("ch", 2, 4),
      entry("next", 1, 6),
    ];
    const outline = outlineFromEpubToc(grouped, 8);
    expect(outline.map((item) => item.title)).toEqual(["part", "ch", "next"]);
    expect(outline.map((item) => item.pageNumber)).toEqual([5, 5, 7]);
  });

  test("drops entries that point nowhere, with no title, or out of the book", () => {
    const messy = [
      entry("ok", 1, 0),
      entry("external", 1, null),
      entry("blank", 1, 1, "   "),
      entry("far", 1, 99),
      entry("fine", 1, 2),
    ];
    expect(outlineFromEpubToc(messy, 3).map((item) => item.title)).toEqual([
      "ok",
      "fine",
    ]);
  });

  test("always satisfies the outline schema: first level 1, no skipped level, pages never decrease", () => {
    const awkward = [
      entry("deep-first", 3, 5),
      entry("back", 1, 2),
      entry("jump", 4, 9),
      entry("again", 2, 1),
    ];
    const outline = outlineFromEpubToc(awkward, 10);
    expect(outline.map((item) => item.level)).toEqual([1, 1, 2, 2]);
    expect(outline.map((item) => item.pageNumber)).toEqual([6, 6, 10, 10]);
    expect(outlineEntriesSchema.safeParse(outline).success).toBe(true);
  });

  test("strips NUL and over-long titles instead of producing an invalid outline", () => {
    const [first] = outlineFromEpubToc(
      [entry("x", 1, 0, `A\u0000${"b".repeat(700)}`)],
      1,
    );
    expect(first!.title.length).toBe(500);
    expect(first!.title.includes("\u0000")).toBe(false);
    expect(outlineEntriesSchema.safeParse([first]).success).toBe(true);
  });

  test("returns an empty outline when nothing is usable", () => {
    expect(outlineFromEpubToc([], 3)).toEqual([]);
    expect(outlineFromEpubToc([entry("only", 1, null)], 3)).toEqual([]);
  });
});
