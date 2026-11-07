import { useEffect, useMemo, useState } from "react";
import {
  TARGET_LANGUAGE_LABELS,
  type DocumentRecord,
  type TargetLanguage,
  type TranslationLocationSummary,
} from "../../shared/contracts";
import { isEpubPageUnit } from "../../shared/epub";
import { apiJson } from "../api";
import { isOpenTask, type EpubBatchState } from "../epub-batch";
import { errorText, toUiError, useI18n, type UiError } from "../i18n";
import {
  buildOutlineRanges,
  buildOutlineRows,
  type DocumentOutlineState,
  type OutlineRange,
} from "../outline";
import { parsePageSelection } from "../page-selection";
import {
  hasRetainedDraft,
  isActiveStage,
  type TranslationQueue,
  type TranslationTask,
} from "../translation-queue";
import { TypstRepairSummary } from "./TypstRepairPanel";

interface BatchTranslationPanelProps {
  document: DocumentRecord;
  pageCount: number;
  currentPage: number;
  language: TargetLanguage;
  onLanguageChange: (language: TargetLanguage) => void;
  tasks: TranslationTask[];
  queue: TranslationQueue;
  onOpenTaskPage: (task: TranslationTask) => void;
  onConfirm: (options: {
    title: string;
    body: string;
    confirmLabel: string;
  }) => Promise<boolean>;
  disabledReason?: string | null;
  selection: Set<number>;
  onSelectionChange: (pages: Set<number>) => void;
  outline: DocumentOutlineState;
  outlineGenerationDisabledReason: string | null;
  onGenerateOutline: () => void;
  onCancelOutline: () => void;
  onReloadOutline: () => void;
  onRetrySaveOutline: () => void;
  onDiscardOutline: () => void;
  onOpenOutlinePage: (pageNumber: number) => void;
  epubBatch: EpubBatchState;
  onStartEpubBatch: (options: {
    sections: readonly number[];
    retranslate: boolean;
    saved: ReadonlySet<string>;
  }) => void;
  /** Ticks the EPUB sections that still have an untranslated screen page; needs the pages located first. */
  onSelectUntranslatedEpub: (saved: ReadonlySet<string>) => void;
  onStopAll: () => void;
}

const PAGE_GROUP_SIZE = 100;
const NO_LOCATIONS: TranslationLocationSummary[] = [];

