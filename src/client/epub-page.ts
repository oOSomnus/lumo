import type { ContentsLike, RenditionLike } from "./epub-js";

// ---------------------------------------------------------------------------
// CFI strings. epub.js writes a range CFI only from text positions, so a range
// that starts or ends at an image is composed here from two point CFIs.

const ASSERTION = "\\[(?:[^\\]^]|\\^.)*\\]";
const STEP = new RegExp(`\\/\\d+(?:${ASSERTION})?`, "y");
const TERMINAL = new RegExp(`^(?::\\d+(?:${ASSERTION})?)?$`);

interface PointCfi {
  base: string;
  steps: string[];
  /** `:offset` with its optional assertion, or "". */
  terminal: string;
}

/** Splits `text` at its top-level occurrences of `separator`, skipping bracketed assertions and `^` escapes. */
function splitTopLevel(text: string, separator: string, limit = Infinity): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let index = 0; index < text.length && parts.length < limit - 1; index += 1) {
    const char = text[index]!;
    if (char === "^") index += 1;
    else if (char === "[") depth += 1;
    else if (char === "]") depth -= 1;
    else if (char === separator && depth === 0) {
      parts.push(text.slice(from, index));
      from = index + 1;
    }
  }
  parts.push(text.slice(from));
  return parts;
}

function parsePoint(cfi: string): PointCfi | null {
  const inner = /^epubcfi\((.*)\)$/s.exec(cfi)?.[1];
  if (inner === undefined) return null;
  const halves = splitTopLevel(inner, "!", 2);
  if (halves.length !== 2) return null;
  const [base, path] = halves as [string, string];
  const steps: string[] = [];
  let at = 0;
  while (path[at] === "/") {
    STEP.lastIndex = at;
    const step = STEP.exec(path);
    if (!step) return null;
    steps.push(step[0]);
    at += step[0].length;
  }
  const terminal = path.slice(at);
  return steps.length > 0 && TERMINAL.test(terminal) ? { base, steps, terminal } : null;
}

/** One range CFI from the CFIs of its first and last position; null when either is not a plain point CFI of one section. */
export function joinRangeCfi(start: string, end: string): string | null {
  if (start === end) return start;
  const from = parsePoint(start);
  const to = parsePoint(end);
  if (!from || !to || from.base !== to.base) return null;
  // Each side keeps at least one step of its own, so no sub-path is empty.
  const limit = Math.min(from.steps.length, to.steps.length) - 1;
  let shared = 0;
  while (shared < limit && from.steps[shared] === to.steps[shared]) shared += 1;
  const own = (point: PointCfi): string => point.steps.slice(shared).join("") + point.terminal;
  return `epubcfi(${from.base}!${from.steps.slice(0, shared).join("")},${own(from)},${own(to)})`;
}

/** The CFIs of the first and last position of a range CFI; a point CFI is both. */
export function rangeBoundaryCfis(cfi: string): { start: string; end: string } | null {
  const inner = /^epubcfi\((.*)\)$/s.exec(cfi)?.[1];
  if (inner === undefined) return null;
  const halves = splitTopLevel(inner, "!", 2);
  if (halves.length !== 2) return null;
  const [base, path] = halves as [string, string];
  const parts = splitTopLevel(path, ",");
  if (parts.length === 1) return { start: cfi, end: cfi };
  if (parts.length !== 3) return null;
  const [parent, from, to] = parts as [string, string, string];
  return {
    start: `epubcfi(${base}!${parent}${from})`,
    end: `epubcfi(${base}!${parent}${to})`,
  };
}

/** A position inside the range whose end is `endCfi` (the end itself is outside); an element end already is. */
export function insideEndCfi(endCfi: string): string {
  const point = parsePoint(endCfi);
  const offset = point && /^:(\d+)(.*)$/s.exec(point.terminal);
  if (!point || !offset || offset[1] === "0") return endCfi;
  return `epubcfi(${point.base}!${point.steps.join("")}:${Number(offset[1]) - 1}${offset[2]})`;
}

// ---------------------------------------------------------------------------
// Text

export function collapseSpace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** At most `max` UTF-16 units from the start, never ending inside a surrogate pair. */
export function boundedHead(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** At most `max` UTF-16 units from the end, never starting inside a surrogate pair. */
export function boundedTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const first = text.charCodeAt(text.length - max);
  return text.slice(first >= 0xdc00 && first <= 0xdfff ? text.length - max + 1 : text.length - max);
}

/** The bounded text at one edge of a range; `edge` "end" is the tail, "start" the head. */
export function edgeText(range: Range, edge: "start" | "end", max: number): string {
  const text = collapseSpace(range.toString());
  return edge === "start" ? boundedHead(text, max) : boundedTail(text, max);
}

/** What two renderings of the same range must agree on: its text and how many images it holds. */
export function pageSignature(range: Range): string {
  const images = range.cloneContents().querySelectorAll("img").length;
  return `${collapseSpace(range.toString())}\u0000${images}`;
}

// ---------------------------------------------------------------------------
// The screen page being shown by a rendition

export interface Span {
  left: number;
  right: number;
}

/** Whether a box reaches into the span by more than the rounding noise of layout. */
export function overlapsSpan(box: Span, span: Span): boolean {
  return box.right > span.left + 1 && box.left < span.right - 1;
}

