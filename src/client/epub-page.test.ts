import { describe, expect, test } from "bun:test";
import {
  boundedHead,
  boundedTail,
  collapseSpace,
  insideEndCfi,
  joinRangeCfi,
  overlapsSpan,
  rangeBoundaryCfis,
} from "./epub-page";

describe("joinRangeCfi", () => {
  test("splits two text positions at their deepest shared element", () => {
    expect(joinRangeCfi("epubcfi(/6/4[ch1]!/4/2/1:5)", "epubcfi(/6/4[ch1]!/4/6/1:20)")).toBe(
      "epubcfi(/6/4[ch1]!/4,/2/1:5,/6/1:20)",
    );
  });

  test("keeps the text node itself out of the shared path, as epub.js writes it", () => {
    expect(joinRangeCfi("epubcfi(/6/4!/4/2/1:5)", "epubcfi(/6/4!/4/2/1:20)")).toBe(
      "epubcfi(/6/4!/4/2,/1:5,/1:20)",
    );
  });

  test("an image position without an offset can start or end a range", () => {
    expect(joinRangeCfi("epubcfi(/6/4!/4/2/4)", "epubcfi(/6/4!/4/2/6/1:12)")).toBe(
      "epubcfi(/6/4!/4/2,/4,/6/1:12)",
    );
    expect(joinRangeCfi("epubcfi(/6/4!/4/2/1:3)", "epubcfi(/6/4!/4/2/4)")).toBe(
      "epubcfi(/6/4!/4/2,/1:3,/4)",
    );
  });

  test("a position that is the ancestor of the other still leaves both sides a step", () => {
    expect(joinRangeCfi("epubcfi(/6/4!/4/2)", "epubcfi(/6/4!/4/2/1:5)")).toBe(
      "epubcfi(/6/4!/4,/2,/2/1:5)",
    );
  });

  test("the same position is not a range; positions of different sections cannot be joined", () => {
    expect(joinRangeCfi("epubcfi(/6/4!/4/2/1:5)", "epubcfi(/6/4!/4/2/1:5)")).toBe("epubcfi(/6/4!/4/2/1:5)");
    expect(joinRangeCfi("epubcfi(/6/4!/4/2/1:5)", "epubcfi(/6/6!/4/2/1:9)")).toBeNull();
    expect(joinRangeCfi("not a cfi", "epubcfi(/6/4!/4/2/1:5)")).toBeNull();
  });

  test("assertions with brackets and escapes are compared as written", () => {
    expect(
      joinRangeCfi("epubcfi(/6/4[a^]b]!/4[body]/2[p1]/1:5)", "epubcfi(/6/4[a^]b]!/4[body]/6[p2]/1:9)"),
    ).toBe("epubcfi(/6/4[a^]b]!/4[body],/2[p1]/1:5,/6[p2]/1:9)");
  });
});

describe("rangeBoundaryCfis", () => {
  test("gives the first and last position of a range, the inverse of joinRangeCfi", () => {
    const start = "epubcfi(/6/4[ch1]!/4/2/1:5)";
    const end = "epubcfi(/6/4[ch1]!/4/6/1:20)";
    expect(rangeBoundaryCfis(joinRangeCfi(start, end)!)).toEqual({ start, end });
  });

  test("a point is both of its boundaries; a malformed CFI has none", () => {
    expect(rangeBoundaryCfis("epubcfi(/6/4!/4/2/1:5)")).toEqual({
      start: "epubcfi(/6/4!/4/2/1:5)",
      end: "epubcfi(/6/4!/4/2/1:5)",
    });
    expect(rangeBoundaryCfis("epubcfi(/6/4!/4,/2)")).toBeNull();
    expect(rangeBoundaryCfis("chapter.xhtml")).toBeNull();
  });
});

describe("insideEndCfi", () => {
  test("moves a text end back onto the last character the range covers", () => {
    expect(insideEndCfi("epubcfi(/6/4!/4/2/1:20)")).toBe("epubcfi(/6/4!/4/2/1:19)");
    expect(insideEndCfi("epubcfi(/6/4!/4/2/1:20[x])")).toBe("epubcfi(/6/4!/4/2/1:19[x])");
  });

  test("leaves an end that has no character to step back over", () => {
    expect(insideEndCfi("epubcfi(/6/4!/4/2/1:0)")).toBe("epubcfi(/6/4!/4/2/1:0)");
    expect(insideEndCfi("epubcfi(/6/4!/4/2/4)")).toBe("epubcfi(/6/4!/4/2/4)");
  });
});

describe("bounded text", () => {
  test("collapses runs of whitespace", () => {
    expect(collapseSpace("  a \n\n b\t c ")).toBe("a b c");
  });

  test("head and tail keep at most the limit and are unchanged when short", () => {
    expect(boundedHead("abcdef", 4)).toBe("abcd");
    expect(boundedTail("abcdef", 4)).toBe("cdef");
    expect(boundedHead("abc", 4)).toBe("abc");
    expect(boundedTail("abc", 4)).toBe("abc");
  });

  test("never cuts a surrogate pair in half", () => {
    expect(boundedHead("a😀b", 2)).toBe("a");
    expect(boundedHead("a😀b", 3)).toBe("a😀");
    expect(boundedTail("a😀b", 2)).toBe("b");
    expect(boundedTail("a😀b", 3)).toBe("😀b");
  });
});

describe("overlapsSpan", () => {
  const span = { left: 600, right: 1200 };

  test("a box inside or straddling an edge overlaps", () => {
    expect(overlapsSpan({ left: 700, right: 900 }, span)).toBe(true);
    expect(overlapsSpan({ left: 500, right: 700 }, span)).toBe(true);
    expect(overlapsSpan({ left: 1100, right: 1300 }, span)).toBe(true);
  });

  test("a box on the neighbouring screen page, or touching the edge by rounding noise, does not", () => {
    expect(overlapsSpan({ left: 0, right: 599 }, span)).toBe(false);
    expect(overlapsSpan({ left: 500, right: 600.5 }, span)).toBe(false);
    expect(overlapsSpan({ left: 1199.5, right: 1300 }, span)).toBe(false);
    expect(overlapsSpan({ left: 1200, right: 1800 }, span)).toBe(false);
  });
});
