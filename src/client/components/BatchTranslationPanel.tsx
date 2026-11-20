import { useEffect, useMemo, useState } from "react";
import {
  TARGET_LANGUAGE_LABELS,
  type AiSettingsSnapshot,
  type DocumentRecord,
  type OutlineEntry,
  type TargetLanguage,
} from "../../shared/contracts";
import type { EpubBatchState } from "../epub-batch";
import { errorText, useI18n, type UiError } from "../i18n";
import type { DocumentOutlineState } from "../outline";
import { useTranslatedPages } from "../translated-pages";
import {
  hasRetainedDraft,
  isActiveStage,
  type TranslationQueue,
  type TranslationTask,
} from "../translation-queue";
import { AI_SETTINGS_CODES, ErrorDetails } from "./ErrorDetails";
import { PageSelector } from "./PageSelector";
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
  outlineDraft: string | null;
  onOutlineDraftChange: (draft: string | null) => void;
  onImportOutline: (entries: OutlineEntry[]) => void;
  onRemoveImportedOutline: () => void;
  onReloadOutline: () => void;
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
  /** What the server says about the AI setup; null without an error while it is being read. */
  aiStatus: AiSettingsSnapshot["status"] | null;
  aiStatusError: UiError | null;
  onConfigureAi: () => void;
  onRetryAiStatus: () => void;
}

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
  outlineDraft,
  onOutlineDraftChange,
  onImportOutline,
  onRemoveImportedOutline,
  onReloadOutline,
  onOpenOutlinePage,
  epubBatch,
  onStartEpubBatch,
  onSelectUntranslatedEpub,
  onStopAll,
  aiStatus,
  aiStatusError,
  onConfigureAi,
  onRetryAiStatus,
}: BatchTranslationPanelProps) {
  const { locale, t } = useI18n();
  const isEpub = document.format === "epub";
  const translated = useTranslatedPages(document, language, tasks);
  const { savedPages, savedUnits, issuePages, pageTasks } = translated;
  const [retranslate, setRetranslate] = useState(false);

  useEffect(() => {
    setRetranslate(false);
  }, [document.id]);

  const selectedPages = useMemo(
    () => [...selection].sort((a, b) => a - b),
    [selection],
  );

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

  // What the selected PDF pages come to: pages with a task or draft and, unless regenerating, saved pages are skipped.
  const blockedPages = isEpub ? 0 : selectedPages.filter((page) => issuePages.has(page)).length;
  const savedSkipped =
    isEpub || retranslate
      ? 0
      : selectedPages.filter((page) => !issuePages.has(page) && savedPages.has(page)).length;

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
  const working = tasks.some((task) => isActiveStage(task.stage)) || epubBatch.status === "running";
  const hasErrors = documentTasks.some((task) => task.stage === "error");
  const aiGate = aiStatus
    ? aiStatus.configured
      ? "ready"
      : "unconfigured"
    : aiStatusError
      ? "failed"
      : "checking";
  // An AI action that is not possible yet becomes the step that makes it possible.
  const aiStep =
    aiGate === "unconfigured"
      ? { label: t.ai.configure, run: onConfigureAi }
      : aiGate === "failed"
        ? { label: t.ai.retryCheck, run: onRetryAiStatus }
        : null;

  const startBatch = async (): Promise<void> => {
    if (candidatePages.length === 0 || aiGate !== "ready") return;
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

      <PageSelector
        idPrefix="batch"
        document={document}
        pageCount={pageCount}
        currentPage={currentPage}
        selection={selection}
        onSelectionChange={onSelectionChange}
        translated={translated}
        quickSelect={{
          label: isEpub ? t.batch.epub.untranslatedSections : t.batch.untranslatedPages,
          disabled:
            translated.status !== "ready" ||
            (isEpub && (Boolean(disabledReason) || epubBatch.status === "running")),
          run: () =>
            isEpub
              ? onSelectUntranslatedEpub(savedUnits)
              : onSelectionChange(
                  new Set(
                    Array.from({ length: pageCount }, (_, index) => index + 1).filter(
                      (page) => !savedPages.has(page),
                    ),
                  ),
                ),
        }}
        outline={outline}
        outlineDraft={outlineDraft}
        onOutlineDraftChange={onOutlineDraftChange}
        onImportOutline={onImportOutline}
        onRemoveImportedOutline={onRemoveImportedOutline}
        onReloadOutline={onReloadOutline}
        onOpenOutlinePage={onOpenOutlinePage}
      />

      <section className="batch-summary">
        <p>
          {isEpub
            ? t.batch.epub.selectedSummary(selectedPages.length)
            : t.batch.pdfSummary(
                selectedPages.length,
                blockedPages,
                savedSkipped,
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
            {errorText({ code: queue.halt.code, params: queue.halt.params }, locale)}
            <ErrorDetails error={queue.halt} />
            <div className="inline-actions">
              {AI_SETTINGS_CODES[queue.halt.code] === true && (
                <button type="button" onClick={onConfigureAi}>
                  {t.ai.openSettings}
                </button>
              )}
              <button type="button" disabled={aiGate !== "ready"} onClick={() => queue.resume()}>
                {t.batch.resumeQueue}
              </button>
            </div>
          </div>
        )}
        {aiGate === "checking" && (
          <p className="muted" aria-live="polite">
            {t.ai.checking}
          </p>
        )}
        {aiGate === "unconfigured" && <p className="muted">{t.ai.notConfigured}</p>}
        {aiGate === "failed" && aiStatusError && (
          <p className="field-error" role="alert">
            {t.ai.checkFailed(errorText(aiStatusError, locale))}
          </p>
        )}
        {!isEpub && aiGate === "ready" && candidatePages.length > 0 && (
          <p className="muted">{t.batch.cost(candidatePages.length)}</p>
        )}
        <div className="batch-start">
          {aiStep ? (
            <button type="button" className="primary" onClick={aiStep.run}>
              {aiStep.label}
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={
                candidatePages.length === 0 ||
                translated.status !== "ready" ||
                Boolean(disabledReason) ||
                epubBatch.status === "running" ||
                aiGate === "checking"
              }
              onClick={() => void startBatch()}
            >
              {isEpub
                ? t.batch.epub.start(candidatePages.length)
                : t.batch.start(candidatePages.length)}
            </button>
          )}
          {working && (
            <button type="button" onClick={onStopAll}>
              {t.batch.stopAll}
            </button>
          )}
          {hasErrors && (
            <button
              type="button"
              disabled={Boolean(disabledReason) || aiGate !== "ready"}
              onClick={() => {
                queue.resume();
                for (const task of documentTasks) {
                  if (task.stage === "error") queue.retry(task.key);
                }
              }}
            >
              {t.batch.retryFailed}
            </button>
          )}
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
                <div className="task-error">
                  {errorText({ code: task.error.code, params: task.error.params }, locale)}
                  <ErrorDetails error={task.error} />
                </div>
              )}
              <TypstRepairSummary task={task} />
              <span className="task-actions">
                {isActiveStage(task.stage) && (
                  <button type="button" onClick={() => queue.cancel(task.key)}>
                    {t.common.cancel}
                  </button>
                )}
                {task.error && AI_SETTINGS_CODES[task.error.code] === true && (
                  <button type="button" onClick={onConfigureAi}>
                    {t.ai.openSettings}
                  </button>
                )}
                {(task.stage === "error" ||
                  (task.stage === "cancelled" && !hasRetainedDraft(task))) && (
                  <button
                    type="button"
                    disabled={Boolean(disabledReason) || aiGate !== "ready"}
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
                      disabled={Boolean(disabledReason) || aiGate !== "ready"}
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
