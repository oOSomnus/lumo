import type { EpubTocEntry } from "./epub-bridge";
import type { RawTocItem } from "./epub-js";

const MAX_TOC_ENTRIES = 5_000;

/**
 * A nav-document link as a `display()` target relative to the package, which is
 * how the spine names its sections. External and empty links give null.
 */
export function resolveTocHref(navPath: string, href: string): string | null {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  try {
    const url = new URL(href, `https://epub.invalid/${navPath}`);
    const path = decodeURIComponent(url.pathname.slice(1));
    return url.hash ? `${path}#${decodeURIComponent(url.hash.slice(1))}` : path;
  } catch {
    return null;
  }
}

/**
 * The table of contents in reading order, one row per titled item. An untitled
 * item is dropped and its children take its level; a link that does not
 * resolve to a section of this book keeps its title as a group.
 */
export function flattenEpubToc(
  items: readonly RawTocItem[],
  navPath: string,
  sectionIndexOf: (href: string) => number | null,
): EpubTocEntry[] {
  const entries: EpubTocEntry[] = [];
  const visit = (list: readonly RawTocItem[], level: number): void => {
    for (const item of list) {
      if (entries.length >= MAX_TOC_ENTRIES) return;
      const children = item.subitems ?? [];
      const label = item.label?.replace(/\s+/g, " ").trim();
      if (!label) {
        visit(children, level);
        continue;
      }
      const target = item.href ? resolveTocHref(navPath, item.href) : null;
      const index = target === null ? null : sectionIndexOf(target);
      entries.push({
        id: String(entries.length),
        label,
        level,
        href: index === null ? null : target,
        index,
      });
      visit(children, level + 1);
    }
  };
  visit(items, 1);
  return entries;
}
