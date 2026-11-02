import { describe, expect, test } from "bun:test";
import { PageSelectionError, parsePageSelection } from "./page-selection";

describe("parsePageSelection", () => {
  test("parses single pages, ranges, duplicates and Chinese commas", () => {
    expect(parsePageSelection("1,3-5,12", 12)).toEqual([1, 3, 4, 5, 12]);
    expect(parsePageSelection(" 5 ， 1-2 , 2 ", 5)).toEqual([1, 2, 5]);
    expect(parsePageSelection("3-3", 3)).toEqual([3]);
  });

  test("rejects malformed or out-of-range expressions", () => {
    const failure = (value: string, pageCount: number): PageSelectionError => {
      try {
        parsePageSelection(value, pageCount);
      } catch (error) {
        if (error instanceof PageSelectionError) return error;
        throw error;
      }
      throw new Error("expected the selection to be rejected");
    };

    expect(failure("", 5)).toMatchObject({ code: "SELECTION_EMPTY" });
    expect(failure("1,,2", 5)).toMatchObject({ code: "SELECTION_EMPTY_TOKEN" });
    expect(failure("0", 5)).toMatchObject({
      code: "SELECTION_OUT_OF_BOUNDS",
      params: { pageCount: 5, token: "0" },
    });
    expect(failure("4-2", 5)).toMatchObject({
      code: "SELECTION_REVERSED_RANGE",
      params: { token: "4-2" },
    });
    expect(failure("2.5", 5)).toMatchObject({
      code: "SELECTION_INVALID_TOKEN",
      params: { token: "2.5" },
    });
    expect(failure("1-6", 5)).toMatchObject({ code: "SELECTION_OUT_OF_BOUNDS" });
  });

  test("the range limit is the actual page count, not an arbitrary cap", () => {
    expect(parsePageSelection("1-2000", 2000)).toHaveLength(2000);
    expect(parsePageSelection("1-2000", 2000).at(-1)).toBe(2000);
  });
});
