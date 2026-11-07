import type { EpubReaderView } from "./contracts";

/** The reader settings that change how an EPUB is paginated. */
export type EpubReaderStyle = Pick<
  EpubReaderView,
  "fontSize" | "fontFamily" | "lineHeight" | "theme"
>;

/**
 * The viewport and reading settings a page was laid out with. It is local to
 * the browser: it is never stored and never sent to the server.
 */
export interface EpubLayoutSnapshot {
  width: number;
  height: number;
  style: EpubReaderStyle;
}

/** Just the four reading settings of a stored view, which also carries a position. */
export function epubStyleOf(view: EpubReaderStyle): EpubReaderStyle {
  return {
    fontSize: view.fontSize,
    fontFamily: view.fontFamily,
    lineHeight: view.lineHeight,
    theme: view.theme,
  };
}

export type EpubUnitKind = "page" | "selection";

const UNIT_PREFIX: Record<EpubUnitKind, string> = {
  page: "page",
  selection: "sel",
};

function hex(bytes: ArrayBuffer): string {
  let out = "";
  for (const value of new Uint8Array(bytes)) out += value.toString(16).padStart(2, "0");
  return out;
}

/**
 * The translation unit of an EPUB range: `page-<64 hex>` or `sel-<64 hex>`,
 * the SHA-256 of `${kind}\n${sourceCfi}`. The same range always has the same
 * identity; a different range never shares it.
 */
export async function epubTranslationUnit(
  kind: EpubUnitKind,
  sourceCfi: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${kind}\n${sourceCfi}`),
  );
  return `${UNIT_PREFIX[kind]}-${hex(digest)}`;
}

/** True when `unit` is the identity `epubTranslationUnit` gives this range. */
export async function isEpubUnitOf(
  unit: string,
  sourceCfi: string,
): Promise<boolean> {
  const kind: EpubUnitKind | null = unit.startsWith("page-")
    ? "page"
    : unit.startsWith("sel-")
      ? "selection"
      : null;
  return kind !== null && unit === (await epubTranslationUnit(kind, sourceCfi));
}

/** A whole-page unit counts toward page completion; a selection never does. */
export function isEpubPageUnit(unit: string): boolean {
  return unit.startsWith("page-");
}

/** Where a CFI starts: its element steps and the character offset in the last node. */
function cfiStart(cfi: string): { steps: number[]; offset: number } {
  // A range is `parent,start,end`, so its start is parent + start; `[id]` assertions are dropped.
  const [parent = "", start = ""] = cfi.replace(/^epubcfi\(|\)$/g, "").split(",");
  const [path = "", offset] = (parent + start).replace(/\[[^\]]*\]/g, "").split(":");
  return {
    steps: [...path.matchAll(/\/(\d+)/g)].map((step) => Number(step[1])),
    offset: Number(offset ?? 0),
  };
}

/** Orders CFIs of one book by where they start (document order); equal starts compare equal. */
export function compareEpubCfi(a: string, b: string): number {
  const first = cfiStart(a);
  const second = cfiStart(b);
  const shared = Math.min(first.steps.length, second.steps.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = first.steps[index]! - second.steps[index]!;
    if (difference !== 0) return difference;
  }
  return first.steps.length - second.steps.length || first.offset - second.offset;
}
