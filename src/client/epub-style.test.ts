import { describe, expect, test } from "bun:test";
import type { EpubReaderStyle } from "../shared/epub";
import { injectStyle, readingCss } from "./epub-style";

const base: EpubReaderStyle = { fontSize: 22, fontFamily: "sans-serif", lineHeight: 1.8, theme: "light" };

describe("readingCss", () => {
  test("a reflowable book gets its font settings and keeps its own colours in the light theme", () => {
    const css = readingCss(base, false);
    expect(css).toContain("font-size: 22px !important");
    expect(css).toContain("font-family: sans-serif !important");
    expect(css).toContain("line-height: 1.8 !important");
    expect(css).not.toContain("background");
  });

  test("a fixed-layout book gets no font rules, only the colour theme", () => {
    const css = readingCss({ ...base, theme: "dark" }, true);
    expect(css).not.toContain("font-size");
    expect(css).not.toContain("line-height");
    expect(css).toContain("#1e1e1e");
  });

  test("a fixed-layout book in the light theme still yields a sheet, so an earlier theme is replaced", () => {
    expect(readingCss(base, true).trim()).not.toBe("");
  });

  test("each theme paints its own page and text colour and the sheet changes with the theme", () => {
    const sepia = readingCss({ ...base, theme: "sepia" }, false);
    const dark = readingCss({ ...base, theme: "dark" }, false);
    expect(sepia).toContain("#f4ecd8");
    expect(dark).toContain("#1e1e1e");
    expect(sepia).not.toBe(dark);
  });
});

describe("injectStyle", () => {
  test("the sheet goes last in the head, after the book's own styles, and carries the id addStylesheetCss replaces", () => {
    const html = injectStyle("<html><head><style>a{}</style></head><body>x</body></html>", "p{color:red}");
    expect(html).toBe(
      '<html><head><style>a{}</style><style id="epubjs-inserted-css-lumo-reading">p{color:red}</style></head><body>x</body></html>',
    );
  });

  test("a section serialized without a head gets the sheet right after <html>", () => {
    const html = injectStyle('<html xmlns="http://www.w3.org/1999/xhtml"><body>x</body></html>', "p{}");
    expect(html).toMatch(/^<html xmlns="[^"]+"><style id="epubjs-inserted-css-lumo-reading">p\{\}<\/style><body>/);
  });
});
