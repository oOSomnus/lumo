import { useEffect, useMemo, useState } from "react";
import type { DocumentRecord } from "../../shared/contracts";
import { errorText, toUiError, useI18n, type UiError } from "../i18n";
import {
  buildOutlineRanges,
  buildOutlineRows,
  type DocumentOutlineState,
  type OutlineRange,
} from "../outline";
import { parsePageSelection } from "../page-selection";
import type { TranslatedPages } from "../translated-pages";

interface PageSelectorProps {
  /** Prefixes element ids and the radio group name, so two selectors can coexist. */
  idPrefix: string;
  document: DocumentRecord;
  pageCount: number;
  currentPage: number;
  selection: ReadonlySet<number>;
  onSelectionChange: (pages: Set<number>) => void;
  translated: Pick<TranslatedPages, "status" | "error" | "savedPages" | "issuePages" | "reload">;
  /** The third quick-selection button, after the current and all pages. */
  quickSelect: { label: string; disabled: boolean; run: () => void };
  outline: DocumentOutlineState;
  outlineGenerationDisabledReason: string | null;
  onGenerateOutline: () => void;
  onCancelOutline: () => void;
  onReloadOutline: () => void;
  onRetrySaveOutline: () => void;
  onDiscardOutline: () => void;
  onOpenOutlinePage: (pageNumber: number) => void;
  /** The step that makes generating an outline possible, while the AI is not ready. */
  aiStep: { label: string; run: () => void } | null;
  aiChecking: boolean;
}

const PAGE_GROUP_SIZE = 100;

/**
 * Chooses pages (or EPUB sections) by outline range or by number, with the
 * translated and busy pages marked. PDFs start on numbers, books on the outline;
 * both methods edit the same selection.
 */
