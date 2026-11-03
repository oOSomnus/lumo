import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  DEFAULT_READER_VIEW,
  MAX_OUTLINE_ENTRIES,
  outlineEntriesSchema,
  outlinePageResultSchema,
  readerViewSchema,
  TARGET_LANGUAGE_LABELS,
  type DocumentRecord,
  type LibrarySnapshot,
  type OutlineEntry,
  type OutlinePageInput,
  type ReaderUpdate,
  type ReaderView,
  type TargetLanguage,
  type TranslationRecord,
  type UiLocale,
} from "../../shared/contracts";
import {
  apiFetch,
  apiJson,
  accessToken,
  fetchTranslation,
  jsonInit,
  requestTranslation,
  saveTranslationRecord,
  saveUiLocale,
  triggerDownload,
} from "../api";
import {
  errorText,
  formatDateTime,
  setUiLocale,
  toUiError,
  useI18n,
  type UiError,
} from "../i18n";
import { PagePreparationError, preparePageForTranslation, validatePdfCopy } from "../pdf";
import { ViewerBridgeError, type ViewerBridge } from "../pdfBridge";
import {
  emptyOutlineState,
  OutlineError,
  type DocumentOutlineState,
} from "../outline";
import {
  TranslationQueue,
  translationKey,
  type TranslationTask,
} from "../translation-queue";
import { BatchTranslationPanel } from "./BatchTranslationPanel";
import { ModalDialog } from "./ModalDialog";
import { PdfViewerFrame } from "./PdfViewerFrame";
import { SettingsDialog } from "./SettingsDialog";
import { TranslationView } from "./TranslationView";

const MAX_PDF_BYTES = 100 * 1024 * 1024;

type PendingLoad =
  | { kind: "library"; document: DocumentRecord; page: number }
  | { kind: "preview"; file: File; blobUrl: string };

interface StoredTranslationState {
  key: string;
  status: "idle" | "loading" | "ready" | "error";
  record?: TranslationRecord | null;
  message?: UiError;
}

interface AskOptions {
  title: string;
  body: string;
  confirmLabel: string;
  extraLabel?: string;
  onExtra?: () => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sameReaderView(a: ReaderView, b: ReaderView): boolean {
  return (
    a.scaleValue === b.scaleValue &&
    a.rotation === b.rotation &&
    a.scrollMode === b.scrollMode &&
    a.spreadMode === b.spreadMode
  );
}

function fileValidationError(file: File): UiError | null {
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    return { code: "INVALID_PDF_FILE" };
  }
  if (file.size === 0) return { code: "EMPTY_PDF_FILE" };
  if (file.size > MAX_PDF_BYTES) return { code: "PDF_FILE_TOO_LARGE" };
  return null;
}

function baseName(name: string): string {
  return name.replace(/\.pdf$/i, "");
}

function copyName(name: string, suffix: string): string {
  const base = baseName(name).slice(0, 230);
  return `${base}${suffix}.pdf`;
}

function useNarrowLayout(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1023px)");
    const update = () => setNarrow(query.matches);
    query.addEventListener("change", update);
    update();
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}

interface ConfirmDialogProps {
  options: AskOptions | null;
  onSettle: (confirmed: boolean) => void;
}

function ConfirmDialog({ options, onSettle }: ConfirmDialogProps) {
  const { t } = useI18n();
  return (
    <ModalDialog
      open={options !== null}
      onClose={() => onSettle(false)}
      label={options?.title ?? t.confirm.defaultLabel}
    >
      {options && (
        <>
          <h2>{options.title}</h2>
          <p>{options.body}</p>
          <div className="dialog-actions">
            {options.extraLabel && options.onExtra && (
              <button type="button" onClick={options.onExtra}>
                {options.extraLabel}
              </button>
            )}
            <button type="button" onClick={() => onSettle(false)}>
              {t.common.cancel}
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => onSettle(true)}
            >
              {options.confirmLabel}
            </button>
          </div>
        </>
      )}
    </ModalDialog>
  );
}

function LocaleSwitch() {
  const { locale, t } = useI18n();
  return (
    <div
      className="locale-switch"
      role="group"
      aria-label={t.settings.languageSection}
    >
      <button
        type="button"
        aria-pressed={locale === "en"}
        onClick={() => setUiLocale("en")}
      >
        {t.settings.english}
      </button>
      <button
        type="button"
        aria-pressed={locale === "zh-CN"}
        onClick={() => setUiLocale("zh-CN")}
      >
        {t.settings.chinese}
      </button>
    </div>
  );
}

