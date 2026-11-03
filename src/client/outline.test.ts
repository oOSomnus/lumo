import { describe, expect, test } from "bun:test";
import type { OutlineEntry } from "../shared/contracts";
import { buildOutlineRanges, buildOutlineRows } from "./outline";

const outline: OutlineEntry[] = [
  { title: "A", level: 1, pageNumber: 2 },
  { title: "A.1", level: 2, pageNumber: 2 },
  { title: "A.2", level: 2, pageNumber: 5 },
  { title: "B", level: 1, pageNumber: 8 },
];

describe("buildOutlineRanges", () => {
  test("closes sections before the next sibling or ancestor", () => {
    expect(
      buildOutlineRanges(outline, 10).map(
        ({ title, pageNumber, endPage }) => ({
          title,
          pageNumber,
          endPage,
        }),
      ),
    ).toEqual([
      { title: "A", pageNumber: 2, endPage: 7 },
      { title: "A.1", pageNumber: 2, endPage: 4 },
      { title: "A.2", pageNumber: 5, endPage: 7 },
      { title: "B", pageNumber: 8, endPage: 10 },
    ]);
  });

  test("covers a child that starts on the sibling's page", () => {
    expect(
      buildOutlineRanges(
        [
          { title: "A", level: 1, pageNumber: 1 },
          { title: "A.1", level: 2, pageNumber: 5 },
          { title: "B", level: 1, pageNumber: 5 },
        ],
        6,
      ).map(({ pageNumber, endPage }) => [pageNumber, endPage]),
    ).toEqual([
      [1, 5],
      [5, 5],
      [5, 6],
    ]);
    expect(
      buildOutlineRanges(
        [
          { title: "A", level: 1, pageNumber: 2 },
          { title: "A.1", level: 2, pageNumber: 2 },
          { title: "A.1.1", level: 3, pageNumber: 4 },
          { title: "B", level: 1, pageNumber: 4 },
        ],
        6,
      ).map(({ endPage }) => endPage),
    ).toEqual([4, 4, 4, 6]);
  });

  test("keeps a page shared by same-level entries", () => {
    const ranges = buildOutlineRanges(
      [
        { title: "First", level: 1, pageNumber: 2 },
        { title: "Second", level: 1, pageNumber: 2 },
        { title: "Third", level: 1, pageNumber: 4 },
      ],
      6,
    );
    expect(ranges.map((range) => [range.pageNumber, range.endPage])).toEqual([
      [2, 2],
      [2, 3],
      [4, 6],
    ]);
  });

  test("extends the final entry to the last page and preserves duplicate titles", () => {
    const ranges = buildOutlineRanges(
      [
        { title: "Notes", level: 1, pageNumber: 1 },
        { title: "Notes", level: 1, pageNumber: 3 },
      ],
      5,
    );
    expect(ranges).toHaveLength(2);
    expect(ranges.map((range) => range.endPage)).toEqual([2, 5]);
  });

  test("rejects invalid outlines instead of guessing ranges", () => {
    expect(() =>
      buildOutlineRanges(
        [
          { title: "Later", level: 1, pageNumber: 5 },
          { title: "Earlier", level: 1, pageNumber: 2 },
        ],
        10,
      ),
    ).toThrow();
    expect(() =>
      buildOutlineRanges([{ title: "A", level: 1, pageNumber: 11 }], 10),
    ).toThrow();
    expect(() =>
      buildOutlineRanges(
        [
          { title: "A", level: 1, pageNumber: 1 },
          { title: "Jump", level: 3, pageNumber: 2 },
        ],
        10,
      ),
    ).toThrow();
    expect(() => buildOutlineRanges([], 10)).toThrow();
    expect(() => buildOutlineRanges(outline, 0)).toThrow();
  });
});

describe("buildOutlineRows", () => {
  const ranges = buildOutlineRanges(outline, 10);
  const visible = (
    rows: ReturnType<typeof buildOutlineRows>,
  ): [string, boolean, boolean][] =>
    rows.map(({ range, checked, indeterminate }) => [
      range.title,
      checked,
      indeterminate,
    ]);

  test("marks fully and partially selected ranges", () => {
    expect(visible(buildOutlineRows(ranges, new Set(), new Set([2, 3, 5]), 10)))
      .toEqual([
        ["A", false, true],
        ["A.1", false, true],
        ["A.2", false, true],
        ["B", false, false],
      ]);
    expect(
      visible(buildOutlineRows(ranges, new Set(), new Set([2, 3, 4, 5, 6, 7]), 10)),
    ).toEqual([
      ["A", true, false],
      ["A.1", true, false],
      ["A.2", true, false],
      ["B", false, false],
    ]);
  });

  test("hides only the descendants of a collapsed section", () => {
    const nested = buildOutlineRanges(
      [
        { title: "A", level: 1, pageNumber: 1 },
        { title: "A.1", level: 2, pageNumber: 2 },
        { title: "A.1.1", level: 3, pageNumber: 2 },
        { title: "A.2", level: 2, pageNumber: 4 },
        { title: "B", level: 1, pageNumber: 5 },
      ],
      6,
    );
    expect(
      buildOutlineRows(nested, new Set([1]), new Set(), 6).map(
        (row) => row.range.title,
      ),
    ).toEqual(["A", "A.1", "A.2", "B"]);
    expect(
      buildOutlineRows(nested, new Set([0]), new Set(), 6).map(
        (row) => row.range.title,
      ),
    ).toEqual(["A", "B"]);
    expect(
      buildOutlineRows(nested, new Set([2, 3, 4]), new Set(), 6).map(
        (row) => row.range.title,
      ),
    ).toEqual(["A", "A.1", "A.1.1", "A.2", "B"]);
  });

  test("renders a deep chain without ordering or depth loss", () => {
    const chain: OutlineEntry[] = Array.from({ length: 10_000 }, (_, index) => ({
      title: `L${index + 1}`,
      level: index + 1,
      pageNumber: 1,
    }));
    const chainRanges = buildOutlineRanges(chain, 1);
    const all = buildOutlineRows(chainRanges, new Set(), new Set([1]), 1);
    expect(all).toHaveLength(10_000);
    expect(all[9_999]!.range).toMatchObject({
      title: "L10000",
      level: 10_000,
    });
    expect(all[9_999]!.checked).toBe(true);
    expect(
      buildOutlineRows(chainRanges, new Set([0]), new Set(), 1).map(
        (row) => row.range.title,
      ),
    ).toEqual(["L1"]);
  });
});
