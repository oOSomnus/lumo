import type { DocumentRecord, UiLocale } from "../shared/contracts";

// How the library is arranged on screen: search, sort, grid or list, and the small
// client-only preferences that remember those choices. Nothing here is a setting the
// server needs, so it lives in localStorage and a bad stored value falls back to defaults.

export const LIBRARY_SORTS = ["recent", "title", "added"] as const;
export type LibrarySort = (typeof LIBRARY_SORTS)[number];

export const LIBRARY_VIEWS = ["grid", "list"] as const;
export type LibraryView = (typeof LIBRARY_VIEWS)[number];

export interface LibraryPrefs {
  sort: LibrarySort;
  view: LibraryView;
}

export const DEFAULT_LIBRARY_PREFS: LibraryPrefs = { sort: "recent", view: "grid" };

const LIBRARY_PREFS_KEY = "lumo.library";
const SIDEBAR_KEY = "lumo.sidebar";

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

/** Reads stored library preferences; anything missing or malformed takes its default. */
export function parseLibraryPrefs(raw: string | null): LibraryPrefs {
  if (!raw) return DEFAULT_LIBRARY_PREFS;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return DEFAULT_LIBRARY_PREFS;
  }
  if (typeof value !== "object" || value === null) return DEFAULT_LIBRARY_PREFS;
  const record = value as Record<string, unknown>;
  return {
    sort: oneOf(LIBRARY_SORTS, record.sort) ? record.sort : DEFAULT_LIBRARY_PREFS.sort,
    view: oneOf(LIBRARY_VIEWS, record.view) ? record.view : DEFAULT_LIBRARY_PREFS.view,
  };
}

/** Whether the sidebar was left collapsed; `null` when nothing valid is stored. */
export function parseSidebarCollapsed(raw: string | null): boolean | null {
  if (raw === "collapsed") return true;
  if (raw === "expanded") return false;
  return null;
}

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Storage can be full or disabled; the preference then only lasts for this page. */
function writeStorage(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Ignored: the choice still applies until the page reloads.
  }
}

export function loadLibraryPrefs(): LibraryPrefs {
  return parseLibraryPrefs(readStorage(LIBRARY_PREFS_KEY));
}

export function saveLibraryPrefs(prefs: LibraryPrefs): void {
  writeStorage(LIBRARY_PREFS_KEY, JSON.stringify(prefs));
}

export function loadSidebarCollapsed(): boolean | null {
  return parseSidebarCollapsed(readStorage(SIDEBAR_KEY));
}

export function saveSidebarCollapsed(collapsed: boolean): void {
  writeStorage(SIDEBAR_KEY, collapsed ? "collapsed" : "expanded");
}

function searchable(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase();
}

/** The documents a search shows, in the chosen order; the input is left as it is. */
export function arrangeDocuments(
  documents: readonly DocumentRecord[],
  query: string,
  sort: LibrarySort,
  locale: UiLocale,
): DocumentRecord[] {
  const needle = searchable(query.trim());
  const shown = needle
    ? documents.filter((document) => searchable(document.name).includes(needle))
    : [...documents];
  if (sort === "title") {
    const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
    return shown.sort((a, b) => collator.compare(a.name, b.name) || b.lastOpenedAt - a.lastOpenedAt);
  }
  const key = sort === "added" ? "createdAt" : "lastOpenedAt";
  return shown.sort((a, b) => b[key] - a[key] || a.name.localeCompare(b.name));
}

/** How far through the book the reader is, from 0 on the first page to 1 on the last. */
export function readingProgress(currentPage: number, pageCount: number): number {
  if (!(pageCount > 1) || !(currentPage > 1)) return 0;
  return Math.min(1, (currentPage - 1) / (pageCount - 1));
}

const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** "2 days ago", "yesterday", "now": a past or future instant relative to `now`. */
export function relativeTime(locale: UiLocale, at: number, now: number): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const seconds = (at - now) / 1000;
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(0, "second");
}