export function Reader() {
  const token = accessToken();
  const narrow = useNarrowLayout();
  const { locale, t } = useI18n();

  const [library, setLibrary] = useState<LibrarySnapshot | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(Boolean(token));
  const [libraryError, setLibraryError] = useState<UiError | null>(null);

  const [currentDocument, setCurrentDocument] = useState<DocumentRecord | null>(null);
  const currentDocumentRef = useRef<DocumentRecord | null>(null);
  const [page, setPage] = useState(1);
  const pageRef = useRef(1);
  const [pageCount, setPageCount] = useState(0);
  const [language, setLanguage] = useState<TargetLanguage>("zh-CN");
  const languageRef = useRef<TargetLanguage>("zh-CN");

  const [session, setSession] = useState(0);
  const sessionRef = useRef(0);
  const [viewerReady, setViewerReady] = useState(false);
  const viewerReadyRef = useRef(false);
  const [viewerError, setViewerError] = useState<UiError | null>(null);
  const bridgeRef = useRef<ViewerBridge | null>(null);
  const pendingRef = useRef<PendingLoad | null>(null);
  const openAttemptRef = useRef(0);
  const watchCleanupRef = useRef<(() => void) | null>(null);
  const passwordRef = useRef<string | null>(null);
  const modificationVersionRef = useRef(0);
  const [previewOnly, setPreviewOnly] = useState(false);
  const previewOnlyRef = useRef(false);
  const [modified, setModified] = useState(false);
  const [importError, setImportError] = useState<UiError | null>(null);
  const [previewUploadCount, setPreviewUploadCount] = useState(0);
  const [savingCopy, setSavingCopy] = useState(false);
  const [saveCopyError, setSaveCopyError] = useState<UiError | null>(null);
  const [progressWarning, setProgressWarning] = useState(false);
  const [viewSaveFailed, setViewSaveFailed] = useState(false);
  const [viewRestoreFailed, setViewRestoreFailed] = useState(false);

  const [rightTab, setRightTab] = useState<"page" | "batch">("page");
  const [narrowTab, setNarrowTab] = useState<"pdf" | "translation" | "batch">("translation");
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerError, setDrawerError] = useState<UiError | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportError, setExportError] = useState<UiError | null>(null);
  const [storedReload, setStoredReload] = useState(0);

  const [askState, setAskState] = useState<AskOptions | null>(null);
  const askResolver = useRef<((confirmed: boolean) => void) | null>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const pendingProgressRef = useRef<Map<string | null, ReaderUpdate>>(new Map());
  const progressDrainRef = useRef<Promise<void> | null>(null);
  const initialViewRef = useRef<ReaderView>(DEFAULT_READER_VIEW);
  const pendingViewsRef = useRef<Map<string, ReaderView>>(new Map());
  const failedViewsRef = useRef<Map<string, ReaderView>>(new Map());
  const savedViewsRef = useRef<Map<string, ReaderView>>(new Map());
  const deletedViewsRef = useRef<Set<string>>(new Set());
  const viewTouchedRef = useRef(false);
  const lastViewRef = useRef<ReaderView | null>(null);
  const viewTimerRef = useRef<number | null>(null);
  const viewDrainRef = useRef<Promise<void> | null>(null);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const pageBodyRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [queueVersion, bumpQueue] = useReducer((value: number) => value + 1, 0);

  const [stored, setStored] = useState<StoredTranslationState>({
    key: "",
    status: "idle",
  });

  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [outline, setOutline] = useState<DocumentOutlineState>(emptyOutlineState);
  const outlineRef = useRef(outline);
  const outlineAttemptRef = useRef(0);
  const outlineControllerRef = useRef<AbortController | null>(null);
  const outlineLoadedSessionRef = useRef(-1);

  useEffect(() => {
    outlineRef.current = outline;
  }, [outline]);

  const queueRef = useRef<TranslationQueue | null>(null);
  if (!queueRef.current) {
    queueRef.current = new TranslationQueue({
      prepare: async (task, signal) => {
        const bridge = bridgeRef.current;
        if (!bridge) {
          throw new PagePreparationError("PDF_NOT_READY", "PDF is not open");
        }
        if (previewOnlyRef.current) {
          throw new PagePreparationError("PDF_NOT_SAVED", "the PDF is not in the library yet");
        }
        const document = currentDocumentRef.current;
        if (!document || document.id !== task.documentId) {
          throw new PagePreparationError("DOCUMENT_CHANGED", "the document changed");
        }
        const pageProxy = await bridge.getPage(task.pageNumber);
        try {
          return await preparePageForTranslation(
            pageProxy,
            bridge.document,
            signal,
          );
        } finally {
          if (task.pageNumber !== bridge.page) pageProxy.cleanup();
        }
      },
      translate: (task, prepared, signal, hooks) =>
        requestTranslation(
          {
            documentId: task.documentId,
            pageNumber: task.pageNumber,
            targetLanguage: task.targetLanguage,
            text: prepared.text,
            imageBase64: prepared.imageBase64,
            force: task.force,
          },
          {
            signal,
            onDelta: (chunk) => hooks.onDelta(chunk.contentIndex, chunk.text),
            onSaving: hooks.onSaving,
          },
        ),
      save: async (task, draft, signal) =>
        saveTranslationRecord(
          task.documentId,
          task.pageNumber,
          task.targetLanguage,
          draft,
          signal,
        ),
    });
  }
  const queue = queueRef.current;

  useEffect(() => queue.subscribe(bumpQueue), [queue]);
  useEffect(() => () => queue.cancelAll(), [queue]);

  useEffect(() => {
    setSelection(new Set());
    const nextOutline = emptyOutlineState();
    outlineRef.current = nextOutline;
    setOutline(nextOutline);
    outlineLoadedSessionRef.current = -1;
    outlineAttemptRef.current += 1;
    outlineControllerRef.current?.abort();
    outlineControllerRef.current = null;
  }, [session]);

  const tasks = useMemo(() => queue.getTasks(), [queue, queueVersion]);
  const currentKey = currentDocument
    ? translationKey(currentDocument.id, page, language)
    : "";
  const currentTask = tasks.find((task) => task.key === currentKey);
  const storedState =
    currentDocument && stored.key === currentKey
      ? stored
      : { key: currentKey, status: "loading" as const, record: undefined };

  useEffect(() => {
    if (currentTask?.stage === "queued" && currentTask.priority === "batch") {
      queue.promote(currentTask.key);
    }
  }, [currentTask?.key, currentTask?.stage, currentTask?.priority, queue]);

  useEffect(() => {
    if (!modified) return;
    queue.cancelAll();
    if (outlineRef.current.stage !== "generating") return;
    outlineAttemptRef.current += 1;
    outlineControllerRef.current?.abort();
    outlineControllerRef.current = null;
    setOutline((previous) =>
      previous.stage === "generating"
        ? {
            ...previous,
            entries: [],
            stage: "idle",
            processedPages: 0,
            error: null,
          }
        : previous,
    );
  }, [modified, queue]);

  useEffect(() => {
    for (const task of tasks) {
      if (
        task.stage === "saved" &&
        task.key !== currentKey &&
        task.saved?.markdown &&
        task.saved.markdown.length > 0
      ) {
        queue.releaseSavedText(task.key);
      }
    }
  }, [tasks, currentKey, queue]);

  useEffect(() => {
    if (currentTask?.stage === "error" || currentTask?.stage === "cancelled") {
      setStoredReload((value) => value + 1);
    }
  }, [currentTask?.key, currentTask?.stage]);

  const setPageValue = useCallback((value: number) => {
    pageRef.current = value;
    setPage(value);
  }, []);

  const selectDocument = useCallback((document: DocumentRecord | null) => {
    const previousId = currentDocumentRef.current?.id ?? null;
    const nextId = document?.id ?? null;
    if (previousId !== nextId) {
      setSelection(new Set());
      const nextOutline = emptyOutlineState();
      outlineRef.current = nextOutline;
      setOutline(nextOutline);
      outlineLoadedSessionRef.current = -1;
    }
    currentDocumentRef.current = document;
    if (document) deletedViewsRef.current.delete(document.id);
    setCurrentDocument(document);
  }, []);

  const putReaderView = useCallback(
    async (documentId: string, view: ReaderView): Promise<boolean> => {
      try {
        const result = await apiJson<{ view: ReaderView }>(
          `/api/documents/${documentId}/view`,
          jsonInit("PUT", view),
        );
        if (deletedViewsRef.current.has(documentId)) return true;
        savedViewsRef.current.set(documentId, result.view);
        failedViewsRef.current.delete(documentId);
        if (pendingViewsRef.current.get(documentId) === view) {
          pendingViewsRef.current.delete(documentId);
        }
        return true;
      } catch {
        if (!deletedViewsRef.current.has(documentId)) {
          failedViewsRef.current.set(documentId, view);
          setViewSaveFailed(true);
        }
        return false;
      }
    },
    [],
  );

  const drainViewSaves = useCallback((): Promise<void> => {
    if (viewDrainRef.current) return viewDrainRef.current;
    const run = (async () => {
      for (;;) {
        const entry = pendingViewsRef.current.entries().next().value;
        if (!entry) break;
        const [documentId, view] = entry;
        const saved = await putReaderView(documentId, view);
        if (!saved && pendingViewsRef.current.get(documentId) === view) {
          pendingViewsRef.current.delete(documentId);
        }
      }
      setViewSaveFailed(
        pendingViewsRef.current.size > 0 || failedViewsRef.current.size > 0,
      );
    })().finally(() => {
      viewDrainRef.current = null;
    });
    viewDrainRef.current = run;
    return run;
  }, [putReaderView]);

  const scheduleViewSave = useCallback(() => {
    if (viewTimerRef.current !== null) window.clearTimeout(viewTimerRef.current);
    viewTimerRef.current = window.setTimeout(() => {
      viewTimerRef.current = null;
      void drainViewSaves();
    }, 250);
  }, [drainViewSaves]);

  const flushViewSaves = useCallback(async (): Promise<boolean> => {
    if (viewTimerRef.current !== null) {
      window.clearTimeout(viewTimerRef.current);
      viewTimerRef.current = null;
    }
    await drainViewSaves();
    return (
      pendingViewsRef.current.size === 0 && failedViewsRef.current.size === 0
    );
  }, [drainViewSaves]);

  const retryViewSaves = useCallback(() => {
    for (const [documentId, view] of failedViewsRef.current) {
      if (!pendingViewsRef.current.has(documentId)) {
        pendingViewsRef.current.set(documentId, view);
      }
    }
    failedViewsRef.current.clear();
    setViewSaveFailed(false);
    void drainViewSaves();
  }, [drainViewSaves]);

  const commitCurrentView = useCallback(async (): Promise<boolean> => {
    const bridge = bridgeRef.current;
    const document = currentDocumentRef.current;
    if (bridge && document && viewerReadyRef.current) {
      try {
        const view = bridge.getView();
        const saved = savedViewsRef.current.get(document.id);
        if (!saved || !sameReaderView(saved, view)) {
          pendingViewsRef.current.set(document.id, view);
        }
      } catch {
        // The viewer is between documents; the queued snapshot is authoritative.
      }
    }
    return flushViewSaves();
  }, [flushViewSaves]);

  const resolveInitialView = useCallback(
    async (documentId: string, sessionAtStart: number): Promise<ReaderView> => {
      const cached =
        pendingViewsRef.current.get(documentId) ??
        savedViewsRef.current.get(documentId);
      if (cached) return cached;
      try {
        const result = await apiJson<{ view: ReaderView | null }>(
          `/api/documents/${documentId}/view`,
        );
        if (sessionAtStart !== sessionRef.current) return DEFAULT_READER_VIEW;
        const stored = result.view
          ? readerViewSchema.safeParse(result.view)
          : null;
        setViewRestoreFailed(false);
        if (!stored?.success) return DEFAULT_READER_VIEW;
        savedViewsRef.current.set(documentId, stored.data);
        return stored.data;
      } catch {
        if (sessionAtStart === sessionRef.current) setViewRestoreFailed(true);
        return DEFAULT_READER_VIEW;
      }
    },
    [],
  );

  const handleViewChange = useCallback(
    (view: ReaderView) => {
      // PDF.js applies its own initial zoom while opening; the saved view is
      // restored synchronously at documentinit, so ignore events until then.
      if (!viewerReadyRef.current) return;
      const previous = lastViewRef.current;
      if (previous && sameReaderView(previous, view)) return;
      lastViewRef.current = view;
      viewTouchedRef.current = true;
      setViewRestoreFailed(false);
      const document = currentDocumentRef.current;
      if (!document || previewOnlyRef.current) return;
      const saved = savedViewsRef.current.get(document.id);
      if (saved && sameReaderView(saved, view)) {
        pendingViewsRef.current.delete(document.id);
        return;
      }
      pendingViewsRef.current.set(document.id, view);
      failedViewsRef.current.delete(document.id);
      scheduleViewSave();
    },
    [scheduleViewSave],
  );

  const retryViewRestore = useCallback(async () => {
    const document = currentDocumentRef.current;
    const bridge = bridgeRef.current;
    if (!document || !bridge || !viewerReadyRef.current) return;
    const sessionAtStart = sessionRef.current;
    try {
      const result = await apiJson<{ view: ReaderView | null }>(
        `/api/documents/${document.id}/view`,
      );
      if (sessionAtStart !== sessionRef.current) return;
      setViewRestoreFailed(false);
      const stored = result.view
        ? readerViewSchema.safeParse(result.view)
        : null;
      if (!stored?.success) return;
      savedViewsRef.current.set(document.id, stored.data);
      if (viewTouchedRef.current) {
        try {
          pendingViewsRef.current.set(document.id, bridge.getView());
          void drainViewSaves();
        } catch {
          // The viewer is between documents; the next change records it.
        }
        return;
      }
      initialViewRef.current = stored.data;
      lastViewRef.current = stored.data;
      bridge.restoreView(stored.data);
    } catch {
      if (sessionAtStart === sessionRef.current) setViewRestoreFailed(true);
    }
  }, [drainViewSaves]);

  const captureCurrentView = useCallback((documentId: string): boolean => {
    const bridge = bridgeRef.current;
    if (!bridge || !viewerReadyRef.current) return false;
    try {
      pendingViewsRef.current.set(documentId, bridge.getView());
      failedViewsRef.current.delete(documentId);
      return true;
    } catch {
      return false;
    }
  }, []);

  const drainProgress = useCallback((): Promise<void> => {
    if (progressDrainRef.current) return progressDrainRef.current;
    const run = (async () => {
      while (pendingProgressRef.current.size > 0) {
        const entry = pendingProgressRef.current.entries().next().value;
        if (!entry) break;
        const [key, update] = entry;
        pendingProgressRef.current.delete(key);
        try {
          const settings = await apiJson<{
            lastDocumentId: string | null;
            targetLanguage: TargetLanguage;
          }>("/api/reader", jsonInit("PATCH", update));
          setProgressWarning(false);
          setLibrary((previous) =>
            previous ? { ...previous, settings } : previous,
          );
        } catch {
          setProgressWarning(true);
        }
      }
    })().finally(() => {
      progressDrainRef.current = null;
    });
    progressDrainRef.current = run;
    return run;
  }, []);

  const saveProgress = useCallback(
    (documentId: string | null, pageNumber: number | null, targetLanguage: TargetLanguage) => {
      const pending = pendingProgressRef.current;
      pending.delete(documentId);
      pending.set(documentId, { documentId, pageNumber, targetLanguage });
      saveChainRef.current = drainProgress();
    },
    [drainProgress],
  );

  useEffect(() => {
    if (!token) {
      setLibraryLoading(false);
      return;
    }
    let cancelled = false;

    const load = async (): Promise<void> => {
      try {
        const snapshot = await apiJson<LibrarySnapshot>("/api/library");
        if (cancelled) return;
        setUiLocale(snapshot.uiLocale);
        setLibrary(snapshot);
        setLibraryError(null);
        setLanguage(snapshot.settings.targetLanguage);
        languageRef.current = snapshot.settings.targetLanguage;
        const lastId = snapshot.settings.lastDocumentId;
        const last = lastId
          ? snapshot.documents.find((document) => document.id === lastId)
          : undefined;
        if (last) {
          openDocument(last, last.currentPage, true);
        }
      } catch (error) {
        if (!cancelled) setLibraryError(toUiError(error));
      } finally {
        if (!cancelled) setLibraryLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
    // The first library load is intentionally performed once per token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (!currentDocument) {
      setStored({ key: "", status: "idle" });
      return;
    }
    const key = translationKey(currentDocument.id, page, language);
    const controller = new AbortController();
    setStored((previous) =>
      previous.key === key ? previous : { key, status: "loading" },
    );
    fetchTranslation(currentDocument.id, page, language, controller.signal)
      .then((record) => {
        if (controller.signal.aborted) return;
        setStored({ key, status: "ready", record });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setStored({ key, status: "error", message: toUiError(error) });
      });
    return () => controller.abort();
  }, [currentDocument, page, language, storedReload]);

  const ask = useCallback((options: AskOptions): Promise<boolean> => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    askResolver.current = resolve;
    setAskState(options);
    return promise;
  }, []);

  const settleAsk = useCallback((confirmed: boolean) => {
    const resolve = askResolver.current;
    askResolver.current = null;
    setAskState(null);
    resolve?.(confirmed);
  }, []);

  const abortOutlineWork = useCallback(() => {
    outlineAttemptRef.current += 1;
    outlineControllerRef.current?.abort();
    outlineControllerRef.current = null;
  }, []);

  const loadOutline = useCallback(
    async (
      bridge: ViewerBridge,
      documentId: string,
      sessionAtStart: number,
      force = false,
    ): Promise<void> => {
      if (!force && outlineLoadedSessionRef.current === sessionAtStart) return;
      outlineLoadedSessionRef.current = sessionAtStart;
      const attempt = ++outlineAttemptRef.current;
      outlineControllerRef.current?.abort();
      const controller = new AbortController();
      outlineControllerRef.current = controller;
      setOutline({ ...emptyOutlineState(), loadStatus: "loading" });

      try {
        let native: { entries: OutlineEntry[]; skipped: number } | null = null;
        try {
          native = await bridge.getOutline();
        } catch (error) {
          if (
            !(error instanceof ViewerBridgeError) ||
            error.code !== "OUTLINE_INVALID"
          ) {
            throw error;
          }
        }
        if (
          attempt !== outlineAttemptRef.current ||
          sessionRef.current !== sessionAtStart ||
          bridgeRef.current !== bridge
        ) {
          return;
        }
        if (native && native.entries.length > 0) {
          setOutline({
            entries: native.entries,
            source: "native",
            loadStatus: "ready",
            stage: "idle",
            processedPages: 0,
            skipped: native.skipped,
            error: null,
          });
          return;
        }

        const result = await apiJson<{ outline: OutlineEntry[] | null }>(
          `/api/documents/${documentId}/outline`,
          { signal: controller.signal },
        );
        if (
          attempt !== outlineAttemptRef.current ||
          sessionRef.current !== sessionAtStart ||
          bridgeRef.current !== bridge
        ) {
          return;
        }
        if (result.outline && result.outline.length > 0) {
          setOutline({
            entries: outlineEntriesSchema.parse(result.outline),
            source: "generated",
            loadStatus: "ready",
            stage: "idle",
            processedPages: 0,
            skipped: 0,
            error: null,
          });
          return;
        }
        setOutline({
          ...emptyOutlineState(),
          loadStatus: "ready",
        });
      } catch (error) {
        if (
          attempt !== outlineAttemptRef.current ||
          controller.signal.aborted
        ) {
          return;
        }
        setOutline({
          ...emptyOutlineState(),
          loadStatus: "error",
          error: toUiError(error),
        });
      } finally {
        if (outlineControllerRef.current === controller) {
          outlineControllerRef.current = null;
        }
      }
    },
    [],
  );

  const cancelOutlineGeneration = useCallback(() => {
    outlineAttemptRef.current += 1;
    outlineControllerRef.current?.abort();
    outlineControllerRef.current = null;
    setOutline((previous) =>
      previous.stage === "generating"
        ? {
            ...previous,
            entries: [],
            stage: "idle",
            processedPages: 0,
            error: null,
          }
        : previous,
    );
  }, []);

  const generateOutline = useCallback(async (): Promise<void> => {
    const bridge = bridgeRef.current;
    const document = currentDocumentRef.current;
    const state = outlineRef.current;
    if (
      !bridge ||
      !document ||
      !viewerReadyRef.current ||
      previewOnlyRef.current ||
      modified ||
      bridge.hasEdits ||
      state.loadStatus !== "ready" ||
      state.stage !== "idle" ||
      state.entries.length > 0
    ) {
      return;
    }
    if (
      tasks.some(
        (task) =>
          task.documentId === document.id &&
          ["queued", "preparing", "generating", "saving"].includes(task.stage),
      )
    ) {
      return;
    }

    const sessionAtStart = sessionRef.current;
    const pageCount = bridge.pageCount;
    const confirmed = await ask({
      title: t.outline.generateTitle,
      body: t.outline.generateBody(pageCount),
      confirmLabel: t.outline.generateConfirm,
    });
    if (!confirmed) return;
    if (
      currentDocumentRef.current?.id !== document.id ||
      sessionRef.current !== sessionAtStart ||
      bridgeRef.current !== bridge ||
      !viewerReadyRef.current ||
      previewOnlyRef.current ||
      modified ||
      bridge.hasEdits ||
      outlineRef.current.stage !== "idle" ||
      outlineRef.current.entries.length > 0
    ) {
      return;
    }

    const attempt = ++outlineAttemptRef.current;
    const controller = new AbortController();
    outlineControllerRef.current = controller;
    setOutline({
      entries: [],
      source: null,
      loadStatus: "ready",
      stage: "generating",
      processedPages: 0,
      skipped: 0,
      error: null,
    });

    const entries: OutlineEntry[] = [];
    let saving = false;
    try {
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        if (
          attempt !== outlineAttemptRef.current ||
          controller.signal.aborted ||
          sessionRef.current !== sessionAtStart ||
          bridgeRef.current !== bridge ||
          currentDocumentRef.current?.id !== document.id
        ) {
          return;
        }

        const pageProxy = await bridge.getPage(pageNumber);
        let prepared: { text: string; imageBase64: string };
        try {
          prepared = await preparePageForTranslation(
            pageProxy,
            bridge.document,
            controller.signal,
          );
        } finally {
          if (pageNumber !== bridge.page) pageProxy.cleanup();
        }

        if (
          attempt !== outlineAttemptRef.current ||
          controller.signal.aborted ||
          sessionRef.current !== sessionAtStart ||
          bridgeRef.current !== bridge
        ) {
          return;
        }

        const previousHeadings = entries.slice(-32);
        const input: OutlinePageInput = {
          documentId: document.id,
          pageNumber,
          text: prepared.text,
          imageBase64: prepared.imageBase64,
          previousHeadings,
        };
        const response = await apiJson<{ headings: unknown }>(
          "/api/outline-page",
          { ...jsonInit("POST", input), signal: controller.signal },
        );
        if (
          attempt !== outlineAttemptRef.current ||
          controller.signal.aborted ||
          sessionRef.current !== sessionAtStart ||
          bridgeRef.current !== bridge
        ) {
          return;
        }

        const result = outlinePageResultSchema.parse(response);
        let previousLevel = previousHeadings.at(-1)?.level ?? 0;
        for (const heading of result.headings) {
          if (heading.level > previousLevel + 1) {
            throw new OutlineError(
              "OUTLINE_INVALID",
              "the model returned headings that skip a level",
            );
          }
          previousLevel = heading.level;
          entries.push({ ...heading, pageNumber });
        }
        if (entries.length > MAX_OUTLINE_ENTRIES) {
          throw new OutlineError("OUTLINE_INVALID", "the outline is too long");
        }

        setOutline((previous) =>
          previous.stage === "generating"
            ? { ...previous, processedPages: pageNumber }
            : previous,
        );
      }

      if (entries.length === 0) {
        setOutline((previous) => ({
          ...previous,
          entries: [],
          stage: "idle",
          processedPages: pageCount,
          error: { code: "OUTLINE_EMPTY" },
        }));
        return;
      }
      const complete = outlineEntriesSchema.parse(entries);

      saving = true;
      setOutline((previous) => ({
        ...previous,
        entries: complete,
        source: "generated",
        stage: "saving",
        processedPages: pageCount,
        error: null,
      }));
      const saved = await apiJson<{ outline: OutlineEntry[] }>(
        `/api/documents/${document.id}/outline`,
        { ...jsonInit("PUT", complete), signal: controller.signal },
      );
      if (
        attempt !== outlineAttemptRef.current ||
        sessionRef.current !== sessionAtStart ||
        currentDocumentRef.current?.id !== document.id
      ) {
        return;
      }
      const parsed = outlineEntriesSchema.parse(saved.outline);
      if (parsed.some((entry) => entry.pageNumber > pageCount)) {
        throw new OutlineError(
          "OUTLINE_INVALID",
          "the saved outline is outside the document",
        );
      }
      setOutline({
        entries: parsed,
        source: "generated",
        loadStatus: "ready",
        stage: "idle",
        processedPages: pageCount,
        skipped: 0,
        error: null,
      });
    } catch (error) {
      if (attempt !== outlineAttemptRef.current) return;
      if (controller.signal.aborted) return;
      const uiError = toUiError(error);
      setOutline((previous) =>
        saving
          ? { ...previous, stage: "unsaved", error: uiError }
          : {
              ...previous,
              entries: [],
              stage: "idle",
              processedPages: 0,
              error: uiError,
            },
      );
    } finally {
      if (outlineControllerRef.current === controller) {
        outlineControllerRef.current = null;
      }
    }
  }, [ask, modified, t, tasks]);

  const retrySaveOutline = useCallback(async (): Promise<void> => {
    const document = currentDocumentRef.current;
    const state = outlineRef.current;
    if (
      !document ||
      state.stage !== "unsaved" ||
      state.entries.length === 0
    ) {
      return;
    }
    const attempt = ++outlineAttemptRef.current;
    const controller = new AbortController();
    outlineControllerRef.current = controller;
    const sessionAtStart = sessionRef.current;
    const pageCount = bridgeRef.current?.pageCount ?? document.pageCount;
    setOutline((previous) => ({
      ...previous,
      stage: "saving",
      error: null,
    }));

    try {
      const saved = await apiJson<{ outline: OutlineEntry[] }>(
        `/api/documents/${document.id}/outline`,
        { ...jsonInit("PUT", state.entries), signal: controller.signal },
      );
      if (
        attempt !== outlineAttemptRef.current ||
        sessionRef.current !== sessionAtStart ||
        currentDocumentRef.current?.id !== document.id
      ) {
        return;
      }
      const parsed = outlineEntriesSchema.parse(saved.outline);
      if (parsed.some((entry) => entry.pageNumber > pageCount)) {
        throw new OutlineError(
          "OUTLINE_INVALID",
          "the saved outline is outside the document",
        );
      }
      setOutline({
        entries: parsed,
        source: "generated",
        loadStatus: "ready",
        stage: "idle",
        processedPages: state.processedPages,
        skipped: 0,
        error: null,
      });
    } catch (error) {
      if (attempt !== outlineAttemptRef.current) return;
      if (controller.signal.aborted) return;
      setOutline((previous) =>
        previous.stage === "saving"
          ? { ...previous, stage: "unsaved", error: toUiError(error) }
          : previous,
      );
    } finally {
      if (outlineControllerRef.current === controller) {
        outlineControllerRef.current = null;
      }
    }
  }, []);

  const discardOutline = useCallback(() => {
    outlineAttemptRef.current += 1;
    outlineControllerRef.current?.abort();
    outlineControllerRef.current = null;
    setOutline({ ...emptyOutlineState(), loadStatus: "ready" });
  }, []);

  const reloadOutline = useCallback(() => {
    const bridge = bridgeRef.current;
    const document = currentDocumentRef.current;
    if (!bridge || !document || !viewerReadyRef.current) return;
    void loadOutline(bridge, document.id, sessionRef.current, true);
  }, [loadOutline]);

  const openOutlinePage = useCallback(
    (pageNumber: number) => {
      const document = currentDocumentRef.current;
      if (!document) return;
      const total = bridgeRef.current?.pageCount ?? pageCount;
      const target = total > 0 ? clamp(pageNumber, 1, total) : pageNumber;
      if (bridgeRef.current && viewerReadyRef.current) {
        bridgeRef.current.setPage(target);
      }
      setPageValue(target);
      if (narrow) setNarrowTab("pdf");
      saveProgress(document.id, target, languageRef.current);
    },
    [narrow, pageCount, saveProgress, setPageValue],
  );

  const currentHasWork = useCallback(
    (documentId: string | null): { active: boolean; drafts: TranslationTask[] } => {
      const relevant = tasks.filter(
        (task) => documentId === null || task.documentId === documentId,
      );
      return {
        active: relevant.some((task) =>
          ["queued", "preparing", "generating", "saving"].includes(task.stage),
        ),
        drafts: relevant.filter((task) => task.stage === "unsaved"),
      };
    },
    [tasks],
  );

  const confirmSwitch = useCallback(async (): Promise<boolean> => {
    const document = currentDocumentRef.current;
    const { active, drafts } = currentHasWork(document?.id ?? null);
    const outlineActive =
      outline.stage === "generating" || outline.stage === "saving";
    const outlineUnsaved = outline.stage === "unsaved";
    if (
      !active &&
      !modified &&
      !previewOnly &&
      drafts.length === 0 &&
      !outlineActive &&
      !outlineUnsaved
    ) {
      return true;
    }
    const reasons = [
      active ? t.confirm.switchActive : null,
      drafts.length > 0 ? t.confirm.switchDrafts(drafts.length) : null,
      outlineActive ? t.confirm.switchOutlineActive : null,
      outlineUnsaved ? t.confirm.switchOutlineUnsaved : null,
      modified ? t.confirm.switchModified : null,
      previewOnly ? t.confirm.switchPreview : null,
    ].filter((value): value is string => value !== null);
    return ask({
      title: t.confirm.switchTitle,
      body: t.confirm.switchBody(reasons.join(t.common.listSeparator)),
      confirmLabel: t.confirm.switchConfirm,
      extraLabel: drafts.length > 0 ? t.confirm.exportDrafts : undefined,
      onExtra: () => exportDraftMarkdown(),
    });
  }, [ask, currentHasWork, modified, outline.stage, previewOnly, t]);

  const stopCurrentWork = useCallback(() => {
    queue.cancelAll();
    abortOutlineWork();
    watchCleanupRef.current?.();
    watchCleanupRef.current = null;
  }, [abortOutlineWork, queue]);

  const openDocument = useCallback(
    (document: DocumentRecord, targetPage: number, initial = false) => {
      const attempt = ++openAttemptRef.current;
      const run = async (): Promise<void> => {
        const clamped = clamp(targetPage, 1, document.pageCount);
        if (
          currentDocumentRef.current?.id === document.id &&
          bridgeRef.current &&
          viewerReadyRef.current
        ) {
          bridgeRef.current.setPage(clamped);
          setPageValue(clamped);
          saveProgress(document.id, clamped, languageRef.current);
          return;
        }
        if (!initial) {
          const confirmed = await confirmSwitch();
          if (!confirmed) return;
        }
        if (attempt !== openAttemptRef.current) return;

        await commitCurrentView();
        if (attempt !== openAttemptRef.current) return;
        stopCurrentWork();
        const pending = pendingRef.current;
        if (pending?.kind === "preview") URL.revokeObjectURL(pending.blobUrl);

        initialViewRef.current = DEFAULT_READER_VIEW;
        lastViewRef.current = null;
        viewTouchedRef.current = false;
        setViewRestoreFailed(false);
        selectDocument(document);
        setNarrowTab("pdf");
        setPageValue(clamped);
        setPageCount(document.pageCount);
        setPreviewOnly(false);
        previewOnlyRef.current = false;
        setModified(false);
        setViewerError(null);
        setImportError(null);
        setSaveCopyError(null);
        pendingRef.current = { kind: "library", document, page: clamped };
        passwordRef.current = null;
        sessionRef.current += 1;
        setSession(sessionRef.current);
        viewerReadyRef.current = false;
        setViewerReady(false);
      };
      void run();
    },
    [commitCurrentView, confirmSwitch, saveProgress, selectDocument, setPageCount, setPageValue, stopCurrentWork],
  );

  const openPreview = useCallback(
    async (file: File) => {
      const attempt = ++openAttemptRef.current;
      const validation = fileValidationError(file);
      if (validation) {
        setImportError(validation);
        return;
      }
      const confirmed = await confirmSwitch();
      if (!confirmed) return;
      if (attempt !== openAttemptRef.current) return;

      await commitCurrentView();
      if (attempt !== openAttemptRef.current) return;
      const blobUrl = URL.createObjectURL(file);
      stopCurrentWork();
      const previous = pendingRef.current;
      if (previous?.kind === "preview") URL.revokeObjectURL(previous.blobUrl);

      initialViewRef.current = DEFAULT_READER_VIEW;
      lastViewRef.current = null;
      viewTouchedRef.current = false;
      setViewRestoreFailed(false);
      selectDocument(null);
      setNarrowTab("pdf");
      setPageValue(1);
      setPageCount(0);
      setPreviewOnly(true);
      previewOnlyRef.current = true;
      setModified(false);
      setViewerError(null);
      setImportError(null);
      setSaveCopyError(null);
      pendingRef.current = { kind: "preview", file, blobUrl };
      passwordRef.current = null;
      sessionRef.current += 1;
      setSession(sessionRef.current);
      viewerReadyRef.current = false;
      setViewerReady(false);
    },
    [commitCurrentView, confirmSwitch, selectDocument, setPageCount, setPageValue, stopCurrentWork],
  );

  const loadPendingIntoViewer = useCallback(
    async (bridge: ViewerBridge) => {
      const pending = pendingRef.current;
      if (!pending) return;
      const sessionAtStart = sessionRef.current;
      try {
        if (pending.kind === "library") {
          const view = await resolveInitialView(
            pending.document.id,
            sessionAtStart,
          );
          if (
            pendingRef.current !== pending ||
            sessionRef.current !== sessionAtStart ||
            bridgeRef.current !== bridge
          ) {
            return;
          }
          initialViewRef.current = view;
          await bridge.openUrl(
            `${location.origin}/api/documents/${pending.document.id}/file`,
            token ?? "",
          );
        } else {
          initialViewRef.current = DEFAULT_READER_VIEW;
          const blobUrl = pending.blobUrl;
          try {
            await bridge.openBlobUrl(blobUrl);
          } finally {
            URL.revokeObjectURL(blobUrl);
          }
        }
      } catch (error) {
        if (pendingRef.current === pending) pendingRef.current = null;
        setViewerError(toUiError(error));
        viewerReadyRef.current = false;
        setViewerReady(false);
      }
    },
    [resolveInitialView, token],
  );

  const uploadPreview = useCallback(
    async (bridge: ViewerBridge, pending: Extract<PendingLoad, { kind: "preview" }>) => {
      const sessionAtStart = sessionRef.current;
      setPreviewUploadCount((count) => count + 1);
      setImportError(null);
      try {
        const query = new URLSearchParams({
          name: pending.file.name,
          pageCount: String(bridge.pageCount),
        });
        const record = await apiJson<DocumentRecord>(`/api/documents?${query}`, {
          method: "POST",
          headers: { "Content-Type": "application/pdf" },
          body: pending.file,
        });
        setLibrary((previous) =>
          previous
            ? {
                ...previous,
                documents: [
                  record,
                  ...previous.documents.filter((item) => item.id !== record.id),
                ],
              }
            : previous,
        );
        if (sessionAtStart !== sessionRef.current) return;
        pendingRef.current = null;
        previewOnlyRef.current = false;
        setPreviewOnly(false);
        selectDocument(record);
        setPageCount(record.pageCount);
        setPageValue(clamp(pageRef.current, 1, record.pageCount));
        saveProgress(record.id, pageRef.current, languageRef.current);
        void loadOutline(bridge, record.id, sessionAtStart);
        if (viewTouchedRef.current && captureCurrentView(record.id)) {
          scheduleViewSave();
          return;
        }
        const stored = await resolveInitialView(record.id, sessionAtStart);
        if (sessionAtStart !== sessionRef.current) return;
        if (viewTouchedRef.current) {
          if (captureCurrentView(record.id)) scheduleViewSave();
          return;
        }
        initialViewRef.current = stored;
        lastViewRef.current = stored;
        bridge.restoreView(stored);
      } catch (error) {
        if (sessionAtStart !== sessionRef.current) return;
        setImportError(toUiError(error));
        previewOnlyRef.current = true;
        setPreviewOnly(true);
      } finally {
        setPreviewUploadCount((count) => count - 1);
      }
    },
    [
      captureCurrentView,
      loadOutline,
      resolveInitialView,
      saveProgress,
      scheduleViewSave,
      selectDocument,
      setPageCount,
      setPageValue,
    ],
  );

  const handleBridge = useCallback(
    (bridge: ViewerBridge | null) => {
      bridgeRef.current = bridge;
      if (bridge) {
        void loadPendingIntoViewer(bridge);
      } else {
        abortOutlineWork();
      }
    },
    [abortOutlineWork, loadPendingIntoViewer],
  );

  const handleDocumentInit = useCallback(
    (bridge: ViewerBridge) => {
      const count = bridge.pageCount;
      if (!count) return;
      const pending = pendingRef.current;

      setPageCount(count);
      const actual = clamp(bridge.page || 1, 1, count);
      const target =
        pending?.kind === "library" ? clamp(pending.page, 1, count) : actual;

      if (bridge.page !== target) bridge.setPage(target);
      bridge.restoreView(initialViewRef.current);
      lastViewRef.current = initialViewRef.current;
      viewTouchedRef.current = false;
      bridge.setPage(target);

      viewerReadyRef.current = true;
      setViewerReady(true);
      setViewerError(null);
      watchCleanupRef.current?.();
      watchCleanupRef.current = bridge.watchModifications((isModified) => {
        if (isModified) modificationVersionRef.current += 1;
        setModified(isModified);
      });

      if (pending?.kind === "library") {
        setPageValue(target);
        setPreviewOnly(false);
        previewOnlyRef.current = false;
        pendingRef.current = null;
        selectDocument({
          ...pending.document,
          pageCount: count,
          currentPage: target,
        });
        saveProgress(pending.document.id, target, languageRef.current);
      } else if (pending?.kind === "preview") {
        setPageValue(target);
        previewOnlyRef.current = true;
        setPreviewOnly(true);
        void uploadPreview(bridge, pending);
      } else {
        setPageValue(target);
      }

      const outlineDocumentId = currentDocumentRef.current?.id;
      if (outlineDocumentId && !previewOnlyRef.current) {
        void loadOutline(bridge, outlineDocumentId, sessionRef.current);
      }
    },
    [
      loadOutline,
      saveProgress,
      selectDocument,
      setPageCount,
      setPageValue,
      uploadPreview,
    ],
  );

  useEffect(() => {
    if (pageBodyRef.current) pageBodyRef.current.scrollTop = 0;
  }, [page, language, currentDocument?.id]);

  const handlePageChange = useCallback(
    (nextPage: number) => {
      const total = bridgeRef.current?.pageCount ?? 0;
      const clamped = total > 0 ? clamp(nextPage, 1, total) : nextPage;
      setPageValue(clamped);
      if (viewerReadyRef.current && currentDocumentRef.current) {
        saveProgress(
          currentDocumentRef.current.id,
          clamped,
          languageRef.current,
        );
      }
    },
    [saveProgress, setPageValue],
  );

  const handleLanguageChange = useCallback(
    (nextLanguage: TargetLanguage) => {
      languageRef.current = nextLanguage;
      setLanguage(nextLanguage);
      if (currentDocumentRef.current) {
        saveProgress(
          currentDocumentRef.current.id,
          pageRef.current,
          nextLanguage,
        );
      }
    },
    [saveProgress],
  );

  const handleViewerError = useCallback((error: UiError) => {
    setViewerError(error);
    viewerReadyRef.current = false;
    setViewerReady(false);
  }, []);

  const translateCurrent = useCallback(
    async (force: boolean) => {
      const document = currentDocumentRef.current;
      if (!document || modified || previewOnlyRef.current) return;
      if (
        outlineRef.current.stage === "generating" ||
        outlineRef.current.stage === "saving"
      ) {
        return;
      }
      if (force) {
        const confirmed = await ask({
          title: t.confirm.retranslateTitle,
          body: t.confirm.retranslateBody,
          confirmLabel: t.confirm.retranslateConfirm,
        });
        if (!confirmed) return;
      }
      const request = queue.enqueue({
        documentId: document.id,
        pageNumber: pageRef.current,
        targetLanguage: languageRef.current,
        force,
        priority: "user",
      });
      if (request.stage === "queued" && queue.halt) queue.resume();
      if (narrow) setNarrowTab("translation");
    },
    [ask, modified, narrow, queue, t],
  );

  const markdownForCurrentPage = useCallback((): string | null => {
    if (!currentTask) {
      return storedState.record ? storedState.record.markdown.trim() : null;
    }
    if (currentTask.stage === "unsaved" && currentTask.draft) {
      return currentTask.draft.markdown.trim();
    }
    if (currentTask.saved?.markdown) {
      return currentTask.saved.markdown.trim();
    }
    if (storedState.record) return storedState.record.markdown.trim();
    return null;
  }, [currentTask, storedState.record]);

  const exportCurrentPage = useCallback(() => {
    const markdown = markdownForCurrentPage();
    const document = currentDocumentRef.current;
    if (!markdown) {
      setExportError({ code: "EXPORT_EMPTY" });
      return;
    }
    if (!document) return;
    triggerDownload(
      new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
      `${baseName(document.name)}-p${pageRef.current}-${languageRef.current}.md`,
    );
    setExportOpen(false);
  }, [markdownForCurrentPage]);

  const exportAllMarkdown = useCallback(async () => {
    const document = currentDocumentRef.current;
    if (!document) return;
    const exportLanguage = languageRef.current;
    setExportError(null);
    try {
      const records = await apiJson<TranslationRecord[]>(
        `/api/documents/${document.id}/translations?targetLanguage=${exportLanguage}`,
      );
      const byPage = new Map<number, string>();
      for (const record of records) {
        byPage.set(record.pageNumber, record.markdown.trim());
      }
      for (const task of tasks) {
        if (
          task.documentId !== document.id ||
          task.targetLanguage !== exportLanguage
        ) {
          continue;
        }
        if (task.stage === "unsaved" && task.draft) {
          byPage.set(task.pageNumber, task.draft.markdown.trim());
        } else if (task.stage === "saved" && task.saved?.markdown) {
          byPage.set(task.pageNumber, task.saved.markdown.trim());
        }
      }
      const pages = [...byPage.keys()].sort((a, b) => a - b);
      if (pages.length === 0) {
        setExportError({ code: "EXPORT_NONE" });
        return;
      }
      const parts: BlobPart[] = [];
      for (const pageNumber of pages) {
        if (parts.length > 0) parts.push("\n\n");
        parts.push(
          t.file.exportPageHeading(pageNumber),
          "\n\n",
          byPage.get(pageNumber) ?? "",
        );
      }
      triggerDownload(
        new Blob(parts, { type: "text/markdown;charset=utf-8" }),
        `${baseName(document.name)}-${exportLanguage}-translations.md`,
      );
      setExportOpen(false);
    } catch (error) {
      setExportError(toUiError(error));
    }
  }, [tasks, t]);

  const exportDraftMarkdown = useCallback((document?: DocumentRecord) => {
    const target = document ?? currentDocumentRef.current;
    if (!target) return;
    const drafts = tasks.filter(
      (task) =>
        task.documentId === target.id &&
        task.stage === "unsaved" &&
        task.draft,
    );
    if (drafts.length === 0) return;
    const content = drafts
      .sort(
        (a, b) =>
          a.pageNumber - b.pageNumber ||
          a.targetLanguage.localeCompare(b.targetLanguage),
      )
      .map(
        (task) =>
          `${t.file.exportDraftHeading(
            task.pageNumber,
            TARGET_LANGUAGE_LABELS[task.targetLanguage],
          )}\n\n${task.draft!.markdown.trim()}`,
      )
      .join("\n\n");
    triggerDownload(
      new Blob([content], { type: "text/markdown;charset=utf-8" }),
      `${baseName(target.name)}-unsaved.md`,
    );
  }, [tasks, t]);

  const uploadPdf = useCallback(
    async (body: Blob, name: string, count: number): Promise<DocumentRecord> => {
      const query = new URLSearchParams({ name, pageCount: String(count) });
      return apiJson<DocumentRecord>(`/api/documents?${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body,
      });
    },
    [],
  );

  const saveModifiedCopy = useCallback(async () => {
    const bridge = bridgeRef.current;
    const document = currentDocumentRef.current;
    if (!bridge || !document) return;
    setSavingCopy(true);
    setSaveCopyError(null);
    const sessionAtStart = sessionRef.current;
    const modificationVersionAtStart = modificationVersionRef.current;
    try {
      const bytes = await bridge.getSaveCopyBytes();
      const body = new Blob([bytes as unknown as BlobPart], {
        type: "application/pdf",
      });
      await validatePdfCopy(
        bytes,
        document.pageCount,
        pageRef.current,
        passwordRef.current ?? undefined,
      );
      const record = await uploadPdf(
        body,
        copyName(document.name, t.file.editedCopySuffix),
        document.pageCount,
      );
      setLibrary((previous) =>
        previous
          ? {
              ...previous,
              documents: [
                record,
                ...previous.documents.filter((item) => item.id !== record.id),
              ],
            }
          : previous,
      );
      if (sessionAtStart !== sessionRef.current) {
        setSavingCopy(false);
        return;
      }
      if (modificationVersionRef.current !== modificationVersionAtStart) {
        setSaveCopyError({ code: "COPY_CHANGED_DURING_SAVE" });
        setSavingCopy(false);
        return;
      }
      if (captureCurrentView(record.id)) scheduleViewSave();
      lastViewRef.current = null;
      viewTouchedRef.current = false;
      setViewRestoreFailed(false);
      openAttemptRef.current += 1;
      bridge.markSaved();
      setModified(false);
      selectDocument(record);
      setNarrowTab("pdf");
      pendingRef.current = {
        kind: "library",
        document: record,
        page: pageRef.current,
      };
      sessionRef.current += 1;
      setSession(sessionRef.current);
      viewerReadyRef.current = false;
      setViewerReady(false);
      setSavingCopy(false);
      saveProgress(record.id, pageRef.current, languageRef.current);
    } catch (error) {
      setSavingCopy(false);
      if (sessionAtStart === sessionRef.current) {
        setSaveCopyError(toUiError(error));
      }
    }
  }, [captureCurrentView, saveProgress, scheduleViewSave, selectDocument, t, uploadPdf]);

  const discardModifications = useCallback(async () => {
    const document = currentDocumentRef.current;
    if (!document || !modified) return;
    const confirmed = await ask({
      title: t.confirm.discardTitle,
      body: t.confirm.discardBody,
      confirmLabel: t.confirm.discardConfirm,
    });
    if (!confirmed) return;
    openAttemptRef.current += 1;
    stopCurrentWork();
    selectDocument(document);
    setPageValue(pageRef.current);
    setPageCount(document.pageCount);
    lastViewRef.current = null;
    viewTouchedRef.current = false;
    setModified(false);
    setSaveCopyError(null);
    setSavingCopy(false);
    setImportError(null);
    pendingRef.current = {
      kind: "library",
      document,
      page: pageRef.current,
    };
    sessionRef.current += 1;
    setSession(sessionRef.current);
    viewerReadyRef.current = false;
    setViewerReady(false);
  }, [ask, modified, selectDocument, setPageCount, setPageValue, stopCurrentWork, t]);

  const retryImport = useCallback(() => {
    const pending = pendingRef.current;
    const bridge = bridgeRef.current;
    if (pending?.kind === "preview" && bridge) {
      void uploadPreview(bridge, pending);
    }
  }, [uploadPreview]);

  const downloadDocument = useCallback(async (document: DocumentRecord) => {
    try {
      const response = await apiFetch(
        `/api/documents/${document.id}/file`,
      );
      const blob = await response.blob();
      triggerDownload(blob, document.name);
    } catch (error) {
      setDrawerError(toUiError(error));
    }
  }, []);

  const deleteDocument = useCallback(
    async (document: DocumentRecord) => {
      const deletingCurrent = currentDocumentRef.current?.id === document.id;
      const { active, drafts } = currentHasWork(document.id);
      const warnings = [
        deletingCurrent && active ? t.confirm.deleteActive : null,
        drafts.length > 0 ? t.confirm.deleteDrafts(drafts.length) : null,
        deletingCurrent && modified ? t.confirm.deleteModified : null,
      ].filter((value): value is string => value !== null);
      const confirmed = await ask({
        title: t.confirm.deleteTitle,
        body: t.confirm.deleteBody(
          document.name,
          warnings.join(t.common.listSeparator),
        ),
        confirmLabel: t.common.delete,
        ...(drafts.length > 0
          ? {
              extraLabel: t.confirm.exportDrafts,
              onExtra: () => exportDraftMarkdown(document),
            }
          : {}),
      });
      if (!confirmed) return;
      try {
        await apiFetch(`/api/documents/${document.id}`, { method: "DELETE" });
        deletedViewsRef.current.add(document.id);
        pendingViewsRef.current.delete(document.id);
        failedViewsRef.current.delete(document.id);
        savedViewsRef.current.delete(document.id);
        setViewSaveFailed(
          pendingViewsRef.current.size > 0 || failedViewsRef.current.size > 0,
        );
        setLibrary((previous) => {
          if (!previous) return previous;
          return {
            ...previous,
            documents: previous.documents.filter((item) => item.id !== document.id),
            settings: {
              ...previous.settings,
              lastDocumentId:
                previous.settings.lastDocumentId === document.id
                  ? null
                  : previous.settings.lastDocumentId,
            },
          };
        });
        queue.cancelDocument(document.id);
        if (currentDocumentRef.current?.id === document.id) {
          openAttemptRef.current += 1;
          abortOutlineWork();
          selectDocument(null);
          setPageCount(0);
          setPageValue(1);
          setViewRestoreFailed(false);
          pendingRef.current = null;
          previewOnlyRef.current = false;
          setPreviewOnly(false);
          setModified(false);
          setSaveCopyError(null);
          passwordRef.current = null;
          watchCleanupRef.current?.();
          watchCleanupRef.current = null;
          sessionRef.current += 1;
          setSession(sessionRef.current);
          viewerReadyRef.current = false;
          setViewerReady(false);
        }
      } catch (error) {
        setDrawerError(toUiError(error));
      }
    },
    [
      abortOutlineWork,
      ask,
      currentHasWork,
      exportDraftMarkdown,
      modified,
      queue,
      selectDocument,
      setPageCount,
      setPageValue,
      t,
    ],
  );

  useEffect(() => {
    const busy =
      modified ||
      previewOnly ||
      outline.stage !== "idle" ||
      tasks.some((task) =>
        ["queued", "preparing", "generating", "saving", "unsaved"].includes(task.stage),
      );
    if (!busy) return;
    const handler = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [modified, outline.stage, previewOnly, tasks]);

  useEffect(() => {
    const handler = (): void => {
      if (viewTimerRef.current !== null) {
        window.clearTimeout(viewTimerRef.current);
        viewTimerRef.current = null;
      }
      for (const [documentId, view] of pendingViewsRef.current) {
        void apiFetch(`/api/documents/${documentId}/view`, {
          ...jsonInit("PUT", view),
          keepalive: true,
        }).catch(() => {});
      }
    };
    window.addEventListener("pagehide", handler);
    return () => window.removeEventListener("pagehide", handler);
  }, []);

  useEffect(() => {
    return () => {
      const pending = pendingRef.current;
      if (pending?.kind === "preview") URL.revokeObjectURL(pending.blobUrl);
      if (viewTimerRef.current !== null) {
        window.clearTimeout(viewTimerRef.current);
        viewTimerRef.current = null;
      }
      watchCleanupRef.current?.();
      outlineAttemptRef.current += 1;
      outlineControllerRef.current?.abort();
      outlineControllerRef.current = null;
    };
  }, []);

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const workspace = workspaceRef.current;
    if (!workspace) return;
    // Capture so moves/up over the PDF iframe still reach the splitter.
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = workspace.getBoundingClientRect();
    const move = (moveEvent: PointerEvent): void => {
      const raw = (moveEvent.clientX - rect.left) / rect.width;
      const min = Math.max(0.35, 320 / rect.width);
      const max = Math.min(0.65, 1 - 320 / rect.width);
      setSplitRatio(clamp(raw, min, max));
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const resizeByKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.05 : 0.01;
    let next = splitRatio;
    if (event.key === "ArrowLeft") next -= step;
    else if (event.key === "ArrowRight") next += step;
    else if (event.key === "Home") next = 0.35;
    else if (event.key === "End") next = 0.65;
    else if (event.key === "Enter") next = 0.5;
    else return;
    event.preventDefault();
    const width = workspaceRef.current?.clientWidth ?? 1024;
    const min = Math.max(0.35, 320 / width);
    const max = Math.min(0.65, 1 - 320 / width);
    setSplitRatio(clamp(next, min, max));
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      void workspaceRef.current?.requestFullscreen();
    } else {
      void document.exitFullscreen();
    }
  };

  const outlineBusy =
    outline.stage === "generating" || outline.stage === "saving";
  const translationDisabledReason = !currentDocument
    ? previewOnly
      ? t.page.disabled.previewOnly
      : t.page.disabled.noPdf
    : !viewerReady || pageCount === 0
      ? t.page.disabled.loading
      : outlineBusy
        ? t.page.disabled.outlineBusy
        : modified
          ? t.page.disabled.modified
          : null;

  const outlineGenerationDisabledReason = !currentDocument
    ? null
    : translationDisabledReason ??
      (tasks.some(
        (task) =>
          task.documentId === currentDocument.id &&
          ["queued", "preparing", "generating", "saving"].includes(task.stage),
      )
        ? t.outline.disabledActive
        : null);

  const savedRecord =
    currentTask?.saved?.markdown
      ? currentTask.saved
      : storedState.record ?? null;
  const canRegenerate = Boolean(currentTask?.saved || storedState.record);
  const previewMarkdown =
    currentTask && ["generating", "saving"].includes(currentTask.stage)
      ? currentTask.preview
      : "";
  const hasExportable =
    Boolean(markdownForCurrentPage()) ||
    currentTask?.stage === "saved" ||
    currentTask?.stage === "unsaved";

  const pageStatus = (() => {
    if (currentTask) {
      switch (currentTask.stage) {
        case "queued":
        case "preparing":
        case "generating":
        case "saving":
        case "saved":
        case "unsaved":
          return t.stages[currentTask.stage];
        case "error":
          return savedRecord ? t.page.mode.saved : t.stages.error;
        case "cancelled":
          return savedRecord ? t.page.mode.saved : t.stages.cancelled;
        default:
          return "";
      }
    }
    if (previewOnly) return t.page.mode.notInLibrary;
    if (storedState.status === "loading") return t.page.mode.readingStored;
    if (storedState.status === "error") return t.page.mode.storedReadFailed;
    if (storedState.record) return t.page.mode.saved;
    return t.page.mode.notTranslated;
  })();

  const openTaskPage = useCallback(
    (task: TranslationTask) => {
      if (!currentDocumentRef.current || currentDocumentRef.current.id !== task.documentId) {
        return;
      }
      if (languageRef.current !== task.targetLanguage) {
        handleLanguageChange(task.targetLanguage);
      }
      if (bridgeRef.current && viewerReadyRef.current) {
        bridgeRef.current.setPage(task.pageNumber);
      }
      setPageValue(task.pageNumber);
      setRightTab("page");
      setNarrowTab("translation");
      saveProgress(task.documentId, task.pageNumber, task.targetLanguage);
    },
    [handleLanguageChange, saveProgress, setPageValue],
  );

  const localeApplyBlockedReason = (() => {
    if (
      tasks.some((task) =>
        ["queued", "preparing", "generating", "saving"].includes(task.stage),
      )
    ) {
      return t.settings.languageBlockedActive;
    }
    if (tasks.some((task) => task.stage === "unsaved")) {
      return t.settings.languageBlockedUnsaved;
    }
    if (outline.stage === "generating" || outline.stage === "saving") {
      return t.settings.languageBlockedOutline;
    }
    if (outline.stage === "unsaved") {
      return t.settings.languageBlockedOutlineUnsaved;
    }
    if (modified || bridgeRef.current?.hasEdits) {
      return t.settings.languageBlockedModified;
    }
    if (previewOnly) return t.settings.languageBlockedPreview;
    if (savingCopy || previewUploadCount > 0) {
      return t.settings.languageBlockedSaving;
    }
    return null;
  })();

  const applyUiLocale = useCallback(
    async (next: UiLocale): Promise<void> => {
      const blocked =
        tasks.some((task) =>
          ["queued", "preparing", "generating", "saving", "unsaved"].includes(
            task.stage,
          ),
        ) ||
        modified ||
        previewOnly ||
        outline.stage !== "idle" ||
        savingCopy ||
        previewUploadCount > 0 ||
        Boolean(bridgeRef.current?.hasEdits);
      if (blocked) throw { code: "LANGUAGE_RELOAD_BLOCKED" };
      await saveChainRef.current;
      if (!(await commitCurrentView())) throw { code: "VIEW_SAVE_FAILED" };
      const document = currentDocumentRef.current;
      await apiJson(
        "/api/reader",
        jsonInit(
          "PATCH",
          document
            ? {
                documentId: document.id,
                pageNumber: pageRef.current,
                targetLanguage: languageRef.current,
              }
            : {
                documentId: null,
                pageNumber: null,
                targetLanguage: languageRef.current,
              },
        ),
      );
      await saveUiLocale(next);
      location.reload();
    },
    [commitCurrentView, modified, outline.stage, previewOnly, previewUploadCount, savingCopy, tasks],
  );

  if (!token) {
    return (
      <div className="access-gate">
        <h1>{t.gates.accessTitle}</h1>
        <LocaleSwitch />
        <p>{t.gates.missingToken}</p>
        <p className="muted">{t.gates.tokenRotates}</p>
      </div>
    );
  }

  if (libraryLoading) {
    return (
      <div className="access-gate">
        <h1>{t.gates.accessTitle}</h1>
        <LocaleSwitch />
        <p>{t.gates.opening}</p>
      </div>
    );
  }

  if (libraryError || !library) {
    return (
      <div className="access-gate">
        <h1>{t.gates.libraryFailedTitle}</h1>
        <LocaleSwitch />
        <p role="alert">
          {libraryError
            ? errorText(libraryError, locale)
            : t.gates.libraryUnavailable}
        </p>
        <button type="button" onClick={() => location.reload()}>
          {t.gates.retry}
        </button>
      </div>
    );
  }

  const workspaceStyle = narrow
    ? undefined
    : {
        gridTemplateColumns: `minmax(320px, ${splitRatio}fr) 6px minmax(320px, ${
          1 - splitRatio
        }fr)`,
      };

  return (
    <div className="app-shell">
      <header className="app-bar">
        <span className="brand">{t.gates.accessTitle}</span>
        <button
          type="button"
          className="app-button"
          onClick={() => {
            setDrawerError(null);
            setDrawerOpen(true);
          }}
        >
          {t.appBar.library}
        </button>
        <button
          type="button"
          className="app-button"
          onClick={() => fileInputRef.current?.click()}
        >
          {t.appBar.openPdf}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void openPreview(file);
          }}
        />
        <span
          className="file-name"
          title={currentDocument?.name ?? t.appBar.noPdf}
        >
          {currentDocument?.name ??
            (previewOnly && pendingRef.current?.kind === "preview"
              ? pendingRef.current.file.name
              : t.appBar.noPdf)}
        </span>
        <span className="app-bar-spacer" />
        {modified && (
          <button
            type="button"
            className="app-button warning"
            onClick={() => void saveModifiedCopy()}
            disabled={savingCopy}
          >
            {savingCopy
              ? t.appBar.savingCopy
              : t.appBar.saveModifiedCopy}
          </button>
        )}
        {modified && (
          <button
            type="button"
            className="app-button"
            disabled={savingCopy}
            onClick={() => void discardModifications()}
          >
            {t.appBar.discardChanges}
          </button>
        )}
        <button
          type="button"
          className="app-button fullscreen-button"
          onClick={toggleFullscreen}
        >
          {t.appBar.fullscreen}
        </button>
        <button
          type="button"
          className="app-button settings-button"
          onClick={() => setSettingsOpen(true)}
        >
          {t.appBar.settings}
        </button>
      </header>

      {progressWarning && (
        <div className="app-banner warning" role="status">
          {t.banners.progressNotSaved}
        </div>
      )}
      {viewRestoreFailed && (
        <div className="app-banner warning" role="status">
          {t.banners.viewRestoreFailed}
          <button type="button" onClick={() => void retryViewRestore()}>
            {t.common.retry}
          </button>
        </div>
      )}
      {viewSaveFailed && (
        <div className="app-banner warning" role="status">
          {t.banners.viewNotSaved}
          <button type="button" onClick={retryViewSaves}>
            {t.common.retry}
          </button>
        </div>
      )}
      {saveCopyError && (
        <div className="app-banner error" role="alert">
          {errorText(saveCopyError, locale)}
        </div>
      )}
      {importError && (
        <div className="app-banner error" role="alert">
          {errorText(importError, locale)}
          {pendingRef.current?.kind === "preview" && (
            <button type="button" onClick={retryImport}>
              {t.banners.retryImport}
            </button>
          )}
        </div>
      )}

      <main
        ref={workspaceRef}
        className={`workspace${narrow ? " narrow" : ""}`}
        style={workspaceStyle}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const file = event.dataTransfer.files?.[0];
          if (file) void openPreview(file);
        }}
      >
        {narrow && (
          <nav
            className="mobile-tabs"
            role="tablist"
            aria-label={t.tabs.readingView}
          >
            <button
              type="button"
              role="tab"
              aria-selected={narrowTab === "pdf"}
              onClick={() => setNarrowTab("pdf")}
            >
              {t.tabs.original}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={narrowTab === "translation"}
              onClick={() => setNarrowTab("translation")}
            >
              {t.tabs.translation}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={narrowTab === "batch"}
              onClick={() => setNarrowTab("batch")}
            >
              {t.tabs.batch}
            </button>
          </nav>
        )}

        <section
          className="pdf-pane"
          aria-label={t.tabs.original}
          inert={narrow && narrowTab !== "pdf"}
          aria-hidden={narrow && narrowTab !== "pdf"}
        >
          <PdfViewerFrame
            sessionKey={session}
            locale={locale}
            title={currentDocument?.name ?? t.appBar.noPdf}
            onBridge={handleBridge}
            onDocumentInit={handleDocumentInit}
            onPageChange={handlePageChange}
            onViewChange={handleViewChange}
            onError={handleViewerError}
            onFilePicked={(file) => void openPreview(file)}
            onPassword={(password) => {
              passwordRef.current = password;
            }}
          />
          {!currentDocument && !previewOnly && viewerReady && (
            <div className="empty-hint">{t.empty.openPdf}</div>
          )}
          {viewerError && (
            <div className="viewer-error" role="alert">
              <p>{errorText(viewerError, locale)}</p>
              {currentDocument && (
                <button
                  type="button"
                  onClick={() =>
                    currentDocumentRef.current &&
                    openDocument(
                      currentDocumentRef.current,
                      pageRef.current,
                    )
                  }
                >
                  {t.viewer.reopen}
                </button>
              )}
            </div>
          )}
        </section>

        {!narrow && (
          <div
            className="splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label={t.splitter}
            aria-valuemin={35}
            aria-valuemax={65}
            aria-valuenow={Math.round(splitRatio * 100)}
            tabIndex={0}
            onPointerDown={beginResize}
            onDoubleClick={() => setSplitRatio(0.5)}
            onKeyDown={resizeByKeyboard}
          />
        )}

        <section
          className="side-pane"
          aria-label={t.tabs.translation}
          inert={narrow && narrowTab === "pdf"}
          aria-hidden={narrow && narrowTab === "pdf"}
        >
          {!narrow && (
            <div
              className="pane-tabs"
              role="tablist"
              aria-label={t.tabs.translationView}
            >
              <button
                type="button"
                role="tab"
                aria-selected={rightTab === "page"}
                onClick={() => setRightTab("page")}
              >
                {t.tabs.currentPage}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={rightTab === "batch"}
                onClick={() => setRightTab("batch")}
              >
                {t.tabs.batchTranslation}
              </button>
            </div>
          )}

          {(narrow ? narrowTab === "batch" : rightTab === "batch") ? (
            currentDocument ? (
              <BatchTranslationPanel
                document={currentDocument}
                pageCount={pageCount}
                currentPage={page}
                language={language}
                onLanguageChange={handleLanguageChange}
                tasks={tasks}
                queue={queue}
                onOpenTaskPage={openTaskPage}
                onConfirm={ask}
                disabledReason={translationDisabledReason}
                selection={selection}
                onSelectionChange={setSelection}
                outline={outline}
                outlineGenerationDisabledReason={outlineGenerationDisabledReason}
                onGenerateOutline={() => void generateOutline()}
                onCancelOutline={cancelOutlineGeneration}
                onReloadOutline={reloadOutline}
                onRetrySaveOutline={() => void retrySaveOutline()}
                onDiscardOutline={discardOutline}
                onOpenOutlinePage={openOutlinePage}
              />
            ) : (
              <div className="pane-placeholder">
                <p>{t.empty.batchHint}</p>
              </div>
            )
          ) : (
            <div className="page-panel">
              <div className="page-toolbar">
                <div className="page-position">
                  <strong>{t.common.pageOf(page, pageCount)}</strong>
                  <span className="muted">{t.page.actualOrder}</span>
                </div>
                <label className="language-field">
                  {t.page.targetLanguage}
                  <select
                    value={language}
                    onChange={(event) =>
                      handleLanguageChange(event.target.value as TargetLanguage)
                    }
                  >
                    {Object.entries(TARGET_LANGUAGE_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="page-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={
                      Boolean(translationDisabledReason) ||
                      ["queued", "preparing", "generating", "saving"].includes(
                        currentTask?.stage ?? "",
                      )
                    }
                    title={canRegenerate ? t.page.regenerateHint : undefined}
                    onClick={() => void translateCurrent(canRegenerate)}
                  >
                    {canRegenerate ? t.page.retranslate : t.page.translate}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setExportError(null);
                      setExportOpen(true);
                    }}
                    disabled={!hasExportable}
                  >
                    {t.page.export}
                  </button>
                </div>
              </div>

              <p className="page-status" aria-live="polite">
                {pageStatus}
                {currentTask?.cacheHit && currentTask.stage === "saved"
                  ? t.page.existingTranslation
                  : ""}
              </p>

              {translationDisabledReason && (
                <p className="field-error" role="status">
                  {translationDisabledReason}
                </p>
              )}

              <div className="page-body" ref={pageBodyRef}>
                {(!currentDocument || pageCount === 0) && (
                  <div className="pane-placeholder">
                    <p>{t.empty.noPdfOpen}</p>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      {t.appBar.openPdf}
                    </button>
                    <p className="muted">{t.empty.filesSaved}</p>
                  </div>
                )}

                {currentDocument && currentTask?.stage === "generating" && (
                  <div className="stream-preview">
                    {previewMarkdown ? (
                      <TranslationView markdown={previewMarkdown} streaming />
                    ) : (
                      <p className="muted">{t.page.waitingModel}</p>
                    )}
                    <button
                      type="button"
                      onClick={() => queue.cancel(currentTask.key)}
                    >
                      {t.page.cancelPage}
                    </button>
                  </div>
                )}

                {currentDocument &&
                  currentTask &&
                  ["queued", "preparing", "saving"].includes(currentTask.stage) && (
                    <div className="stream-preview">
                      <p className="muted">{t.stages[currentTask.stage]}…</p>
                    </div>
                  )}

                {currentDocument &&
                  !["queued", "preparing", "generating", "saving"].includes(
                    currentTask?.stage ?? "",
                  ) && (
                    <>
                      {currentTask?.stage === "unsaved" && currentTask.draft && (
                        <div className="unsaved-banner" role="alert">
                          <strong>{t.page.unsaved.title}</strong>
                          <p>{t.page.unsaved.body}</p>
                          {currentTask.error && (
                            <p role="alert">
                              {t.page.unsaved.saveFailed(
                                errorText(
                                  {
                                    code: currentTask.error.code,
                                    detail: currentTask.error.detail,
                                    params: currentTask.error.params,
                                  },
                                  locale,
                                ),
                              )}
                            </p>
                          )}
                          <div className="inline-actions">
                            <button
                              type="button"
                              onClick={() => queue.retry(currentTask.key)}
                            >
                              {t.page.retrySave}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setExportError(null);
                                setExportOpen(true);
                              }}
                            >
                              {t.page.export}
                            </button>
                            <button
                              type="button"
                              onClick={async () => {
                                const confirmed = await ask({
                                  title: t.confirm.discardDraftTitle,
                                  body: t.confirm.discardDraftBody,
                                  confirmLabel: t.confirm.discardDraftConfirm,
                                });
                                if (confirmed) queue.discard(currentTask.key);
                              }}
                            >
                              {t.page.discardDraft}
                            </button>
                          </div>
                          <TranslationView markdown={currentTask.draft.markdown} />
                        </div>
                      )}

                      {(currentTask?.stage === "error" ||
                        currentTask?.stage === "cancelled") && (
                        <div className="inline-error" role="alert">
                          <strong>
                            {currentTask.stage === "cancelled"
                              ? savedRecord
                                ? t.page.cancelledKept
                                : t.page.cancelled
                              : savedRecord
                                ? t.page.failedKept
                                : t.page.failed}
                          </strong>
                          {currentTask.error && (
                            <span>
                              {t.page.errorDetail(
                                errorText(
                                  {
                                    code: currentTask.error.code,
                                    detail: currentTask.error.detail,
                                    params: currentTask.error.params,
                                  },
                                  locale,
                                ),
                                currentTask.error.code,
                              )}
                            </span>
                          )}
                          <div className="inline-actions">
                            <button
                              type="button"
                              disabled={Boolean(translationDisabledReason)}
                              onClick={() => queue.retry(currentTask.key)}
                            >
                              {t.page.retry}
                            </button>
                          </div>
                        </div>
                      )}

                      {savedRecord && currentTask?.stage !== "unsaved" && (
                        <>
                          <TranslationView markdown={savedRecord.markdown} />
                          <p className="translation-meta">
                            {TARGET_LANGUAGE_LABELS[savedRecord.targetLanguage]} ·{" "}
                            {savedRecord.provider}/{savedRecord.model} ·{" "}
                            {formatDateTime(locale, savedRecord.translatedAt)}
                          </p>
                        </>
                      )}

                      {!savedRecord &&
                        currentTask?.stage !== "unsaved" &&
                        currentTask?.stage !== "error" &&
                        currentTask?.stage !== "cancelled" && (
                          <div className="pane-placeholder">
                            {storedState.status === "loading" && (
                              <p>{t.page.readingStored}</p>
                            )}
                            {storedState.status === "error" && (
                              <>
                                <p role="alert">
                                  {t.page.storedReadFailedTitle}
                                  {": "}
                                  {errorText(
                                    storedState.message ?? { code: "UNKNOWN" },
                                    locale,
                                  )}
                                </p>
                                <button
                                  type="button"
                                  onClick={() => setStoredReload((value) => value + 1)}
                                >
                                  {t.common.retry}
                                </button>
                              </>
                            )}
                            {storedState.status === "ready" && !storedState.record && (
                              <>
                                <p>{t.page.noTranslation}</p>
                                <p className="muted">{t.page.consent}</p>
                              </>
                            )}
                          </div>
                        )}
                    </>
                  )}
              </div>
            </div>
          )}
        </section>
      </main>

      <ModalDialog
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        label={t.library.title}
        className="library-dialog"
      >
        {drawerOpen && (
          <>
        <div className="dialog-heading">
          <h2>{t.library.title}</h2>
          <button type="button" onClick={() => setDrawerOpen(false)}>
            {t.common.close}
          </button>
        </div>
        <p className="muted">
          {t.library.dataDirectory} {library.dataDirectory}
        </p>
        {drawerError && (
          <p className="field-error" role="alert">
            {errorText(drawerError, locale)}
          </p>
        )}
        <ul className="library-list">
          {library.documents.length === 0 && (
            <li className="muted">{t.library.empty}</li>
          )}
          {library.documents.map((document) => (
            <li key={document.id} className="library-row">
              <button
                type="button"
                className="library-open"
                onClick={() => {
                  setDrawerOpen(false);
                  openDocument(document, document.currentPage);
                }}
              >
                <strong>{document.name}</strong>
                <span className="muted">
                  {t.library.pageCount(document.pageCount)}
                  {" · "}
                  {t.library.recentlyRead(
                    formatDateTime(locale, document.lastOpenedAt),
                  )}
                </span>
              </button>
              <div className="library-actions">
                <button
                  type="button"
                  onClick={() => void downloadDocument(document)}
                >
                  {t.common.download}
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => void deleteDocument(document)}
                >
                  {t.common.delete}
                </button>
              </div>
            </li>
          ))}
        </ul>
          </>
        )}
      </ModalDialog>

      <ModalDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        label={t.export.title}
      >
        <h2>{t.export.title}</h2>
        {exportError && (
          <p className="field-error" role="alert">
            {errorText(exportError, locale)}
          </p>
        )}
        <div className="dialog-actions vertical">
          <button type="button" onClick={exportCurrentPage}>
            {t.export.currentPage}
          </button>
          <button type="button" onClick={() => void exportAllMarkdown()}>
            {t.export.allPages}
          </button>
          <button type="button" onClick={() => setExportOpen(false)}>
            {t.common.cancel}
          </button>
        </div>
      </ModalDialog>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        uiLocale={locale}
        onApplyUiLocale={applyUiLocale}
        localeApplyBlockedReason={localeApplyBlockedReason}
        dataDirectory={library.dataDirectory}
      />

      <ConfirmDialog options={askState} onSettle={settleAsk} />
    </div>
  );
}
