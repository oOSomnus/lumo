import { describe, expect, test } from "bun:test";
import { MAX_OUTLINE_ENTRIES } from "../shared/contracts";
import {
  buildOutlineImportPrompt,
  formatOutlineImport,
  MAX_OUTLINE_IMPORT_CHARS,
  MAX_OUTLINE_IMPORT_ERRORS,
  parseOutlineImport,
} from "./outline-import";

describe("parseOutlineImport", () => {
  test("reads Markdown headings with their PDF pages", () => {
    const text = [
      "# Part I  Foundations  1",
      "## 1 Introduction  3",
      "### 1.1 Motivation 4",
      "### 1.2 Scope ........ 9",
      "## 2 Background\t15",
      "# Part II  Methods  41",
    ].join("\n");
    expect(parseOutlineImport(text, 50)).toEqual({
      ok: true,
      entries: [
        { title: "Part I  Foundations", level: 1, pageNumber: 1 },
        { title: "1 Introduction", level: 2, pageNumber: 3 },
        { title: "1.1 Motivation", level: 3, pageNumber: 4 },
        { title: "1.2 Scope", level: 3, pageNumber: 9 },
        { title: "2 Background", level: 2, pageNumber: 15 },
        { title: "Part II  Methods", level: 1, pageNumber: 41 },
      ],
    });
  });

  test("keeps a title that ends in a number and skips a BOM, blank lines, CRLF and code fences", () => {
    const text = "﻿```markdown\r\n# Chapter 1  5\r\n\r\n## 2024  6\r\n```\r\n";
    expect(parseOutlineImport(text, 10)).toEqual({
      ok: true,
      entries: [
        { title: "Chapter 1", level: 1, pageNumber: 5 },
        { title: "2024", level: 2, pageNumber: 6 },
      ],
    });
  });

  test("reports each problem with its line number", () => {
    const text = [
      "## Starts deep  1",
      "Plain prose",
      "# No page here",
      "# Too far  11",
      "# Fine  4",
      "### Skips  5",
      "# Back  3",
      "#   12",
    ].join("\n");
    const result = parseOutlineImport(text, 10);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      { line: 1, code: "first_not_level_1" },
      { line: 2, code: "not_heading" },
      { line: 3, code: "missing_page" },
      { line: 4, code: "page_out_of_range" },
      { line: 6, code: "level_skips" },
      { line: 7, code: "page_decreases" },
      { line: 8, code: "title_invalid" },
    ]);
  });

  test("rejects empty, oversized and overlong input", () => {
    expect(parseOutlineImport(" \n```\n```\n", 3)).toEqual({
      ok: false,
      errors: [{ line: 0, code: "empty" }],
    });
    expect(parseOutlineImport("#".repeat(MAX_OUTLINE_IMPORT_CHARS + 1), 3)).toEqual({
      ok: false,
      errors: [{ line: 0, code: "too_large" }],
    });
    expect(parseOutlineImport(`# ${"x".repeat(501)}  1`, 3)).toEqual({
      ok: false,
      errors: [{ line: 1, code: "title_invalid" }],
    });
    expect(parseOutlineImport(`# ${".".repeat(100_000)}1`, 3)).toEqual({
      ok: false,
      errors: [{ line: 1, code: "title_invalid" }],
    });
    expect(parseOutlineImport("# Zero  0", 3)).toEqual({
      ok: false,
      errors: [{ line: 1, code: "page_out_of_range" }],
    });
  });

  test("caps the entries and the listed errors", () => {
    const many = Array.from({ length: MAX_OUTLINE_ENTRIES + 1 }, () => "# A  1").join("\n");
    expect(parseOutlineImport(many, 1)).toEqual({
      ok: false,
      errors: [{ line: MAX_OUTLINE_ENTRIES + 1, code: "too_many" }],
    });
    const bad = Array.from({ length: 50 }, () => "nope").join("\n");
    const result = parseOutlineImport(bad, 1);
    expect(result.ok ? 0 : result.errors.length).toBe(MAX_OUTLINE_IMPORT_ERRORS);
  });
});

describe("formatOutlineImport", () => {
  test("round-trips through the parser", () => {
    const entries = [
      { title: "A", level: 1, pageNumber: 1 },
      { title: "A.1 Detail 2", level: 2, pageNumber: 2 },
      { title: "B", level: 1, pageNumber: 7 },
    ];
    const text = formatOutlineImport(entries);
    expect(text).toBe("# A  1\n## A.1 Detail 2  2\n# B  7");
    expect(parseOutlineImport(text, 7)).toEqual({ ok: true, entries });
  });
});

describe("buildOutlineImportPrompt", () => {
  test("states the format, the page range and the PDF page rule", () => {
    const prompt = buildOutlineImportPrompt(321);
    expect(prompt).toContain("## Section title  PAGE");
    expect(prompt).toContain("from 1 to 321");
    expect(prompt).toContain("NOT the number printed on the page");
  });
});
