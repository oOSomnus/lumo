import { describe, expect, test } from "bun:test";
import { compareEpubCfi } from "./epub";

describe("compareEpubCfi", () => {
  test("sorts ranges by where they start; assertions and ends do not count", () => {
    const heading = "epubcfi(/6/2!/4,/2/1:0,/10/1:4)";
    const partA = "epubcfi(/6/2!/4,/44[part-a]/1:0,/58/1:238)";
    const later = "epubcfi(/6/2!/4,/58/1:0,/70/1:12)";
    const sameNodeLater = "epubcfi(/6/2!/4,/58/1:5,/70/1:12)";

    expect([sameNodeLater, later, heading, partA].sort(compareEpubCfi)).toEqual([
      heading,
      partA,
      later,
      sameNodeLater,
    ]);
    expect(
      compareEpubCfi("epubcfi(/6/2!/4,/44/1:0,/58/1:1)", "epubcfi(/6/2!/4,/44/1:0,/60/1:9)"),
    ).toBe(0);
  });

  test("compares steps as numbers and puts an ancestor before its descendant", () => {
    expect(compareEpubCfi("epubcfi(/6/10!/4/2/1:0)", "epubcfi(/6/2!/4/90/1:0)")).toBeGreaterThan(0);
    expect(compareEpubCfi("epubcfi(/6/2!/4/44)", "epubcfi(/6/2!/4/44/1:0)")).toBeLessThan(0);
  });
});