export function PageSelector({
  idPrefix: id,
  document,
  pageCount,
  currentPage,
  selection,
  onSelectionChange,
  translated,
  quickSelect,
  outline,
  outlineGenerationDisabledReason,
  onGenerateOutline,
  onCancelOutline,
  onReloadOutline,
  onRetrySaveOutline,
  onDiscardOutline,
  onOpenOutlinePage,
  aiStep,
  aiChecking,
}: PageSelectorProps) {
  const { locale, t } = useI18n();
  const isEpub = document.format === "epub";
  const copy = isEpub
    ? {
        select: t.batch.epub.selectSections,
        expression: t.batch.epub.expression,
        current: t.batch.epub.currentSection,
        all: t.batch.epub.allSections,
        range: t.batch.epub.sectionRange,
        checkboxes: t.batch.epub.sectionCheckboxes,
        marker: t.batch.epub.markerTranslated,
        outlineRange: t.outline.sectionRange,
        selectOutlineRange: t.outline.selectSectionRange,
      }
    : {
        select: t.batch.selectPages,
        expression: t.batch.expression,
        current: t.batch.currentPage,
        all: t.batch.allPages,
        range: t.batch.pageRange,
        checkboxes: t.batch.pageCheckboxes,
        marker: t.batch.markerTranslated,
        outlineRange: t.outline.pageRange,
        selectOutlineRange: t.outline.selectRange,
      };
  const [expression, setExpression] = useState("");
  const [expressionError, setExpressionError] = useState<UiError | null>(null);
  const [groupIndex, setGroupIndex] = useState(0);
  const [selectionMethod, setSelectionMethod] = useState<"outline" | "numbers">(
    isEpub ? "outline" : "numbers",
  );
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  useEffect(() => {
    setExpression("");
    setExpressionError(null);
    setGroupIndex(0);
    setCollapsed(new Set());
    setSelectionMethod(isEpub ? "outline" : "numbers");
  }, [document.id]);

  const outlineRanges = useMemo(
    () =>
      outline.entries.length > 0 && pageCount > 0
        ? buildOutlineRanges(outline.entries, pageCount)
        : [],
    [outline.entries, pageCount],
  );

  const outlineRows = useMemo(
    () => buildOutlineRows(outlineRanges, collapsed, selection, pageCount),
    [outlineRanges, collapsed, selection, pageCount],
  );

  const toggleOutlineRange = (range: OutlineRange, selected: boolean): void => {
    const next = new Set(selection);
    for (let page = range.pageNumber; page <= range.endPage; page += 1) {
      if (selected) next.delete(page);
      else next.add(page);
    }
    onSelectionChange(next);
  };

  const toggleCollapsed = (index: number): void => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const togglePage = (page: number): void => {
    const next = new Set(selection);
    if (next.has(page)) next.delete(page);
    else next.add(page);
    onSelectionChange(next);
  };

  const applyExpression = (): void => {
    try {
      onSelectionChange(new Set(parsePageSelection(expression, pageCount)));
      setExpressionError(null);
    } catch (error) {
      setExpressionError(toUiError(error));
    }
  };

  const firstGroupPage = groupIndex * PAGE_GROUP_SIZE + 1;
  const lastGroupPage = Math.min(pageCount, firstGroupPage + PAGE_GROUP_SIZE - 1);
  const groupCount = Math.max(1, Math.ceil(pageCount / PAGE_GROUP_SIZE));
  const { savedPages, issuePages } = translated;

  return (
    <>
      <fieldset className="batch-method">
        <legend>{t.batch.method.legend}</legend>
        <label className="radio-row">
          <input
            type="radio"
            name={`${id}-method`}
            checked={selectionMethod === "outline"}
            onChange={() => setSelectionMethod("outline")}
          />
          {t.batch.method.outline}
        </label>
        <label className="radio-row">
          <input
            type="radio"
            name={`${id}-method`}
            checked={selectionMethod === "numbers"}
            onChange={() => setSelectionMethod("numbers")}
          />
          {isEpub ? t.batch.method.sections : t.batch.method.pages}
        </label>
      </fieldset>

      {selectionMethod === "outline" && (
      <section
        className="batch-outline"
        aria-labelledby={`${id}-outline-title`}
      >
        <h3 id={`${id}-outline-title`}>{t.outline.sectionTitle}</h3>
        {outline.loadStatus === "loading" && (
          <p className="muted">{t.outline.loading}</p>
        )}
        {outline.loadStatus === "error" && (
          <div className="inline-error" role="alert">
            {t.outline.loadFailed(
              errorText(outline.error ?? { code: "UNKNOWN" }, locale),
            )}
            <button type="button" onClick={onReloadOutline}>
              {t.outline.reload}
            </button>
          </div>
        )}
        {outline.loadStatus === "ready" && (
          <>
            {outline.stage === "generating" && (
              <div className="outline-progress">
                <p aria-live="polite">
                  {t.outline.generating(outline.processedPages, pageCount)}
                </p>
                <button type="button" onClick={onCancelOutline}>
                  {t.outline.cancelGeneration}
                </button>
              </div>
            )}
            {outline.stage === "saving" && (
              <p className="muted" aria-live="polite">
                {t.outline.saving}
              </p>
            )}
            {outline.stage === "unsaved" && (
              <div className="inline-error" role="alert">
                <strong>{t.outline.unsavedTitle}</strong>
                <p>{t.outline.unsavedBody}</p>
                {outline.error && (
                  <p>{errorText(outline.error, locale)}</p>
                )}
                <div className="inline-actions">
                  <button type="button" onClick={onRetrySaveOutline}>
                    {t.outline.retrySave}
                  </button>
                  <button type="button" onClick={onDiscardOutline}>
                    {t.outline.discard}
                  </button>
                </div>
              </div>
            )}
            {outline.entries.length > 0 && (
              <>
                <div className="outline-meta">
                  <span>
                    {outline.source === "native"
                      ? t.outline.sourceNative
                      : t.outline.sourceGenerated}
                  </span>
                  {outline.skipped > 0 && (
                    <span>{t.outline.skipped(outline.skipped)}</span>
                  )}
                </div>
                {outlineRows.length > 0 && (
                  <ul className="outline-tree">
                    {outlineRows.map(
                      ({ index, range, hasChildren, checked, indeterminate }) => {
                        const isCollapsed = collapsed.has(index);
                        return (
                          <li
                            key={index}
                            aria-level={range.level}
                            style={{
                              marginInlineStart: `min(${(range.level - 1) * 16}px, 30%)`,
                            }}
                          >
                            <div className="outline-row">
                              {hasChildren ? (
                                <button
                                  type="button"
                                  className="outline-toggle"
                                  aria-expanded={!isCollapsed}
                                  aria-label={t.outline.toggle(range.title)}
                                  onClick={() => toggleCollapsed(index)}
                                >
                                  {isCollapsed ? "▸" : "▾"}
                                </button>
                              ) : (
                                <span
                                  className="outline-toggle-spacer"
                                  aria-hidden="true"
                                />
                              )}
                              <input
                                type="checkbox"
                                checked={checked}
                                aria-label={copy.selectOutlineRange(
                                  range.pageNumber,
                                  range.endPage,
                                )}
                                ref={(element) => {
                                  if (element) {
                                    element.indeterminate = indeterminate;
                                  }
                                }}
                                onChange={() =>
                                  toggleOutlineRange(range, checked)
                                }
                              />
                              <button
                                type="button"
                                className="outline-title"
                                onClick={() =>
                                  onOpenOutlinePage(range.pageNumber)
                                }
                              >
                                {range.title}
                              </button>
                              <span className="outline-pages">
                                {copy.outlineRange(
                                  range.pageNumber,
                                  range.endPage,
                                )}
                              </span>
                            </div>
                          </li>
                        );
                      },
                    )}
                  </ul>
                )}
                <p className="outline-note">
                  {isEpub ? t.outline.noteEpub : t.outline.note}
                </p>
              </>
            )}
            {!isEpub && outline.entries.length === 0 && outline.stage === "idle" && (
              <>
                {outline.error && (
                  <p className="field-error" role="alert">
                    {errorText(outline.error, locale)}
                  </p>
                )}
                <p className="muted">{t.outline.generateBody(pageCount)}</p>
                <button
                  type="button"
                  disabled={
                    aiStep ? false : Boolean(outlineGenerationDisabledReason) || aiChecking
                  }
                  onClick={aiStep?.run ?? onGenerateOutline}
                >
                  {aiStep?.label ??
                    (outline.error ? t.outline.retryGenerate : t.outline.generate)}
                </button>
                {outlineGenerationDisabledReason && (
                  <p className="muted">
                    {outlineGenerationDisabledReason}
                  </p>
                )}
              </>
            )}
            {isEpub && outline.entries.length === 0 && (
              <>
                <p className="muted">{t.epub.noContents}</p>
                <button type="button" onClick={() => setSelectionMethod("numbers")}>
                  {t.batch.method.useSections}
                </button>
              </>
            )}
          </>
        )}
      </section>
      )}

      {selectionMethod === "numbers" && (
      <section className="batch-selector" aria-labelledby={`${id}-selector-title`}>
        <h3 id={`${id}-selector-title`}>{copy.select}</h3>
        {isEpub && <p className="outline-note">{t.batch.epub.note}</p>}
        <div className="inline-form">
          <label className="sr-only" htmlFor={`${id}-expression`}>
            {copy.expression}
          </label>
          <input
            id={`${id}-expression`}
            value={expression}
            placeholder={t.batch.expressionPlaceholder}
            onChange={(event) => setExpression(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                applyExpression();
              }
            }}
          />
          <button type="button" onClick={applyExpression}>
            {t.batch.apply}
          </button>
        </div>
        {expressionError && (
          <p className="field-error" role="alert">
            {errorText(expressionError, locale)}
          </p>
        )}

        <div className="selection-actions">
          <button
            type="button"
            onClick={() => onSelectionChange(new Set([currentPage]))}
          >
            {copy.current}
          </button>
          <button
            type="button"
            onClick={() =>
              onSelectionChange(
                new Set(
                  Array.from({ length: pageCount }, (_, index) => index + 1),
                ),
              )
            }
          >
            {copy.all}
          </button>
          <button
            type="button"
            disabled={quickSelect.disabled}
            onClick={quickSelect.run}
          >
            {quickSelect.label}
          </button>
          <button type="button" onClick={() => onSelectionChange(new Set())}>
            {t.batch.clear}
          </button>
        </div>

        {translated.status === "error" && (
          <div className="inline-error" role="alert">
            {t.batch.readTranslatedFailed(
              errorText(translated.error ?? { code: "UNKNOWN" }, locale),
            )}
            <button type="button" onClick={translated.reload}>
              {t.common.retry}
            </button>
          </div>
        )}

        <div className="page-group-nav">
          <button
            type="button"
            disabled={groupIndex === 0}
            onClick={() => setGroupIndex((value) => Math.max(0, value - 1))}
          >
            {t.batch.previousGroup}
          </button>
          <span>{copy.range(firstGroupPage, lastGroupPage, pageCount)}</span>
          <button
            type="button"
            disabled={groupIndex >= groupCount - 1}
            onClick={() => setGroupIndex((value) => value + 1)}
          >
            {t.batch.nextGroup}
          </button>
        </div>

        <div
          className="page-checkboxes"
          role="group"
          aria-label={copy.checkboxes}
        >
          {Array.from(
            { length: Math.max(0, lastGroupPage - firstGroupPage + 1) },
            (_, index) => firstGroupPage + index,
          ).map((page) => (
            <label key={page} className="page-checkbox">
              <input
                type="checkbox"
                checked={selection.has(page)}
                onChange={() => togglePage(page)}
              />
              <span>{page}</span>
              {translated.status === "ready" && savedPages.has(page) && (
                <span
                  className="page-marker"
                  title={copy.marker}
                >
                  {copy.marker}
                </span>
              )}
              {issuePages.has(page) && (
                <span className="page-marker task" title={t.batch.markerTask}>
                  {t.batch.markerTask}
                </span>
              )}
            </label>
          ))}
        </div>
      </section>
      )}
    </>
  );
}
