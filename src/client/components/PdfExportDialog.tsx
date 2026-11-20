import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  TARGET_LANGUAGE_LABELS,
  type AiSettingsSnapshot,
  type DocumentRecord,
  type TargetLanguage,
  type TranslationRecord,
} from "../../shared/contracts";
import { stripPlaceholderControls } from "../../shared/typst";
import { apiJson, triggerDownload } from "../api";
import { collectPageSources, documentBaseName } from "../export-sources";
import { errorText, toUiError, useI18n, type UiError } from "../i18n";
import type { DocumentOutlineState } from "../outline";
import { openExportOriginal } from "../pdf";
import {
  buildTranslationPdf,
  classifyExportPages,
  TRANSLATION_WIDTHS,
  TypstPdfWorker,
  type ExportLayout,
  type ExportPageStatus,
  type PdfExportProgress,
  type TranslationWidth,
} from "../pdf-export";
import { useTranslatedPages } from "../translated-pages";
import {
  hasRetainedDraft,
  type TranslationQueue,
  type TranslationTask,
} from "../translation-queue";
import { ModalDialog } from "./ModalDialog";
import { PageSelector } from "./PageSelector";

interface PdfExportDialogProps {
  open: boolean;
  onClose: () => void;
  document: DocumentRecord;
  pageCount: number;
  currentPage: number;
  language: TargetLanguage;
  tasks: TranslationTask[];
  queue: TranslationQueue;
  /** Why translating is not possible now; exporting saved pages still is. */
  translationDisabledReason: string | null;
  /** The password the open PDF was unlocked with, if any. */
  password: () => string | undefined;
  outline: DocumentOutlineState;
  outlineGenerationDisabledReason: string | null;
  onGenerateOutline: () => void;
  onCancelOutline: () => void;
  onReloadOutline: () => void;
  onRetrySaveOutline: () => void;
  onDiscardOutline: () => void;
  onOpenOutlinePage: (pageNumber: number) => void;
  aiStatus: AiSettingsSnapshot["status"] | null;
  aiStatusError: UiError | null;
  onConfigureAi: () => void;
  onRetryAiStatus: () => void;
}

type Phase =
  | { kind: "idle" }
  | { kind: "prompt"; pages: number[]; status: ExportPageStatus }
  /** Waiting for `targets` to be saved before building `pages`. */
  | { kind: "waiting"; pages: number[]; targets: number[] }
  | { kind: "blocked"; pages: number[]; targets: number[]; failed: number[] }
  | { kind: "building"; progress: PdfExportProgress | null }
  | { kind: "done"; skipped: number; keptSavedWidth: number[] }
  | { kind: "error"; error: UiError };

/**
 * Exports saved translations of a PDF as one PDF: translation pages alone, or
 * each original page followed by its translation. Missing translations can be
 * queued first; the PDF is then built once they are all saved.
 */
