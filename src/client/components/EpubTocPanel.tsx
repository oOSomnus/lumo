import { useEffect, useMemo, useRef, useState } from "react";
import type { EpubTocEntry } from "../epub-bridge";
import { useI18n } from "../i18n";
import { currentTocId, visibleTocRows } from "../toc";

interface EpubTocPanelProps {
  id: string;
  toc: readonly EpubTocEntry[];
  /** The section being read, to mark the current chapter. */
  sectionIndex: number | null;
  onNavigate: (entry: EpubTocEntry) => void;
  onClose: () => void;
}

/** The book's contents, laid over the reading area so opening it never reflows the book. */
export function EpubTocPanel({
  id,
  toc,
  sectionIndex,
  onNavigate,
  onClose,
}: EpubTocPanelProps) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const rows = useMemo(() => visibleTocRows(toc, collapsed), [toc, collapsed]);
  const currentId = useMemo(
    () => currentTocId(toc, sectionIndex),
    [toc, sectionIndex],
  );
  const panelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const current = panel.querySelector<HTMLElement>('[aria-current="location"]');
    const target =
      current ??
      panel.querySelector<HTMLElement>("button.outline-title:not(:disabled)") ??
      panel.querySelector<HTMLElement>(".epub-toc-close");
    target?.focus();
    current?.scrollIntoView({ block: "center" });
    // Only the first paint chooses where focus lands.
  }, []);

  const toggle = (entryId: string): void => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  };

  return (
    <nav
      ref={panelRef}
      id={id}
      className="epub-toc"
      aria-label={t.epub.contentsTitle}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <div className="epub-toc-header">
        <h2>{t.epub.contentsTitle}</h2>
        <button type="button" className="epub-toc-close" onClick={onClose}>
          {t.epub.closeContents}
        </button>
      </div>
      {toc.length === 0 ? (
        <p className="muted epub-toc-empty">{t.epub.noContents}</p>
      ) : (
        <ul className="outline-tree epub-toc-tree">
          {rows.map(({ entry, hasChildren }) => (
            <li
              key={entry.id}
              aria-level={entry.level}
              style={{
                marginInlineStart: `min(${(entry.level - 1) * 16}px, 30%)`,
              }}
            >
              <div className="outline-row">
                {hasChildren ? (
                  <button
                    type="button"
                    className="outline-toggle"
                    aria-expanded={!collapsed.has(entry.id)}
                    aria-label={t.epub.toggleGroup(entry.label)}
                    onClick={() => toggle(entry.id)}
                  >
                    {collapsed.has(entry.id) ? "▸" : "▾"}
                  </button>
                ) : (
                  <span className="outline-toggle-spacer" aria-hidden="true" />
                )}
                <button
                  type="button"
                  className="outline-title"
                  disabled={entry.href === null && !hasChildren}
                  aria-current={entry.id === currentId ? "location" : undefined}
                  onClick={() =>
                    entry.href === null ? toggle(entry.id) : onNavigate(entry)
                  }
                >
                  {entry.label}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
