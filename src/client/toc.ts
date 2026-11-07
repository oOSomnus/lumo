import {
  MAX_OUTLINE_ENTRIES,
  MAX_OUTLINE_TITLE_CHARS,
  type OutlineEntry,
} from "../shared/contracts";
import type { EpubTocEntry } from "./epub-bridge";

export interface TocRow {
  entry: EpubTocEntry;
  hasChildren: boolean;
}

/** The contents rows to show; a collapsed group hides all its descendants. */
export function visibleTocRows(
  toc: readonly EpubTocEntry[],
  collapsed: ReadonlySet<string>,
): TocRow[] {
  const rows: TocRow[] = [];
  let hiddenBelowLevel = 0;
  for (let index = 0; index < toc.length; index += 1) {
    const entry = toc[index]!;
    if (hiddenBelowLevel > 0) {
      if (entry.level > hiddenBelowLevel) continue;
      hiddenBelowLevel = 0;
    }
    const hasChildren = (toc[index + 1]?.level ?? 0) > entry.level;
    rows.push({ entry, hasChildren });
    if (hasChildren && collapsed.has(entry.id)) hiddenBelowLevel = entry.level;
  }
  return rows;
}

/**
 * The entry whose chapter contains the section being read: the first entry that
 * points at it, else the last entry before it. Fragments inside one chapter are
 * not told apart because only the section is known here.
 */
export function currentTocId(
  toc: readonly EpubTocEntry[],
  sectionIndex: number | null,
): string | null {
  if (sectionIndex === null) return null;
  let before: string | null = null;
  for (const entry of toc) {
    if (entry.index === null) continue;
    if (entry.index === sectionIndex) return entry.id;
    if (entry.index < sectionIndex) before = entry.id;
  }
  return before;
}

/**
 * A valid whole-section outline for batch selection (page = spine index + 1).
 * A group without a link takes the section of its first linked descendant;
 * entries that point nowhere or have no title are dropped; levels never skip
 * and pages never decrease, which is what the outline schema requires.
 */
export function outlineFromEpubToc(
  toc: readonly EpubTocEntry[],
  sectionCount: number,
): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  let previousLevel = 0;
  let previousPage = 1;
  for (let index = 0; index < toc.length; index += 1) {
    const entry = toc[index]!;
    const title = entry.label.replaceAll("\u0000", "").trim().slice(0, MAX_OUTLINE_TITLE_CHARS).trim();
    if (!title) continue;
    let target = entry.index;
    for (
      let child = index + 1;
      target === null && child < toc.length && toc[child]!.level > entry.level;
      child += 1
    ) {
      target = toc[child]!.index;
    }
    if (target === null || target < 0 || target >= sectionCount) continue;
    const level = Math.min(Math.max(entry.level, 1), previousLevel + 1);
    const pageNumber = Math.max(target + 1, previousPage);
    entries.push({ title, level, pageNumber });
    previousLevel = level;
    previousPage = pageNumber;
    if (entries.length === MAX_OUTLINE_ENTRIES) break;
  }
  return entries;
}
