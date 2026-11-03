import {
  outlineEntriesSchema,
  type OutlineEntry,
} from "../shared/contracts";
import type { UiError } from "./i18n";

export interface OutlineRange extends OutlineEntry {
  endPage: number;
}

export interface OutlineRow {
  index: number;
  range: OutlineRange;
  hasChildren: boolean;
  checked: boolean;
  indeterminate: boolean;
}

export interface DocumentOutlineState {
  entries: OutlineEntry[];
  source: "native" | "generated" | null;
  loadStatus: "loading" | "ready" | "error";
  stage: "idle" | "generating" | "saving" | "unsaved";
  processedPages: number;
  skipped: number;
  error: UiError | null;
}

export class OutlineError extends Error {
  constructor(
    readonly code: "OUTLINE_INVALID" | "OUTLINE_EMPTY",
    message: string,
    readonly params?: Record<string, string | number>,
  ) {
    super(message);
    this.name = "OutlineError";
  }
}

export function emptyOutlineState(): DocumentOutlineState {
  return {
    entries: [],
    source: null,
    loadStatus: "loading",
    stage: "idle",
    processedPages: 0,
    skipped: 0,
    error: null,
  };
}

/**
 * Turns a validated, page-ordered outline into inclusive page ranges. A
 * section ends before its next sibling or ancestor, or on the start page of
 * its last descendant when that comes first, so boundary pages can overlap a
 * parent and its child. The last entry runs to the end of the document.
 */
export function buildOutlineRanges(
  entries: readonly OutlineEntry[],
  pageCount: number,
): OutlineRange[] {
  const parsed = outlineEntriesSchema.parse(entries);
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw new Error("pageCount must be a positive safe integer");
  }
  for (const entry of parsed) {
    if (entry.pageNumber > pageCount) {
      throw new Error(
        `outline page ${entry.pageNumber} is outside 1..${pageCount}`,
      );
    }
  }

  const ranges: OutlineRange[] = parsed.map((entry) => ({
    ...entry,
    endPage: pageCount,
  }));
  const stack: number[] = [];

  for (let index = 0; index < ranges.length; index += 1) {
    const entry = ranges[index]!;
    while (
      stack.length > 0 &&
      ranges[stack[stack.length - 1]!]!.level >= entry.level
    ) {
      const closed = stack.pop()!;
      ranges[closed]!.endPage = Math.max(
        ranges[index - 1]!.pageNumber,
        entry.pageNumber - 1,
      );
    }
    stack.push(index);
  }

  return ranges;
}

/**
 * Derives the visible outline lines and their range-selection state in one
 * pass. Collapsed sections skip only their descendants; page-ordered ranges
 * let a prefix sum answer each range's selected-page count.
 */
export function buildOutlineRows(
  ranges: readonly OutlineRange[],
  collapsed: ReadonlySet<number>,
  selection: ReadonlySet<number>,
  pageCount: number,
): OutlineRow[] {
  if (ranges.length === 0) return [];

  const selectedPages = new Uint32Array(pageCount + 1);
  for (const page of selection) {
    if (page >= 1 && page <= pageCount) selectedPages[page] = 1;
  }
  for (let page = 1; page <= pageCount; page += 1) {
    selectedPages[page]! += selectedPages[page - 1]!;
  }

  const rows: OutlineRow[] = [];
  let hiddenBelowLevel = 0;
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index]!;
    if (hiddenBelowLevel > 0) {
      if (range.level > hiddenBelowLevel) continue;
      hiddenBelowLevel = 0;
    }
    const pageTotal = range.endPage - range.pageNumber + 1;
    const selectedCount =
      selectedPages[range.endPage]! - selectedPages[range.pageNumber - 1]!;
    const hasChildren = (ranges[index + 1]?.level ?? 0) > range.level;
    rows.push({
      index,
      range,
      hasChildren,
      checked: selectedCount === pageTotal,
      indeterminate: selectedCount > 0 && selectedCount < pageTotal,
    });
    if (hasChildren && collapsed.has(index)) hiddenBelowLevel = range.level;
  }
  return rows;
}
