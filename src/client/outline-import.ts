import {
  MAX_OUTLINE_ENTRIES,
  MAX_OUTLINE_LEVEL,
  MAX_OUTLINE_TITLE_CHARS,
  outlineEntriesSchema,
  type OutlineEntry,
} from "../shared/contracts";

/** The largest outline text Lumo reads, pasted or from a file. */
export const MAX_OUTLINE_IMPORT_CHARS = 8 * 1024 * 1024;
/** Problems beyond this many are not listed; the first ones are what the user fixes next. */
export const MAX_OUTLINE_IMPORT_ERRORS = 20;

export type OutlineImportErrorCode =
  | "too_large"
  | "empty"
  | "not_heading"
  | "missing_page"
  | "title_invalid"
  | "level_too_deep"
  | "page_out_of_range"
  | "page_decreases"
  | "first_not_level_1"
  | "level_skips"
  | "too_many";

export interface OutlineImportError {
  /** 1-based line in the imported text; 0 for problems with the text as a whole. */
  line: number;
  code: OutlineImportErrorCode;
}

export type OutlineImportResult =
  | { ok: true; entries: OutlineEntry[] }
  | { ok: false; errors: OutlineImportError[] };

// `## Title  12`, optionally with dot leaders before the page number.
const HEADING_LINE = /^(#+)[ \t]+(.*?)[ \t.·…]*[ \t.·…](\d+)[ \t]*$/u;
const HEADING_WITHOUT_PAGE = /^#+[ \t]+\S/u;
const FENCE_LINE = /^(```|~~~)/u;
// Room for a full title, deep levels, leaders and the page; longer lines are rejected before matching.
const MAX_LINE_CHARS = MAX_OUTLINE_TITLE_CHARS + 256;

/**
 * Reads an outline written as Markdown headings, one per line: `#` repeated for the
 * level, the title, then the PDF page number. Blank lines and code fences (which AI
 * replies often add) are skipped; anything else is reported with its line number.
 */
export function parseOutlineImport(text: string, pageCount: number): OutlineImportResult {
  if (text.length > MAX_OUTLINE_IMPORT_CHARS) {
    return { ok: false, errors: [{ line: 0, code: "too_large" }] };
  }
  const errors: OutlineImportError[] = [];
  const entries: OutlineEntry[] = [];
  const report = (line: number, code: OutlineImportErrorCode): void => {
    if (errors.length < MAX_OUTLINE_IMPORT_ERRORS) errors.push({ line, code });
  };

  const lines = text.replace(/^﻿/u, "").split(/\r\n|\r|\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index]!.trim();
    if (line.length === 0 || FENCE_LINE.test(line)) continue;
    if (line.length > MAX_LINE_CHARS) {
      report(lineNumber, line.startsWith("#") ? "title_invalid" : "not_heading");
      continue;
    }

    const match = HEADING_LINE.exec(line);
    if (!match) {
      report(lineNumber, HEADING_WITHOUT_PAGE.test(line) ? "missing_page" : "not_heading");
      continue;
    }
    const level = match[1]!.length;
    const title = match[2]!.trim();
    const pageNumber = Number(match[3]);
    if (title.length === 0 || title.length > MAX_OUTLINE_TITLE_CHARS || title.includes("\u0000")) {
      report(lineNumber, "title_invalid");
      continue;
    }
    if (level > MAX_OUTLINE_LEVEL) {
      report(lineNumber, "level_too_deep");
      continue;
    }
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount) {
      report(lineNumber, "page_out_of_range");
      continue;
    }

    const previous = entries.at(-1);
    if (!previous && level !== 1) report(lineNumber, "first_not_level_1");
    if (previous && level > previous.level + 1) report(lineNumber, "level_skips");
    if (previous && pageNumber < previous.pageNumber) report(lineNumber, "page_decreases");
    if (entries.length === MAX_OUTLINE_ENTRIES) {
      report(lineNumber, "too_many");
      break;
    }
    entries.push({ title, level, pageNumber });
  }

  if (errors.length > 0) return { ok: false, errors };
  if (entries.length === 0) return { ok: false, errors: [{ line: 0, code: "empty" }] };
  return { ok: true, entries: outlineEntriesSchema.parse(entries) };
}

/** Writes an outline in the import format, so an existing one can be edited and imported again. */
export function formatOutlineImport(entries: readonly OutlineEntry[]): string {
  return entries
    .map((entry) => `${"#".repeat(entry.level)} ${entry.title}  ${entry.pageNumber}`)
    .join("\n");
}

/** Instructions for an external AI that reads the PDF and writes its outline in the import format. */
export function buildOutlineImportPrompt(pageCount: number): string {
  return `Read the attached PDF (${pageCount} pages) and write its outline: the chapters and sections from its table of contents and headings.

Output only the outline, one heading per line, in this exact format and nothing else:

# Part or chapter title  PAGE
## Section title  PAGE
### Subsection title  PAGE

Rules:
- The number of # marks is the level. The first line is level 1 (#), and a line is at most one level deeper than the line before it.
- PAGE is the PDF page number where the heading begins: page 1 is the first page of the file, counting the cover, title pages and front matter. It is NOT the number printed on the page. If the printed numbering starts later in the file, add the offset.
- PAGE is a whole number from 1 to ${pageCount}, and page numbers never go down from one line to the next.
- Keep each title exactly as written in the book, in its own language and with its numbering.
- Do not add commentary, bullet points, code fences or blank lines.`;
}