export function PdfExportDialog({
  open,
  onClose,
  document,
  pageCount,
  currentPage,
  language,
  tasks,
  queue,
  translationDisabledReason,
  password,
  outline,
  outlineGenerationDisabledReason,
  onGenerateOutline,
  onCancelOutline,
  onReloadOutline,
  onRetrySaveOutline,
  onDiscardOutline,
  onOpenOutlinePage,
  aiStatus,
  aiStatusError,
  onConfigureAi,
  onRetryAiStatus,
}: PdfExportDialogProps) {
  const { locale, t } = useI18n();
  const translated = useTranslatedPages(document, language, tasks);
  const { savedPages } = translated;
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [layout, setLayout] = useState<ExportLayout>("translation");
  const [width, setWidth] = useState<TranslationWidth>("a4");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const controllerRef = useRef<AbortController | null>(null);
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  // The selection starts as every translated page, once per document and language.
  const seededRef = useRef("");

  const languageTasks = useMemo(
    () =>
      translated.pageTasks.filter(
        (task) => task.documentId === document.id && task.targetLanguage === language,
      ),
    [translated.pageTasks, document.id, language],
  );

  const stop = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setPhase({ kind: "idle" });
  }, []);

  useEffect(() => {
    const key = `${document.id}/${language}`;
    if (!open || translated.status !== "ready" || seededRef.current === key) return;
    seededRef.current = key;
    setSelection(new Set(savedPages));
  }, [open, translated.status, savedPages, document.id, language]);

  // A different language is a different export; the document is keyed by the caller.
  useEffect(() => stop, [language, stop]);

  const aiGate = aiStatus
    ? aiStatus.configured
      ? "ready"
      : "unconfigured"
    : aiStatusError
      ? "failed"
      : "checking";
  const aiStep =
    aiGate === "unconfigured"
      ? { label: t.ai.configure, run: onConfigureAi }
      : aiGate === "failed"
        ? { label: t.ai.retryCheck, run: onRetryAiStatus }
        : null;

  const selectedPages = useMemo(() => [...selection].sort((a, b) => a - b), [selection]);
  const translatedCount = selectedPages.filter((page) => savedPages.has(page)).length;

  const build = useCallback(
    async (pages: number[]) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const { signal } = controller;
      setPhase({ kind: "building", progress: null });
      const compiler = new TypstPdfWorker();
      let original: Awaited<ReturnType<typeof openExportOriginal>> | null = null;
      try {
        const records = await apiJson<TranslationRecord[]>(
          `/api/documents/${document.id}/translations?targetLanguage=${language}`,
          { signal },
        );
        const sources = new Map(
          collectPageSources(document, language, records, tasksRef.current, { drafts: false })
            .filter((source) => source.typst !== "")
            .map((source) => [source.pageNumber, stripPlaceholderControls(source.typst)]),
        );
        original = await openExportOriginal(document.id, password(), signal);
        const base = documentBaseName(document.name);
        const result = await buildTranslationPdf(
          {
            title: `${base} (${TARGET_LANGUAGE_LABELS[language]})`,
            layout,
            width,
            pages,
            sources,
          },
          { compiler, original },
          signal,
          (progress) => {
            if (!signal.aborted) setPhase({ kind: "building", progress });
          },
        );
        signal.throwIfAborted();
        triggerDownload(
          new Blob([result.pdf as BlobPart], { type: "application/pdf" }),
          `${base}-${language}${layout === "interleaved" ? "-bilingual" : ""}.pdf`,
        );
        setPhase({
          kind: "done",
          skipped: pages.filter((page) => !sources.has(page)).length,
          keptSavedWidth: result.keptSavedWidth,
        });
      } catch (error) {
        if (!signal.aborted) setPhase({ kind: "error", error: toUiError(error) });
      } finally {
        compiler.close();
        await original?.close();
        if (controllerRef.current === controller) controllerRef.current = null;
      }
    },
    [document, language, layout, width, password],
  );

  const startExport = (): void => {
    const pages = selectedPages;
    const status = classifyExportPages(pages, savedPages, languageTasks);
    if (status.saved.length === pages.length) void build(pages);
    else setPhase({ kind: "prompt", pages, status });
  };

  // Queues what can be queued and waits for those pages and the ones already running.
  const translateFirst = (pages: number[], targets: number[]): void => {
    queue.resume();
    for (const page of targets) {
      const task = languageTasks.find((item) => item.pageNumber === page);
      if (task && (task.stage === "error" || task.stage === "cancelled")) {
        queue.retry(task.key);
      } else if (!task || task.stage === "saved") {
        queue.enqueue({
          documentId: document.id,
          pageNumber: page,
          targetLanguage: language,
          force: false,
          priority: "batch",
        });
      }
    }
    setPhase({ kind: "waiting", pages, targets });
  };

  // While waiting, every queue change is checked: all saved builds, anything stuck blocks.
  useEffect(() => {
    if (phase.kind !== "waiting") return;
    const failed: number[] = [];
    let pending = false;
    for (const page of phase.targets) {
      if (savedPages.has(page)) continue;
      const task = languageTasks.find((item) => item.pageNumber === page);
      if (task && (task.stage === "error" || task.stage === "cancelled" || hasRetainedDraft(task))) {
        failed.push(page);
      } else {
        pending = true;
      }
    }
    if (pending) return;
    if (failed.length > 0) {
      setPhase({ kind: "blocked", pages: phase.pages, targets: phase.targets, failed });
    } else {
      void build(phase.pages);
    }
  }, [phase, savedPages, languageTasks, build]);

  const close = (): void => {
    stop();
    onClose();
  };

  const busy = phase.kind === "waiting" || phase.kind === "building";
  const savedInTargets =
    phase.kind === "waiting"
      ? phase.targets.filter((page) => savedPages.has(page)).length
      : 0;

  return (
    <ModalDialog open={open} onClose={close} label={t.pdfExport.title} className="pdf-export-dialog">
      <div className="dialog-heading">
        <h2>{t.pdfExport.title}</h2>
        <button type="button" onClick={close}>
          {t.common.close}
        </button>
      </div>
      <p className="muted">{t.pdfExport.language(TARGET_LANGUAGE_LABELS[language])}</p>

      <fieldset className="pdf-export-options" disabled={busy}>
        <PageSelector
          idPrefix="pdf-export"
          document={document}
          pageCount={pageCount}
          currentPage={currentPage}
          selection={selection}
          onSelectionChange={setSelection}
          translated={translated}
          quickSelect={{
            label: t.pdfExport.translatedPages,
            disabled: translated.status !== "ready",
            run: () => setSelection(new Set(savedPages)),
          }}
          outline={outline}
          outlineGenerationDisabledReason={outlineGenerationDisabledReason}
          onGenerateOutline={onGenerateOutline}
          onCancelOutline={onCancelOutline}
          onReloadOutline={onReloadOutline}
          onRetrySaveOutline={onRetrySaveOutline}
          onDiscardOutline={onDiscardOutline}
          onOpenOutlinePage={onOpenOutlinePage}
          aiStep={aiStep}
          aiChecking={aiGate === "checking"}
        />

        <fieldset className="batch-method">
          <legend>{t.pdfExport.layout}</legend>
          {(["translation", "interleaved"] as const).map((value) => (
            <label key={value} className="radio-row">
              <input
                type="radio"
                name="pdf-export-layout"
                checked={layout === value}
                onChange={() => setLayout(value)}
              />
              {value === "translation" ? t.pdfExport.translationOnly : t.pdfExport.interleaved}
            </label>
          ))}
        </fieldset>

        <label className="pdf-export-width">
          {t.pdfExport.width}
          <select
            value={width}
            onChange={(event) => setWidth(event.target.value as TranslationWidth)}
          >
            {TRANSLATION_WIDTHS.map((value) => (
              <option key={value} value={value}>
                {t.pdfExport.widths[value]}
              </option>
            ))}
          </select>
        </label>
        <p className="muted">{t.pdfExport.widthNote}</p>
      </fieldset>

      <section className="batch-summary" aria-live="polite">
        <p>{t.pdfExport.summary(selectedPages.length, translatedCount)}</p>

        {phase.kind === "prompt" && (
          <div className="pdf-export-prompt" role="status">
            <p>
              {t.pdfExport.missing(
                phase.pages.length - phase.status.saved.length,
                phase.pages.length,
              )}
              {phase.status.inProgress.length > 0 &&
                ` ${t.pdfExport.inProgress(phase.status.inProgress.length)}`}
              {phase.status.drafts.length > 0 &&
                ` ${t.pdfExport.drafts(phase.status.drafts.length)}`}
            </p>
            <p className="muted">
              {layout === "interleaved"
                ? t.pdfExport.withoutNote.interleaved
                : t.pdfExport.withoutNote.translation}
            </p>
            {(() => {
              const queueable = [...phase.status.untranslated, ...phase.status.failed];
              const targets = [...queueable, ...phase.status.inProgress];
              if (targets.length === 0) return null;
              if (queueable.length === 0) {
                return (
                  <button
                    type="button"
                    className="primary"
                    onClick={() => translateFirst(phase.pages, targets)}
                  >
                    {t.pdfExport.waitOnly}
                  </button>
                );
              }
              return (
                <>
                  {aiGate === "ready" && !translationDisabledReason && (
                    <p className="muted">{t.batch.cost(queueable.length)}</p>
                  )}
                  {translationDisabledReason && (
                    <p className="field-error">{translationDisabledReason}</p>
                  )}
                  <button
                    type="button"
                    className="primary"
                    disabled={
                      !aiStep && (Boolean(translationDisabledReason) || aiGate === "checking")
                    }
                    onClick={aiStep?.run ?? (() => translateFirst(phase.pages, targets))}
                  >
                    {aiStep?.label ?? t.pdfExport.translateFirst(queueable.length)}
                  </button>
                </>
              );
            })()}
            <div className="inline-actions">
              <button
                type="button"
                disabled={phase.status.saved.length === 0 && layout === "translation"}
                onClick={() => void build(phase.pages)}
              >
                {t.pdfExport.exportWithout}
              </button>
              <button type="button" onClick={stop}>
                {t.common.cancel}
              </button>
            </div>
          </div>
        )}

        {phase.kind === "waiting" && (
          <div className="outline-progress">
            <p>{t.pdfExport.waiting(savedInTargets, phase.targets.length)}</p>
            <p className="muted">{t.pdfExport.waitingNote}</p>
            <button type="button" onClick={stop}>
              {t.pdfExport.cancelExport}
            </button>
          </div>
        )}

        {phase.kind === "blocked" && (
          <div className="inline-error" role="alert">
            <p>{t.pdfExport.blocked(phase.failed.length)}</p>
            <div className="inline-actions">
              <button
                type="button"
                disabled={Boolean(aiStep) || Boolean(translationDisabledReason)}
                onClick={() => translateFirst(phase.pages, phase.failed)}
              >
                {t.common.retry}
              </button>
              <button type="button" onClick={() => void build(phase.pages)}>
                {t.pdfExport.exportWithout}
              </button>
              <button type="button" onClick={stop}>
                {t.common.cancel}
              </button>
            </div>
          </div>
        )}

        {phase.kind === "building" && (
          <div className="outline-progress">
            <p>
              {phase.progress?.phase === "originals"
                ? t.pdfExport.originals(phase.progress.done, phase.progress.total)
                : phase.progress?.phase === "typesetting"
                  ? t.pdfExport.typesetting
                  : t.pdfExport.preparing}
            </p>
            <button type="button" onClick={stop}>
              {t.common.cancel}
            </button>
          </div>
        )}

        {phase.kind === "done" && (
          <p className="muted">
            {t.pdfExport.done}
            {phase.skipped > 0 && ` ${t.pdfExport.doneSkipped(phase.skipped)}`}
            {phase.keptSavedWidth.length > 0 &&
              ` ${t.pdfExport.keptWidth(phase.keptSavedWidth.join(", "))}`}
          </p>
        )}

        {phase.kind === "error" && (
          <p className="field-error" role="alert">
            {t.pdfExport.failed(errorText(phase.error, locale))}
          </p>
        )}

        <div className="batch-start">
          <button
            type="button"
            className="primary"
            disabled={
              selectedPages.length === 0 ||
              translated.status !== "ready" ||
              busy ||
              phase.kind === "prompt" ||
              phase.kind === "blocked"
            }
            onClick={startExport}
          >
            {t.pdfExport.export}
          </button>
        </div>
      </section>
    </ModalDialog>
  );
}