export function BatchTranslationPanel({
  document,
  pageCount,
  currentPage,
  language,
  onLanguageChange,
  tasks,
  queue,
  onOpenTaskPage,
  onConfirm,
  disabledReason,
  selection,
  onSelectionChange,
  outline,
  outlineGenerationDisabledReason,
  onGenerateOutline,
  onCancelOutline,
  onReloadOutline,
  onRetrySaveOutline,
  onDiscardOutline,
  onOpenOutlinePage,
  epubBatch,
  onStartEpubBatch,
  onSelectUntranslatedEpub,
  onStopAll,
}: BatchTranslationPanelProps) {
  const { locale, t } = useI18n();
  const isEpub = document.format === "epub";
  const pageTasks = useMemo(
    () =>
      tasks.filter((task) =>
        isEpub ? isEpubPageUnit(task.unit ?? "") : !task.unit,
      ),
    [tasks, isEpub],
  );
  const copy = isEpub
    ? {
        select: t.batch.epub.selectSections,
        expression: t.batch.epub.expression,
        current: t.batch.epub.currentSection,
        all: t.batch.epub.allSections,
        untranslated: t.batch.epub.untranslatedSections,
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
        untranslated: t.batch.untranslatedPages,
        range: t.batch.pageRange,
        checkboxes: t.batch.pageCheckboxes,
        marker: t.batch.markerTranslated,
        outlineRange: t.outline.pageRange,
        selectOutlineRange: t.outline.selectRange,
      };
  const [expression, setExpression] = useState("");
  const [expressionError, setExpressionError] = useState<UiError | null>(null);
  const [groupIndex, setGroupIndex] = useState(0);
  const [retranslate, setRetranslate] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [translated, setTranslated] = useState<{
    key: string;
    status: "loading" | "ready" | "error";
    locations: TranslationLocationSummary[];
    message?: UiError;
  }>({ key: "", status: "loading", locations: NO_LOCATIONS });
  const [reloadToken, setReloadToken] = useState(0);

  const translatedKey = `${document.id}/${language}`;

  useEffect(() => {
    setExpression("");
    setExpressionError(null);
    setGroupIndex(0);
    setRetranslate(false);
    setCollapsed(new Set());
  }, [document.id]);

  useEffect(() => {
    const controller = new AbortController();
    setTranslated((previous) =>
      previous.key === translatedKey
        ? previous
        : { key: translatedKey, status: "loading", locations: NO_LOCATIONS },
    );
    void apiJson<{ locations: TranslationLocationSummary[] }>(
      `/api/documents/${document.id}/translation-locations?targetLanguage=${language}`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        setTranslated({
          key: translatedKey,
          status: "ready",
          locations: result.locations,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setTranslated({
          key: translatedKey,
          status: "error",
          locations: NO_LOCATIONS,
          message: toUiError(error),
        });
      });
    return () => controller.abort();
  }, [document.id, language, translatedKey, reloadToken]);

  const activeTranslated =
    translated.key === translatedKey
      ? translated
      : {
          status: "loading" as const,
          locations: NO_LOCATIONS,
          message: undefined,
        };

  // A PDF page or an EPUB screen page counts as translated; an EPUB selection never does.
  const { savedPages, savedUnits } = useMemo(() => {
    const pages = new Set<number>();
    const units = new Set<string>();
    const add = (pageNumber: number, unit: string): void => {
      pages.add(pageNumber);
      if (unit) units.add(`${pageNumber}/${unit}`);
    };
    for (const location of activeTranslated.locations) {
      if (isEpub ? isEpubPageUnit(location.unit) : location.unit === "") {
        add(location.pageNumber, location.unit);
      }
    }
    for (const task of pageTasks) {
      if (
        task.documentId === document.id &&
        task.targetLanguage === language &&
        task.stage === "saved"
      ) {
        add(task.pageNumber, task.unit ?? "");
      }
    }
    return { savedPages: pages, savedUnits: units };
  }, [activeTranslated.locations, pageTasks, document.id, language, isEpub]);

  const issuePages = useMemo(() => {
    const pages = new Set<number>();
    for (const task of pageTasks) {
      if (
        task.documentId === document.id &&
        task.targetLanguage === language &&
        isOpenTask(task)
      ) {
        pages.add(task.pageNumber);
      }
    }
    return pages;
  }, [pageTasks, document.id, language]);

  const selectedPages = useMemo(
    () => [...selection].sort((a, b) => a - b),
    [selection],
  );

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

  const toggleOutlineRange = (
    range: OutlineRange,
    selected: boolean,
  ): void => {
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

  // An EPUB section is split into screen pages when the batch starts, and every page then
  // decides for itself whether it is skipped; a PDF page is decided here.
  const candidatePages = useMemo(
    () =>
      isEpub
        ? selectedPages
        : selectedPages.filter((page) => {
            if (issuePages.has(page)) return false;
            if (!retranslate && savedPages.has(page)) return false;
            return true;
          }),
    [isEpub, selectedPages, issuePages, savedPages, retranslate],
  );

  const retranslatePages = useMemo(
    () => candidatePages.filter((page) => savedPages.has(page)).length,
    [candidatePages, savedPages],
  );

  const documentTasks = useMemo(
    () =>
      pageTasks.filter(
        (task) => task.documentId === document.id,
      ),
    [pageTasks, document.id],
  );

  const languageTasks = documentTasks.filter(
    (task) => task.targetLanguage === language,
  );
  const finished = languageTasks.filter((task) => task.stage === "saved").length;
  const active = languageTasks.filter((task) =>
    ["preparing", "generating", "repairing", "validating", "saving"].includes(
      task.stage,
    ),
  ).length;
  const queued = languageTasks.filter((task) => task.stage === "queued").length;
  const failed = languageTasks.filter(
    (task) => task.stage === "error" || hasRetainedDraft(task),
  ).length;

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

  const startBatch = async (): Promise<void> => {
    if (candidatePages.length === 0) return;
    if (isEpub) {
      onStartEpubBatch({
        sections: candidatePages,
        retranslate,
        saved: savedUnits,
      });
      return;
    }
    if (retranslatePages > 0) {
      const confirmed = await onConfirm({
        title: t.confirm.retranslateSavedTitle,
        body: t.confirm.retranslateSavedBody(retranslatePages),
        confirmLabel: t.confirm.retranslateSavedConfirm,
      });
      if (!confirmed) return;
    }
    queue.resume();
    for (const pageNumber of candidatePages) {
      queue.enqueue({
        documentId: document.id,
        pageNumber,
        targetLanguage: language,
        force: retranslate,
        priority: "batch",
      });
    }
  };

  const firstGroupPage = groupIndex * PAGE_GROUP_SIZE + 1;
  const lastGroupPage = Math.min(pageCount, firstGroupPage + PAGE_GROUP_SIZE - 1);
  const groupCount = Math.max(1, Math.ceil(pageCount / PAGE_GROUP_SIZE));

  return (
    <div className="batch-panel">
      <div className="batch-language">
        <label>
          {t.batch.targetLanguage}
          <select
            value={language}
            onChange={(event) =>
              onLanguageChange(event.target.value as TargetLanguage)
            }
          >
            {Object.entries(TARGET_LANGUAGE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <section
        className="batch-outline"
        aria-labelledby="batch-outline-title"
      >
        <h3 id="batch-outline-title">{t.outline.sectionTitle}</h3>
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
                  {document.format === "epub"
                    ? t.outline.noteEpub
                    : t.outline.note}
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
                <button
                  type="button"
                  disabled={Boolean(outlineGenerationDisabledReason)}
                  onClick={onGenerateOutline}
                >
                  {outline.error
                    ? t.outline.retryGenerate
                    : t.outline.generate}
                </button>
                {outlineGenerationDisabledReason && (
                  <p className="muted">
                    {outlineGenerationDisabledReason}
                  </p>
                )}
              </>
            )}
            {isEpub && outline.entries.length === 0 && (
              <p className="muted">{t.epub.noContents}</p>
            )}
          </>
        )}
      </section>

      <section className="batch-selector" aria-labelledby="batch-selector-title">
        <h3 id="batch-selector-title">{copy.select}</h3>
        {isEpub && <p className="outline-note">{t.batch.epub.note}</p>}
        <div className="inline-form">
          <label className="sr-only" htmlFor="batch-expression">
            {copy.expression}
          </label>
          <input
            id="batch-expression"
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
            disabled={
              activeTranslated.status !== "ready" ||
              (isEpub && (Boolean(disabledReason) || epubBatch.status === "running"))
            }
            onClick={() =>
              isEpub
                ? onSelectUntranslatedEpub(savedUnits)
                : onSelectionChange(
                    new Set(
                      Array.from({ length: pageCount }, (_, index) => index + 1).filter(
                        (page) => !savedPages.has(page),
                      ),
                    ),
                  )
            }
          >
            {copy.untranslated}
          </button>
          <button type="button" onClick={() => onSelectionChange(new Set())}>
            {t.batch.clear}
          </button>
        </div>

        {activeTranslated.status === "error" && (
          <div className="inline-error" role="alert">
            {t.batch.readTranslatedFailed(
              errorText(activeTranslated.message ?? { code: "UNKNOWN" }, locale),
            )}
            <button type="button" onClick={() => setReloadToken((value) => value + 1)}>
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
              {activeTranslated.status === "ready" && savedPages.has(page) && (
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

      <section className="batch-summary">
        <p>
          {isEpub
            ? t.batch.epub.summary(
                selectedPages.length,
                savedPages.size,
                issuePages.size,
              )
            : t.batch.summary(
                selectedPages.length,
                savedPages.size,
                issuePages.size,
                candidatePages.length,
              )}
        </p>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={retranslate}
            onChange={(event) => setRetranslate(event.target.checked)}
          />
          {t.batch.retranslateSaved}
        </label>
        {disabledReason && (
          <p className="field-error" role="alert">
            {disabledReason}
          </p>
        )}
        {!isEpub &&
          !disabledReason &&
          candidatePages.length === 0 &&
          selectedPages.length > 0 && (
            <p className="muted">{t.batch.allCovered}</p>
          )}
        {queue.halt && (
          <div className="inline-error" role="alert">
            {errorText(
              {
                code: queue.halt.code,
                detail: queue.halt.detail,
                params: queue.halt.params,
              },
              locale,
            )}{" "}
            ({queue.halt.code})
            <button type="button" onClick={() => queue.resume()}>
              {t.batch.resumeQueue}
            </button>
          </div>
        )}
        <div className="batch-start">
          <button
            type="button"
            className="primary"
            disabled={
              candidatePages.length === 0 ||
              activeTranslated.status !== "ready" ||
              Boolean(disabledReason) ||
              epubBatch.status === "running"
            }
            onClick={() => void startBatch()}
          >
            {isEpub
              ? t.batch.epub.start(candidatePages.length)
              : t.batch.start(candidatePages.length)}
          </button>
          <button type="button" onClick={onStopAll}>
            {t.batch.stopAll}
          </button>
          <button
            type="button"
            disabled={Boolean(disabledReason)}
            onClick={() => {
              queue.resume();
              for (const task of documentTasks) {
                if (task.stage === "error") queue.retry(task.key);
              }
            }}
          >
            {t.batch.retryFailed}
          </button>
        </div>
        {isEpub && epubBatch.status === "running" && (
          <p className="muted" aria-live="polite">
            {t.batch.epub.finding(epubBatch.found)}
          </p>
        )}
        {isEpub && epubBatch.status === "done" && (
          <p className="muted" aria-live="polite">
            {t.batch.epub.found(epubBatch.found, epubBatch.queued)}
          </p>
        )}
        {isEpub && epubBatch.status === "error" && epubBatch.error && (
          <div className="inline-error" role="alert">
            {t.batch.epub.findFailed(errorText(epubBatch.error, locale))}
          </div>
        )}
        <p className="batch-progress" aria-live="polite">
          {t.batch.progress(finished, languageTasks.length, active, queued, failed)}
        </p>
      </section>

      <section className="batch-tasks" aria-label={t.batch.tasks}>
        {documentTasks.length === 0 && (
          <p className="muted">{t.batch.noTasks}</p>
        )}
        <ul>
          {documentTasks.map((task) => (
            <li key={task.key} className={`task-row stage-${task.stage}`}>
              <button
                type="button"
                className="task-page"
                onClick={() => onOpenTaskPage(task)}
              >
                {isEpub
                  ? t.batch.epub.taskPage(
                      task.pageNumber,
                      task.epubPage ?? null,
                      (task.unit ?? "").slice(-6),
                    )
                  : t.common.pageLabel(task.pageNumber)}
              </button>
              <span className="task-language">
                {TARGET_LANGUAGE_LABELS[task.targetLanguage]}
              </span>
              <span className="task-stage">{t.stages[task.stage]}</span>
              {task.stage === "saved" && task.cacheHit && (
                <span className="muted">{t.batch.existing}</span>
              )}
              {task.error && (
                <span
                  className="task-error"
                  title={errorText(
                    {
                      code: task.error.code,
                      detail: task.error.detail,
                      params: task.error.params,
                    },
                    locale,
                  )}
                >
                  {errorText(
                    {
                      code: task.error.code,
                      detail: task.error.detail,
                      params: task.error.params,
                    },
                    locale,
                  )}
                </span>
              )}
              <TypstRepairSummary task={task} />
              <span className="task-actions">
                {isActiveStage(task.stage) && (
                  <button type="button" onClick={() => queue.cancel(task.key)}>
                    {t.common.cancel}
                  </button>
                )}
                {(task.stage === "error" ||
                  (task.stage === "cancelled" && !hasRetainedDraft(task))) && (
                  <button
                    type="button"
                    disabled={Boolean(disabledReason)}
                    onClick={() => queue.retry(task.key)}
                  >
                    {t.common.retry}
                  </button>
                )}
                {hasRetainedDraft(task) && (
                  <>
                    <button type="button" onClick={() => queue.retry(task.key)}>
                      {t.page.retrySave}
                    </button>
                    <button
                      type="button"
                      disabled={Boolean(disabledReason)}
                      title={t.repair.note}
                      onClick={() => queue.repair(task.key)}
                    >
                      {task.repairRounds?.length
                        ? t.page.continueRepair
                        : t.page.repair}
                    </button>
                    <button
                      type="button"
                      onClick={() => queue.discard(task.key)}
                    >
                      {t.page.discardDraft}
                    </button>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