export interface VisiblePage {
  contents: ContentsLike;
  /** The DOM range of everything on the screen page: its text and its images. */
  range: Range;
  /** CFI of that range; what a translation is keyed to. */
  cfi: string;
  /** CFI of its first position; what reading progress stores. */
  startCfi: string;
}

export interface PageRead {
  sectionIndex: number;
  /** The first visible position, or epub.js' own start when no range could be built. */
  startCfi: string;
  page: number;
  total: number;
  atStart: boolean;
  atEnd: boolean;
  /** Null when the screen page has neither text nor images, or no stable range could be built. */
  visible: VisiblePage | null;
}

/** The part of the section's iframe that is on screen, in the iframe's own coordinates. */
function visibleSpan(contents: ContentsLike): Span | null {
  const frame = contents.window.frameElement;
  const container = frame?.closest(".epub-container");
  if (!frame || !container) return null;
  const framed = frame.getBoundingClientRect();
  const shown = container.getBoundingClientRect();
  const left = Math.max(shown.left, framed.left) - framed.left;
  const right = Math.min(shown.right, framed.right) - framed.left;
  return right > left ? { left, right } : null;
}

/** epub.js falls back to text of a neighbouring screen page when a column has none; every line box must lie on this one. */
function lineBoxesWithin(range: Range, span: Span): boolean {
  for (const box of range.getClientRects()) {
    if (box.width > 0 && box.height > 0 && !overlapsSpan(box, span)) return false;
  }
  return true;
}

function visibleImages(contents: ContentsLike, span: Span): HTMLImageElement[] {
  return [...contents.document.body.getElementsByTagName("img")].filter((image) => {
    const box = image.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && overlapsSpan(box, span);
  });
}

function visibleRange(
  contents: ContentsLike,
  startCfi: string,
  endCfi: string,
  span: Span,
): VisiblePage | null {
  const document = contents.document;
  const from = contents.range(startCfi);
  const to = contents.range(endCfi);
  let text: Range | null = null;
  if (from && to) {
    text = document.createRange();
    text.setStart(from.startContainer, from.startOffset);
    text.setEnd(to.endContainer, to.endOffset);
    if (text.collapsed || !text.toString().trim() || !lineBoxesWithin(text, span)) text = null;
  }

  const images = visibleImages(contents, span);
  const firstImage = images[0];
  const lastImage = images[images.length - 1];
  const range = document.createRange();
  let first = text ? startCfi : null;
  let last = text ? endCfi : null;
  if (text) {
    range.setStart(text.startContainer, text.startOffset);
    range.setEnd(text.endContainer, text.endOffset);
  }
  const box = (image: HTMLImageElement): Range => {
    const around = document.createRange();
    around.selectNode(image);
    return around;
  };
  if (firstImage && (!text || text.compareBoundaryPoints(Range.START_TO_START, box(firstImage)) > 0)) {
    range.setStartBefore(firstImage);
    first = contents.cfiFromNode(firstImage);
  }
  if (lastImage && (!text || text.compareBoundaryPoints(Range.END_TO_END, box(lastImage)) < 0)) {
    range.setEndAfter(lastImage);
    last = contents.cfiFromNode(lastImage);
  }
  if (first === null || last === null) return null;
  const cfi = joinRangeCfi(first, last);
  return cfi === null ? null : { contents, range, cfi, startCfi: first };
}

/**
 * What a rendition shows right now, read synchronously from the live layout.
 * Null while nothing is displayed; epub.js has no layout to read before that.
 */
export function readPage(rendition: RenditionLike): PageRead | null {
  if (rendition.getContents().length === 0) return null;
  const located = rendition.currentLocation();
  const start = located?.start;
  const end = located?.end;
  if (!located || !start || !end) return null;
  const contents = rendition.getContents().find((entry) => entry.sectionIndex === start.index);
  const span = contents && visibleSpan(contents);
  const visible = contents && span ? visibleRange(contents, start.cfi, end.cfi, span) : null;
  return {
    sectionIndex: start.index,
    startCfi: visible?.startCfi ?? start.cfi,
    page: start.displayed.page,
    total: start.displayed.total,
    atStart: !!located.atStart,
    atEnd: !!located.atEnd,
    visible,
  };
}

/**
 * A selection as a range between text positions. A browser selection may start
 * or end at an element boundary, which a CFI cannot express, so each side moves
 * to the nearest text it actually covers. Null when it covers no text.
 */
export function selectedTextRange(contents: ContentsLike, selection: Range): Range | null {
  const document = contents.document;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const atStart = selection.cloneRange();
  atStart.collapse(true);
  const atEnd = selection.cloneRange();
  atEnd.collapse(false);
  let first: Text | null = null;
  let last: Text | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (!first && text.length > 0 && atStart.comparePoint(text, text.length) > 0) first = text;
    if (text.length > 0 && atEnd.comparePoint(text, 0) < 0) last = text;
  }
  if (!first || !last) return null;
  const range = document.createRange();
  range.setStart(first, first === selection.startContainer ? selection.startOffset : 0);
  range.setEnd(last, last === selection.endContainer ? selection.endOffset : last.length);
  return range.collapsed ? null : range;
}
