import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  DEFAULT_EPUB_READER_VIEW,
  DEFAULT_PDF_READER_VIEW,
  MAX_OUTLINE_ENTRIES,
  outlineEntriesSchema,
  outlinePageResultSchema,
  readerViewSchema,
  TARGET_LANGUAGE_LABELS,
  type AiSettingsSnapshot,
  type DocumentRecord,
  type EpubReaderView,
  type LibrarySnapshot,
  type OutlineEntry,
  type OutlinePageInput,
  type ReaderUpdate,
  type ReaderView,
  type TargetLanguage,
  type TranslationContent,
  type TranslationRecord,
  type UiLocale,
} from "../../shared/contracts";
import {
  apiFetch,
  apiJson,
  accessToken,
  fetchAiSettings,
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
import { PagePreparationError, preparePageForTranslation, preparePdfTranslationPage, validatePdfCopy } from "../pdf";
import {
  findUntranslatedEpubSections,
  IDLE_EPUB_BATCH,
  isOpenTask,
  runEpubBatch,
  type EpubBatchState,
} from "../epub-batch";
import type {
  EpubBridge,
  EpubReadyInfo,
  EpubRelocation,
  EpubSelection,
  EpubTocEntry,
} from "../epub-bridge";
import { currentTocId, outlineFromEpubToc } from "../toc";
import { generationRequest, repairRequest } from "../translation-input";
import { watchPageKeys, type PageStep } from "../page-keys";
import { ViewerBridgeError, type ViewerBridge } from "../pdfBridge";
import { compileTypst, type TypstAsset } from "../typst";
import { stripPlaceholderControls } from "../../shared/typst";
import {
  compareEpubCfi,
  epubStyleOf,
  isEpubPageUnit,
  type EpubLayoutSnapshot,
  type EpubReaderStyle,
} from "../../shared/epub";
import JSZip from "jszip/dist/jszip.min.js";
import {
  emptyOutlineState,
  OutlineError,
  type DocumentOutlineState,
} from "../outline";
import {
  hasRetainedDraft,
  isActiveStage,
  TranslationQueue,
  translationKey,
  type TranslationTask,
} from "../translation-queue";
import { BatchTranslationPanel } from "./BatchTranslationPanel";
import { AI_SETTINGS_CODES, ErrorDetails } from "./ErrorDetails";
import { LayoutSwitch, type PaneMode } from "./LayoutSwitch";
import { Library } from "./Library";
import { TypstRepairPanel } from "./TypstRepairPanel";
import { ModalDialog } from "./ModalDialog";
import { EpubTocPanel } from "./EpubTocPanel";
import { EpubToolbar } from "./EpubToolbar";
import { EpubViewerFrame } from "./EpubViewerFrame";
import { PdfViewerFrame } from "./PdfViewerFrame";
import { SettingsDialog } from "./SettingsDialog";
import { TranslationView } from "./TranslationView";

type PendingLoad =
  | { kind: "library"; document: DocumentRecord; page: number }
  | { kind: "preview"; file: File; blobUrl: string };

interface StoredTranslationState {
  key: string;
  status: "idle" | "loading" | "ready" | "error";
  record?: TranslationRecord | null;
  message?: UiError;
}

type AiState =
  | { state: "loading" }
  | { state: "error"; error: UiError }
  | { state: "ready"; snapshot: AiSettingsSnapshot };

// The share of the width the left pane may take, and the splitter's own width.
const MIN_SPLIT = 0.2;
const MAX_SPLIT = 0.8;
const SPLITTER_WIDTH = 6;

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
  if (a.format !== b.format) return false;
  if (a.format === "epub" && b.format === "epub") {
    return (
      a.cfi === b.cfi &&
      a.fontSize === b.fontSize &&
      a.fontFamily === b.fontFamily &&
      a.lineHeight === b.lineHeight &&
      a.theme === b.theme
    );
  }
  if (a.format === "pdf" && b.format === "pdf") {
    return (
      a.scaleValue === b.scaleValue &&
      a.rotation === b.rotation &&
      a.scrollMode === b.scrollMode &&
      a.spreadMode === b.spreadMode
    );
  }
  return false;
}

function fileFormat(file: File): "pdf" | "epub" | null {
  const name = file.name.toLowerCase();
  if (file.type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (file.type === "application/epub+zip" || name.endsWith(".epub")) return "epub";
  return null;
}

function fileValidationError(file: File): UiError | null {
  const format = fileFormat(file);
  if (!format) return { code: "INVALID_DOCUMENT_FILE" };
  if (file.size === 0) return { code: "EMPTY_DOCUMENT_FILE" };
  return null;
}

const EPUB_STYLE_DEBOUNCE_MS = 120;

/** What the right pane shows for an EPUB: the screen page, a selection, or a range opened from the task list. */
interface EpubTarget {
  /** Spine index + 1; it only partitions translations and is not a page number. */
  pageNumber: number;
  unit: string;
  sourceCfi: string;
  epubPage?: { page: number; total: number };
  /** Set for a range opened from the task list: the layout its neighbouring excerpts belong to. */
  epubLayout?: EpubLayoutSnapshot;
}

function baseName(name: string): string {
  return name.replace(/\.(?:pdf|epub)$/i, "");
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
  const [screen, setScreen] = useState<"library" | "reader">("library");
  const screenRef = useRef<"library" | "reader">("library");

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
  const epubBridgeRef = useRef<EpubBridge | null>(null);
  const [epubSelection, setEpubSelection] = useState<EpubSelection | null>(null);
  const epubSelectionRef = useRef<EpubSelection | null>(null);
  const [epubToc, setEpubToc] = useState<readonly EpubTocEntry[]>([]);
  const [epubLocation, setEpubLocation] = useState<EpubRelocation | null>(null);
  const epubLocationRef = useRef<EpubRelocation | null>(null);
  // A range opened from the task list stays shown until the reader turns the page or selects text.
  const [epubPinned, setEpubPinned] = useState<EpubTarget | null>(null);
  const [epubFixedLayout, setEpubFixedLayout] = useState(false);
  const [epubStyle, setEpubStyle] = useState<EpubReaderStyle>(() =>
    epubStyleOf(DEFAULT_EPUB_READER_VIEW),
  );
  const epubStyleRef = useRef<EpubReaderStyle>(epubStyle);
  const epubStyleTimerRef = useRef<number | null>(null);
  const epubStyleInflightRef = useRef(0);
  const [epubStyleBusy, setEpubStyleBusy] = useState(false);
  const [epubTocOpen, setEpubTocOpen] = useState(false);
  const epubTocButtonRef = useRef<HTMLButtonElement | null>(null);
  const [epubActionError, setEpubActionError] = useState<UiError | null>(null);
  // Counts our own display/select/setView calls so their relocations do not clear a selection.
  const epubInternalNavRef = useRef(0);
  const [epubBatch, setEpubBatch] = useState<EpubBatchState>(IDLE_EPUB_BATCH);
  const epubBatchControllerRef = useRef<AbortController | null>(null);
  const isEpubDocument = currentDocument?.format === "epub";
  const epubTarget = useMemo<EpubTarget | null>(() => {
    if (!isEpubDocument) return null;
    if (epubPinned) return epubPinned;
    if (epubSelection) {
      return {
        pageNumber: epubSelection.sectionIndex + 1,
        unit: epubSelection.unit,
        sourceCfi: epubSelection.sourceCfi,
      };
    }
    if (epubLocation?.sourceCfi && epubLocation.unit) {
      return {
        pageNumber: epubLocation.sectionIndex + 1,
        unit: epubLocation.unit,
        sourceCfi: epubLocation.sourceCfi,
        epubPage: { page: epubLocation.page, total: epubLocation.total },
      };
    }
    return null;
  }, [isEpubDocument, epubPinned, epubSelection, epubLocation]);
  const currentUnit = epubTarget?.unit ?? "";
  const currentSourceCfi = epubTarget?.sourceCfi;
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
  const [paneMode, setPaneMode] = useState<PaneMode>("both");
  const [libraryActionError, setLibraryActionError] = useState<UiError | null>(null);
  const libraryRefreshRef = useRef<AbortController | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // What the server reports about the AI setup; every action that calls the model waits for it.
  const [ai, setAi] = useState<AiState>({ state: "loading" });
  const aiAttemptRef = useRef(0);
  const aiControllerRef = useRef<AbortController | null>(null);
  const aiGate =
    ai.state === "loading"
      ? "checking"
      : ai.state === "error"
        ? "failed"
        : ai.snapshot.status.configured
          ? "ready"
          : "unconfigured";
  const aiGateRef = useRef(aiGate);
  aiGateRef.current = aiGate;

  // A newer snapshot (from the settings dialog or a fresh read) supersedes any read still in flight.
  const showAiSnapshot = useCallback((snapshot: AiSettingsSnapshot) => {
    aiAttemptRef.current += 1;
    aiControllerRef.current?.abort();
    aiControllerRef.current = null;
    setAi({ state: "ready", snapshot });
  }, []);

  const refreshAiStatus = useCallback(async (retry: boolean): Promise<void> => {
    const attempt = ++aiAttemptRef.current;
    aiControllerRef.current?.abort();
    const controller = new AbortController();
    aiControllerRef.current = controller;
    if (retry) setAi({ state: "loading" });
    try {
      const snapshot = await fetchAiSettings(controller.signal);
      if (attempt === aiAttemptRef.current) setAi({ state: "ready", snapshot });
    } catch (error) {
      if (attempt !== aiAttemptRef.current) return;
      // A failed refresh keeps what is known; only a first read or an explicit retry reports the failure.
      setAi((current) =>
        current.state === "ready" ? current : { state: "error", error: toUiError(error) },
      );
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    void refreshAiStatus(false);
    return () => {
      aiAttemptRef.current += 1;
      aiControllerRef.current?.abort();
      aiControllerRef.current = null;
    };
  }, [refreshAiStatus, token]);

  // Opens the settings when the AI still needs setting up; true only when a model request may go out now.
  const requireAi = useCallback((): boolean => {
    const gate = aiGateRef.current;
    if (gate === "unconfigured") setSettingsOpen(true);
    else if (gate === "failed") void refreshAiStatus(true);
    return gate === "ready";
  }, [refreshAiStatus]);

  const changeLayout = useCallback((mode: PaneMode, ratio?: number) => {
    setPaneMode(mode);
    if (ratio !== undefined) setSplitRatio(ratio);
  }, []);

  // Below 1024px three tabs replace the panes: carry the single-pane choice over, and keep the layout for the way back.
  const wasNarrowRef = useRef(narrow);
  useEffect(() => {
    if (narrow && !wasNarrowRef.current) {
      if (paneMode === "left") setNarrowTab("pdf");
      else if (paneMode === "right") setNarrowTab(rightTab === "batch" ? "batch" : "translation");
    }
    wasNarrowRef.current = narrow;
  }, [narrow, paneMode, rightTab]);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportError, setExportError] = useState<UiError | null>(null);
  const [storedReload, setStoredReload] = useState(0);

  const [askState, setAskState] = useState<AskOptions | null>(null);
  const askResolver = useRef<((confirmed: boolean) => void) | null>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const pendingProgressRef = useRef<Map<string | null, ReaderUpdate>>(new Map());
  const progressDrainRef = useRef<Promise<void> | null>(null);
  const initialViewRef = useRef<ReaderView>(DEFAULT_PDF_READER_VIEW);
  const pendingViewsRef = useRef<Map<string, ReaderView>>(new Map());
  const failedViewsRef = useRef<Map<string, ReaderView>>(new Map());
  const savedViewsRef = useRef<Map<string, ReaderView>>(new Map());
  const deletedViewsRef = useRef<Set<string>>(new Set());
  const viewTouchedRef = useRef(false);
  const lastViewRef = useRef<ReaderView | null>(null);
  const runEpubCommand = useCallback(
    async (command: (bridge: EpubBridge) => Promise<void>): Promise<void> => {
      const bridge = epubBridgeRef.current;
      if (!bridge || !viewerReadyRef.current) return;
      // The same bridge serves every EPUB: only the session tells this book's call from the next one's.
      const sessionAtStart = sessionRef.current;
      const live = (): boolean =>
        epubBridgeRef.current === bridge && sessionRef.current === sessionAtStart;
      try {
        await command(bridge);
        if (live()) setEpubActionError(null);
      } catch (error) {
        const failure = toUiError(error);
        if (live() && failure.code !== "ABORTED") setEpubActionError(failure);
      }
    },
    [],
  );

  const navigateEpub = useCallback(
    (target: string | number) => {
      viewTouchedRef.current = true;
      setEpubPinned(null);
      void runEpubCommand((bridge) => bridge.display(target));
    },
    [runEpubCommand],
  );

  const stepEpub = useCallback(
    (direction: "next" | "prev") => {
      viewTouchedRef.current = true;
      setEpubPinned(null);
      void runEpubCommand((bridge) =>
        direction === "next" ? bridge.next() : bridge.prev(),
      );
    },
    [runEpubCommand],
  );

  // The one entry for an arrow-key page turn, from the page, the PDF and EPUB frames and the translation preview.
  const turnPage = useCallback(
    (direction: PageStep): boolean => {
      if (screenRef.current !== "reader" || !viewerReadyRef.current) return false;
      if (window.document.querySelector("dialog[open]")) return false;
      if (currentDocumentRef.current?.format === "epub") {
        const location = epubLocationRef.current;
        if (!location) return false;
        // At the first and last page the key is still consumed, so nothing else scrolls or moves.
        if (!(direction === "next" ? location.atEnd : location.atStart)) stepEpub(direction);
        return true;
      }
      const bridge = bridgeRef.current;
      if (!bridge || bridge.pageCount <= 0) return false;
      const target = clamp(bridge.page + (direction === "next" ? 1 : -1), 1, bridge.pageCount);
      if (target !== bridge.page) bridge.setPage(target);
      return true;
    },
    [stepEpub],
  );

  useEffect(() => watchPageKeys(window.document, (direction) => turnPage(direction)), [turnPage]);

  const clearEpubSelection = useCallback(() => {
    epubSelectionRef.current = null;
    setEpubSelection(null);
    epubBridgeRef.current?.clearSelection();
  }, []);

  const resetEpubState = useCallback(() => {
    epubSelectionRef.current = null;
    setEpubSelection(null);
    epubLocationRef.current = null;
    setEpubLocation(null);
    setEpubPinned(null);
    setEpubToc([]);
    setEpubFixedLayout(false);
    setEpubTocOpen(false);
    setEpubActionError(null);
    epubInternalNavRef.current = 0;
    if (epubStyleTimerRef.current !== null) {
      window.clearTimeout(epubStyleTimerRef.current);
      epubStyleTimerRef.current = null;
    }
    epubStyleInflightRef.current = 0;
    setEpubStyleBusy(false);
    const style = epubStyleOf(DEFAULT_EPUB_READER_VIEW);
    epubStyleRef.current = style;
    setEpubStyle(style);
    epubBatchControllerRef.current?.abort();
    epubBatchControllerRef.current = null;
    setEpubBatch(IDLE_EPUB_BATCH);
  }, []);

  // The layout neighbouring excerpts are measured against; captured when a task is queued.
  const captureEpubLayout = useCallback((): EpubLayoutSnapshot | null => {
    const bridge = epubBridgeRef.current;
    return bridge
      ? {
          width: bridge.viewport.width,
          height: bridge.viewport.height,
          style: epubStyleRef.current,
        }
      : null;
  }, []);

  // An unusable saved position falls back to the saved section and says so; it never silently opens the first page.
  const showEpubPosition = useCallback(
    async (
      bridge: EpubBridge,
      cfi: string | null,
      section: number,
    ): Promise<void> => {
      if (cfi) {
        try {
          await bridge.display(cfi);
          return;
        } catch (error) {
          if (toUiError(error).code !== "EPUB_NAVIGATION_FAILED") throw error;
          setViewRestoreFailed(true);
        }
      }
      await bridge.display(section - 1);
    },
    [],
  );

  // Applies a stored EPUB view again: the settings first, then the position.
  const restoreEpubView = useCallback(
    async (
      bridge: EpubBridge,
      view: EpubReaderView,
      sessionAtStart: number,
    ): Promise<void> => {
      const style = epubStyleOf(view);
      epubStyleRef.current = style;
      setEpubStyle(style);
      try {
        await bridge.setView(view);
        if (view.cfi) await bridge.display(view.cfi);
      } catch {
        if (
          sessionAtStart === sessionRef.current &&
          epubBridgeRef.current === bridge
        ) {
          setViewRestoreFailed(true);
        }
      }
    },
    [],
  );

  // Setting changes apply together after a short pause, so dragging through sizes lays out once.
  const changeEpubStyle = useCallback(
    (patch: Partial<EpubReaderStyle>) => {
      const bridge = epubBridgeRef.current;
      if (!bridge || !viewerReadyRef.current) return;
      const sessionAtStart = sessionRef.current;
      const live = (): boolean =>
        epubBridgeRef.current === bridge && sessionRef.current === sessionAtStart;
      epubStyleRef.current = { ...epubStyleRef.current, ...patch };
      setEpubStyle(epubStyleRef.current);
      setEpubStyleBusy(true);
      viewTouchedRef.current = true;
      if (epubStyleTimerRef.current !== null) {
        window.clearTimeout(epubStyleTimerRef.current);
      }
      epubStyleTimerRef.current = window.setTimeout(async () => {
        epubStyleTimerRef.current = null;
        if (!live()) return;
        epubStyleInflightRef.current += 1;
        epubInternalNavRef.current += 1;
        try {
          await bridge.setView({
            format: "epub",
            cfi: null,
            ...epubStyleRef.current,
          });
          if (live()) setEpubActionError(null);
        } catch (error) {
          const failure = toUiError(error);
          if (live() && failure.code !== "ABORTED") {
            setEpubActionError(failure);
          }
        } finally {
          // A later session's counters start at zero; this call only ever counted into its own.
          if (live()) {
            epubInternalNavRef.current -= 1;
            epubStyleInflightRef.current -= 1;
            if (
              epubStyleInflightRef.current === 0 &&
              epubStyleTimerRef.current === null
            ) {
              setEpubStyleBusy(false);
            }
          }
        }
      }, EPUB_STYLE_DEBOUNCE_MS);
    },
    [],
  );

  const resetEpubStyle = useCallback(
    () => changeEpubStyle(epubStyleOf(DEFAULT_EPUB_READER_VIEW)),
    [changeEpubStyle],
  );

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

  // The original files of one EPUB range's images; a PDF has none. Only the open book can answer.
  const assetsForSource = useCallback(
    async (
      documentId: string,
      sourceCfi: string | undefined,
      signal: AbortSignal,
    ): Promise<readonly TypstAsset[]> => {
      signal.throwIfAborted();
      if (!sourceCfi) return [];
      const bridge = epubBridgeRef.current;
      const current = currentDocumentRef.current;
      if (!bridge || current?.format !== "epub") {
        throw new PagePreparationError("EPUB_NOT_READY", "the EPUB is not open");
      }
      if (current.id !== documentId) {
        throw new PagePreparationError("DOCUMENT_CHANGED", "the document changed");
      }
      return bridge.assets(sourceCfi, signal);
    },
    [],
  );

  const queueRef = useRef<TranslationQueue | null>(null);
  if (!queueRef.current) {
    queueRef.current = new TranslationQueue({
      prepare: async (task, signal) => {
        const current = currentDocumentRef.current;
        if (current?.format === "epub") {
          const epub = epubBridgeRef.current;
          if (!epub) {
            throw new PagePreparationError("EPUB_NOT_READY", "the EPUB is not open");
          }
          if (current.id !== task.documentId) {
            throw new PagePreparationError("DOCUMENT_CHANGED", "the document changed");
          }
          if (!task.sourceCfi || !task.unit) {
            throw new PagePreparationError(
              "EPUB_PAGE_UNAVAILABLE",
              "the task has no page range",
            );
          }
          // Only a whole page gets neighbouring excerpts; a selection is sent alone.
          const wholePage = isEpubPageUnit(task.unit);
          if (wholePage && !task.epubLayout) {
            throw new PagePreparationError(
              "EPUB_PAGE_UNAVAILABLE",
              "the page layout was not captured",
            );
          }
          const prepared = await epub.prepare(
            task.sourceCfi,
            wholePage ? (task.epubLayout ?? null) : null,
            signal,
          );
          return { format: "epub" as const, ...prepared };
        }
        const bridge = bridgeRef.current;
        if (!bridge) {
          throw new PagePreparationError("PDF_NOT_READY", "PDF is not open");
        }
        if (previewOnlyRef.current) {
          throw new PagePreparationError("PDF_NOT_SAVED", "the PDF is not in the library yet");
        }
        if (!current || current.id !== task.documentId) {
          throw new PagePreparationError("DOCUMENT_CHANGED", "the document changed");
        }
        return preparePdfTranslationPage(bridge, task.pageNumber, signal);
      },
      translate: (task, prepared, signal, hooks) =>
        requestTranslation(generationRequest(task, prepared), {
          signal,
          onDelta: (chunk) => hooks.onDelta(chunk.contentIndex, chunk.text),
          onRepair: hooks.onRepair,
        }),
      repair: (task, repair, signal, hooks) =>
        requestTranslation(repairRequest(task, repair), {
          signal,
          onDelta: (chunk) => hooks.onDelta(chunk.contentIndex, chunk.text),
          onRepair: hooks.onRepair,
        }),
      validate: async (task, draft, signal) => {
        const assets = await assetsForSource(
          task.documentId,
          task.sourceCfi,
          signal,
        );
        await compileTypst(draft.typst, assets, signal);
      },
      save: (task, draft, signal) =>
        saveTranslationRecord(
          task.documentId,
          task.pageNumber,
          task.targetLanguage,
          draft,
          signal,
          task.unit,
          task.sourceCfi,
        ),
    });
  }
  const queue = queueRef.current;

  useEffect(() => queue.subscribe(bumpQueue), [queue]);
  useEffect(() => () => queue.cancelAll(), [queue]);

  useEffect(() => {
    setSelection(new Set());
    resetEpubState();
    const nextOutline = emptyOutlineState();
    outlineRef.current = nextOutline;
    setOutline(nextOutline);
    outlineLoadedSessionRef.current = -1;
    outlineAttemptRef.current += 1;
    outlineControllerRef.current?.abort();
    outlineControllerRef.current = null;
  }, [session, resetEpubState]);

  const tasks = useMemo(() => queue.getTasks(), [queue, queueVersion]);
  const targetPage = epubTarget?.pageNumber ?? page;
  const currentKey =
    currentDocument && (!isEpubDocument || epubTarget)
      ? translationKey(currentDocument.id, targetPage, language, currentUnit)
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
        task.saved?.typst &&
        task.saved.typst.length > 0
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
      // The old book's events and replies stop counting now, not only once the next one opens.
      epubBridgeRef.current?.invalidate();
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

  const currentViewSnapshot = useCallback((): ReaderView | null => {
    if (!viewerReadyRef.current) return null;
    if (currentDocumentRef.current?.format === "epub") {
      // Until a page is located there is no position to store; never overwrite one with none.
      const location = epubLocationRef.current;
      return location
        ? { format: "epub", cfi: location.startCfi, ...epubStyleRef.current }
        : null;
    }
    const bridge = bridgeRef.current;
    if (!bridge) return null;
    try {
      return bridge.getView();
    } catch {
      return null;
    }
  }, []);

  const commitCurrentView = useCallback(async (): Promise<boolean> => {
    const document = currentDocumentRef.current;
    const view = currentViewSnapshot();
    if (document && view) {
      const saved = savedViewsRef.current.get(document.id);
      if (!saved || !sameReaderView(saved, view)) {
        pendingViewsRef.current.set(document.id, view);
      }
    }
    return flushViewSaves();
  }, [currentViewSnapshot, flushViewSaves]);

  const resolveInitialView = useCallback(
    async (
      documentId: string,
      sessionAtStart: number,
      fallback: ReaderView = DEFAULT_PDF_READER_VIEW,
    ): Promise<ReaderView> => {
      const cached =
        pendingViewsRef.current.get(documentId) ??
        savedViewsRef.current.get(documentId);
      if (cached) return cached;
      try {
        const result = await apiJson<{ view: ReaderView | null }>(
          `/api/documents/${documentId}/view`,
        );
        if (sessionAtStart !== sessionRef.current) return fallback;
        const stored = result.view
          ? readerViewSchema.safeParse(result.view)
          : null;
        setViewRestoreFailed(false);
        if (!stored?.success) return fallback;
        savedViewsRef.current.set(documentId, stored.data);
        return stored.data;
      } catch {
        if (sessionAtStart === sessionRef.current) setViewRestoreFailed(true);
        return fallback;
      }
    },
    [],
  );

  const handleViewChange = useCallback(
    (view: ReaderView) => {
      if (screenRef.current !== "reader") return;
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
    if (!document || !viewerReadyRef.current) return;
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
        const view = currentViewSnapshot();
        if (view) {
          pendingViewsRef.current.set(document.id, view);
          void drainViewSaves();
        }
        return;
      }
      initialViewRef.current = stored.data;
      lastViewRef.current = stored.data;
      if (stored.data.format === "epub") {
        const bridge = epubBridgeRef.current;
        if (!bridge) return;
        await restoreEpubView(bridge, stored.data, sessionAtStart);
      } else {
        bridgeRef.current?.restoreView(stored.data);
      }
    } catch {
      if (sessionAtStart === sessionRef.current) setViewRestoreFailed(true);
    }
  }, [currentViewSnapshot, drainViewSaves, restoreEpubView]);

  const captureCurrentView = useCallback((documentId: string): boolean => {
    const view = currentViewSnapshot();
    if (!view) return false;
    pendingViewsRef.current.set(documentId, view);
    failedViewsRef.current.delete(documentId);
    return true;
  }, [currentViewSnapshot]);

  const showReader = useCallback(() => {
    libraryRefreshRef.current?.abort();
    libraryRefreshRef.current = null;
    if (screenRef.current === "reader") return;
    screenRef.current = "reader";
    setScreen("reader");
    const bridge = bridgeRef.current;
    if (bridge && viewerReadyRef.current) {
      bridge.setPage(pageRef.current);
      if (lastViewRef.current) bridge.restoreView(lastViewRef.current);
    }
    requestAnimationFrame(() => workspaceRef.current?.focus());
  }, []);

  const openLibrary = useCallback(() => {
    if (screenRef.current === "library") return;
    const document = currentDocumentRef.current;
    if (document) captureCurrentView(document.id);
    screenRef.current = "library";
    setScreen("library");
    libraryRefreshRef.current?.abort();
    const controller = new AbortController();
    libraryRefreshRef.current = controller;
    // Going to the Library cancels a book still being opened or uploaded: it joins the list but does not pull the user away.
    const attempt = ++openAttemptRef.current;
    void (async () => {
      try {
        await saveChainRef.current;
        await flushViewSaves();
      } catch {
        // Progress and view failures already surface through their banners.
      }
      if (
        controller.signal.aborted ||
        screenRef.current !== "library" ||
        attempt !== openAttemptRef.current
      ) {
        return;
      }
      try {
        const snapshot = await apiJson<LibrarySnapshot>("/api/library", {
          signal: controller.signal,
        });
        if (
          controller.signal.aborted ||
          screenRef.current !== "library" ||
          attempt !== openAttemptRef.current
        ) {
          return;
        }
        setLibrary(snapshot);
        setLibraryActionError(null);
      } catch (error) {
        if (controller.signal.aborted) return;
        setLibraryActionError(toUiError(error));
      }
    })();
  }, [captureCurrentView, flushViewSaves]);

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
    if (!currentDocument || !currentKey) {
      setStored({ key: "", status: "idle" });
      return;
    }
    const controller = new AbortController();
    setStored((previous) =>
      previous.key === currentKey
        ? previous
        : { key: currentKey, status: "loading" },
    );
    fetchTranslation(
      currentDocument.id,
      targetPage,
      language,
      controller.signal,
      currentUnit || undefined,
    )
      .then((record) => {
        if (controller.signal.aborted) return;
        setStored({ key: currentKey, status: "ready", record });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setStored({ key: currentKey, status: "error", message: toUiError(error) });
      });
    return () => controller.abort();
  }, [currentDocument?.id, currentKey, targetPage, language, currentUnit, storedReload]);

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
          isActiveStage(task.stage),
      )
    ) {
      return;
    }
    if (!requireAi()) return;

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
  }, [ask, modified, requireAi, t, tasks]);

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
      const total =
        document.format === "epub"
          ? pageCount
          : bridgeRef.current?.pageCount ?? pageCount;
      const target = total > 0 ? clamp(pageNumber, 1, total) : pageNumber;
      if (document.format === "epub") {
        navigateEpub(target - 1);
      } else {
        if (bridgeRef.current && viewerReadyRef.current) {
          bridgeRef.current.setPage(target);
        }
        setPageValue(target);
        saveProgress(document.id, target, languageRef.current);
      }
      if (narrow) setNarrowTab("pdf");
    },
    [narrow, navigateEpub, pageCount, saveProgress, setPageValue],
  );

  const currentHasWork = useCallback(
    (documentId: string | null): { active: boolean; drafts: TranslationTask[] } => {
      const relevant = tasks.filter(
        (task) => documentId === null || task.documentId === documentId,
      );
      return {
        active: relevant.some((task) => isActiveStage(task.stage)),
        drafts: relevant.filter((task) => hasRetainedDraft(task)),
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
      onExtra: () => exportDraftTypst(),
    });
  }, [ask, currentHasWork, modified, outline.stage, previewOnly, t]);

  const stopCurrentWork = useCallback(() => {
    queue.cancelAll();
    epubBatchControllerRef.current?.abort();
    epubBatchControllerRef.current = null;
    abortOutlineWork();
    watchCleanupRef.current?.();
    watchCleanupRef.current = null;
  }, [abortOutlineWork, queue]);

  const openDocument = useCallback(
    (document: DocumentRecord, targetPage: number) => {
      const attempt = ++openAttemptRef.current;
      const run = async (): Promise<void> => {
        const clamped = clamp(targetPage, 1, document.pageCount);
        if (
          currentDocumentRef.current?.id === document.id &&
          viewerReadyRef.current &&
          (document.format === "epub"
            ? epubBridgeRef.current
            : bridgeRef.current)
        ) {
          const current = pageRef.current;
          if (document.format !== "epub" && bridgeRef.current?.page !== current) {
            bridgeRef.current?.setPage(current);
          }
          setPageValue(current);
          saveProgress(document.id, current, languageRef.current);
          showReader();
          return;
        }
        const confirmed = await confirmSwitch();
        if (!confirmed) return;
        if (attempt !== openAttemptRef.current) return;

        await commitCurrentView();
        if (attempt !== openAttemptRef.current) return;
        showReader();
        stopCurrentWork();
        const pending = pendingRef.current;
        if (pending?.kind === "preview") URL.revokeObjectURL(pending.blobUrl);

        initialViewRef.current =
          document.format === "epub"
            ? DEFAULT_EPUB_READER_VIEW
            : DEFAULT_PDF_READER_VIEW;
        lastViewRef.current = null;
        viewTouchedRef.current = false;
        setViewRestoreFailed(false);
        selectDocument(document);
        setNarrowTab("pdf");
        setPageValue(clamped);
        setPageCount(document.pageCount);
        resetEpubState();
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
    [commitCurrentView, confirmSwitch, resetEpubState, saveProgress, selectDocument, setPageCount, setPageValue, showReader, stopCurrentWork],
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
      showReader();
      const blobUrl = URL.createObjectURL(file);
      stopCurrentWork();
      const previous = pendingRef.current;
      if (previous?.kind === "preview") URL.revokeObjectURL(previous.blobUrl);

      initialViewRef.current = DEFAULT_PDF_READER_VIEW;
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
    [commitCurrentView, confirmSwitch, selectDocument, setPageCount, setPageValue, showReader, stopCurrentWork],
  );

  const importEpub = useCallback(
    async (file: File) => {
      const validation = fileValidationError(file);
      if (validation) {
        setImportError(validation);
        return;
      }
      const attempt = ++openAttemptRef.current;
      const confirmed = await confirmSwitch();
      if (!confirmed) return;
      if (attempt !== openAttemptRef.current) return;
      await commitCurrentView();
      if (attempt !== openAttemptRef.current) return;
      setImportError(null);
      setPreviewUploadCount((count) => count + 1);
      try {
        const query = new URLSearchParams({
          name: file.name,
          format: "epub",
        });
        const record = await apiJson<DocumentRecord>(`/api/documents?${query}`, {
          method: "POST",
          headers: { "Content-Type": "application/epub+zip" },
          body: file,
        });
        // The book is stored whatever the user did meanwhile; only an untouched session opens it.
        libraryRefreshRef.current?.abort();
        libraryRefreshRef.current = null;
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
        if (attempt === openAttemptRef.current) openDocument(record, 1);
      } catch (error) {
        if (attempt === openAttemptRef.current) setImportError(toUiError(error));
      } finally {
        setPreviewUploadCount((count) => count - 1);
      }
    },
    [commitCurrentView, confirmSwitch, openDocument],
  );

  const openFile = useCallback(
    (file: File) => {
      if (fileFormat(file) === "epub") {
        void importEpub(file);
      } else {
        void openPreview(file);
      }
    },
    [importEpub, openPreview],
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
            DEFAULT_PDF_READER_VIEW,
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
          initialViewRef.current = DEFAULT_PDF_READER_VIEW;
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
          format: "pdf",
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
        const stored = await resolveInitialView(
          record.id,
          sessionAtStart,
          DEFAULT_PDF_READER_VIEW,
        );
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

  const handleViewerError = useCallback((error: UiError) => {
    setViewerError(error);
    viewerReadyRef.current = false;
    setViewerReady(false);
  }, []);

  const handleEpubBridge = useCallback((bridge: EpubBridge | null) => {
    epubBridgeRef.current = bridge;
  }, []);

  const handleEpubReady = useCallback(
    async (info: EpubReadyInfo) => {
      const document = currentDocumentRef.current;
      const bridge = epubBridgeRef.current;
      if (!document || document.format !== "epub" || !bridge) return;
      const sessionAtStart = sessionRef.current;
      const stillOpen = (): boolean =>
        sessionAtStart === sessionRef.current &&
        epubBridgeRef.current === bridge;
      setPageCount(info.sectionCount);
      setEpubToc(info.toc);
      setEpubFixedLayout(info.fixedLayout);
      setOutline({
        entries: outlineFromEpubToc(info.toc, info.sectionCount),
        source: "native",
        loadStatus: "ready",
        stage: "idle",
        processedPages: 0,
        skipped: 0,
        error: null,
      });
      const view = await resolveInitialView(
        document.id,
        sessionAtStart,
        DEFAULT_EPUB_READER_VIEW,
      );
      if (!stillOpen()) return;
      const stored = view.format === "epub" ? view : DEFAULT_EPUB_READER_VIEW;
      const pending = pendingRef.current;
      const section = clamp(
        pending?.kind === "library" ? pending.page : pageRef.current,
        1,
        info.sectionCount,
      );
      const style = epubStyleOf(stored);
      epubStyleRef.current = style;
      setEpubStyle(style);
      initialViewRef.current = stored;
      lastViewRef.current = stored;
      try {
        // The settings go in before the first layout, so the book is paginated once.
        await bridge.setView(stored);
        await showEpubPosition(bridge, stored.cfi, section);
      } catch (error) {
        if (stillOpen()) handleViewerError(toUiError(error));
        return;
      }
      if (!stillOpen()) return;
      const opened = epubLocationRef.current
        ? epubLocationRef.current.sectionIndex + 1
        : section;
      setPageValue(opened);
      viewTouchedRef.current = false;
      viewerReadyRef.current = true;
      setViewerReady(true);
      setViewerError(null);
      if (pending?.kind === "library") {
        pendingRef.current = null;
        selectDocument({
          ...document,
          pageCount: info.sectionCount,
          currentPage: opened,
        });
      }
      saveProgress(document.id, opened, languageRef.current);
    },
    [
      handleViewerError,
      resolveInitialView,
      saveProgress,
      selectDocument,
      setPageValue,
      showEpubPosition,
    ],
  );

  const handleEpubRelocated = useCallback(
    (info: EpubRelocation) => {
      const sectionChanged = pageRef.current !== info.sectionIndex + 1;
      epubLocationRef.current = info;
      setEpubLocation(info);
      setPageValue(info.sectionIndex + 1);
      if (!viewerReadyRef.current) return;
      // The page on screen is now the pinned range: nothing is left to pin.
      setEpubPinned((current) =>
        current && current.unit === info.unit ? null : current,
      );
      if (epubInternalNavRef.current === 0 && epubSelectionRef.current) {
        clearEpubSelection();
      }
      const view = currentViewSnapshot();
      if (view) handleViewChange(view);
      const document = currentDocumentRef.current;
      if (sectionChanged && document?.format === "epub") {
        saveProgress(document.id, info.sectionIndex + 1, languageRef.current);
      }
    },
    [
      clearEpubSelection,
      currentViewSnapshot,
      handleViewChange,
      saveProgress,
      setPageValue,
    ],
  );

  const handleEpubSelection = useCallback(
    (selection: EpubSelection | null) => {
      epubSelectionRef.current = selection;
      setEpubSelection(selection);
      if (selection) setEpubPinned(null);
    },
    [],
  );

  useEffect(() => {
    if (pageBodyRef.current) pageBodyRef.current.scrollTop = 0;
  }, [currentKey]);

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

  const translateCurrent = useCallback(
    async (force: boolean) => {
      const document = currentDocumentRef.current;
      if (!document || !currentKey || modified || previewOnlyRef.current) return;
      if (
        outlineRef.current.stage === "generating" ||
        outlineRef.current.stage === "saving"
      ) {
        return;
      }
      // Reading settings are still being applied: the page on screen is about to change.
      if (document.format === "epub" && (!epubTarget || epubStyleBusy)) return;
      const existing = queue.getTask(currentKey);
      if (existing && hasRetainedDraft(existing)) return;
      if (!requireAi()) return;
      if (force) {
        const confirmed = await ask({
          title: t.confirm.retranslateTitle,
          body: t.confirm.retranslateBody,
          confirmLabel: t.confirm.retranslateConfirm,
        });
        if (!confirmed) return;
      }
      // Neighbouring excerpts are measured with the layout the page was read in.
      const epubLayout =
        epubTarget && isEpubPageUnit(epubTarget.unit)
          ? (epubTarget.epubLayout ?? captureEpubLayout())
          : null;
      const request = queue.enqueue({
        documentId: document.id,
        pageNumber: epubTarget?.pageNumber ?? pageRef.current,
        targetLanguage: languageRef.current,
        ...(currentUnit ? { unit: currentUnit } : {}),
        ...(epubTarget
          ? {
              sourceCfi: epubTarget.sourceCfi,
              ...(epubLayout ? { epubLayout } : {}),
              ...(epubTarget.epubPage ? { epubPage: epubTarget.epubPage } : {}),
            }
          : {}),
        force,
        priority: "user",
      });
      if (request.stage === "queued" && queue.halt) queue.resume();
      if (narrow) setNarrowTab("translation");
    },
    [
      ask,
      captureEpubLayout,
      currentKey,
      currentUnit,
      epubStyleBusy,
      epubTarget,
      modified,
      narrow,
      queue,
      requireAi,
      t,
    ],
  );

  const savedRecord =
    currentTask?.saved?.typst
      ? currentTask.saved
      : storedState.record ?? null;
  const canRegenerate = Boolean(currentTask?.saved || storedState.record);

  const loadDisplayedAssets = useCallback(
    (signal: AbortSignal) =>
      assetsForSource(currentDocument?.id ?? "", currentSourceCfi, signal),
    [assetsForSource, currentDocument?.id, currentSourceCfi],
  );

  const editCurrentSource = useCallback(
    (typst: string) => {
      const document = currentDocumentRef.current;
      if (!document) return;
      const base = currentTask?.draft ?? savedRecord ?? storedState.record;
      if (!base) return;
      const content: TranslationContent = {
        typst,
        provider: base.provider,
        model: base.model,
      };
      queue.edit({
        documentId: document.id,
        pageNumber: targetPage,
        targetLanguage: languageRef.current,
        ...(currentUnit ? { unit: currentUnit } : {}),
        ...(epubTarget
          ? {
              sourceCfi: epubTarget.sourceCfi,
              ...(epubTarget.epubPage ? { epubPage: epubTarget.epubPage } : {}),
            }
          : {}),
        content,
        saved: savedRecord ?? undefined,
      });
    },
    [
      currentTask,
      currentUnit,
      epubTarget,
      queue,
      savedRecord,
      storedState.record,
      targetPage,
    ],
  );

  const saveCurrentDraft = useCallback(() => {
    if (currentKey) queue.retry(currentKey);
  }, [currentKey, queue]);

  const discardCurrentDraft = useCallback(async () => {
    if (!currentKey) return;
    const confirmed = await ask({
      title: t.confirm.discardDraftTitle,
      body: t.confirm.discardDraftBody,
      confirmLabel: t.confirm.discardDraftConfirm,
    });
    if (confirmed) queue.discard(currentKey);
  }, [ask, currentKey, queue, t]);

  // Splits the chosen sections into screen pages at the frozen layout and queues them as they are found.
  const startEpubBatch = useCallback(
    async (options: {
      sections: readonly number[];
      retranslate: boolean;
      saved: ReadonlySet<string>;
    }): Promise<void> => {
      const document = currentDocumentRef.current;
      const bridge = epubBridgeRef.current;
      const layout = captureEpubLayout();
      if (
        !document ||
        document.format !== "epub" ||
        !bridge ||
        !layout ||
        !viewerReadyRef.current ||
        epubBatchControllerRef.current
      ) {
        return;
      }
      if (!requireAi()) return;
      const language = languageRef.current;
      const controller = new AbortController();
      epubBatchControllerRef.current = controller;
      queue.resume();
      let found = 0;
      let queued = 0;
      setEpubBatch({ ...IDLE_EPUB_BATCH, status: "running" });
      try {
        const result = await runEpubBatch({
          bridge,
          layout,
          sectionIndexes: options.sections.map((section) => section - 1),
          documentId: document.id,
          language,
          retranslate: options.retranslate,
          saved: options.saved,
          isBusy: (pageNumber, unit) =>
            isOpenTask(
              queue.getTask(translationKey(document.id, pageNumber, language, unit)),
            ),
          confirmRetranslate: (count) =>
            ask({
              title: t.confirm.retranslateSavedTitle,
              body: t.confirm.retranslateSavedBody(count),
              confirmLabel: t.confirm.retranslateSavedConfirm,
            }),
          enqueue: (input) => {
            queued += 1;
            queue.enqueue(input);
          },
          onFound: (count) => {
            found = count;
            setEpubBatch({ status: "running", found, queued, error: null });
          },
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setEpubBatch(
          result
            ? { status: "done", found: result.found, queued: result.queued, error: null }
            : IDLE_EPUB_BATCH,
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        setEpubBatch({ status: "error", found, queued, error: toUiError(error) });
      } finally {
        if (epubBatchControllerRef.current === controller) {
          epubBatchControllerRef.current = null;
        }
      }
    },
    [ask, captureEpubLayout, queue, requireAi, t],
  );

  // Ticks every section that still has a screen page, at the current layout, without a saved translation.
  const selectUntranslatedEpubSections = useCallback(
    async (saved: ReadonlySet<string>): Promise<void> => {
      const document = currentDocumentRef.current;
      const bridge = epubBridgeRef.current;
      const layout = captureEpubLayout();
      if (
        !document ||
        document.format !== "epub" ||
        !bridge ||
        !layout ||
        !viewerReadyRef.current ||
        epubBatchControllerRef.current
      ) {
        return;
      }
      const controller = new AbortController();
      epubBatchControllerRef.current = controller;
      let found = 0;
      setEpubBatch({ ...IDLE_EPUB_BATCH, status: "running" });
      try {
        const sections = await findUntranslatedEpubSections({
          bridge,
          layout,
          sectionIndexes: Array.from({ length: pageCount }, (_, index) => index),
          saved,
          onFound: (count) => {
            found = count;
            setEpubBatch({ status: "running", found, queued: 0, error: null });
          },
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setSelection(new Set(sections));
        setEpubBatch(IDLE_EPUB_BATCH);
      } catch (error) {
        if (controller.signal.aborted) return;
        setEpubBatch({ status: "error", found, queued: 0, error: toUiError(error) });
      } finally {
        if (epubBatchControllerRef.current === controller) {
          epubBatchControllerRef.current = null;
        }
      }
    },
    [captureEpubLayout, pageCount],
  );

  const stopAllTranslation = useCallback(() => {
    epubBatchControllerRef.current?.abort();
    epubBatchControllerRef.current = null;
    setEpubBatch((previous) =>
      previous.status === "running" ? IDLE_EPUB_BATCH : previous,
    );
    queue.cancelAll();
  }, [queue]);

  const typstForCurrentPage = useCallback((): string | null => {
    if (!currentTask) {
      return storedState.record ? storedState.record.typst.trim() : null;
    }
    if (hasRetainedDraft(currentTask)) {
      return currentTask.draft.typst.trim();
    }
    if (currentTask.saved?.typst) {
      return currentTask.saved.typst.trim();
    }
    if (storedState.record) return storedState.record.typst.trim();
    return null;
  }, [currentTask, storedState.record]);

  // Adds the originals of one range's images; a path already in the archive is kept once.
  const addSourceAssets = useCallback(
    async (
      zip: JSZip,
      seen: Set<string>,
      documentId: string,
      sourceCfi: string | undefined,
      signal: AbortSignal,
    ): Promise<void> => {
      for (const asset of await assetsForSource(documentId, sourceCfi, signal)) {
        if (seen.has(asset.path)) continue;
        seen.add(asset.path);
        zip.file(asset.path, asset.data);
      }
    },
    [assetsForSource],
  );

  const exportCurrentPage = useCallback(async () => {
    const typst = typstForCurrentPage();
    const document = currentDocumentRef.current;
    if (!typst) {
      setExportError({ code: "EXPORT_EMPTY" });
      return;
    }
    if (!document) return;
    const name = `${baseName(document.name)}-${
      document.format === "epub"
        ? `s${targetPage}-${currentUnit.slice(0, 13)}`
        : `p${targetPage}`
    }-${languageRef.current}`;
    const controller = new AbortController();
    try {
      const assets = await assetsForSource(
        document.id,
        currentSourceCfi,
        controller.signal,
      );
      if (assets.length === 0) {
        triggerDownload(
          new Blob([stripPlaceholderControls(typst)], {
            type: "text/plain;charset=utf-8",
          }),
          `${name}.typ`,
        );
      } else {
        const zip = new JSZip();
        zip.file("main.typ", stripPlaceholderControls(typst));
        for (const asset of assets) zip.file(asset.path, asset.data);
        triggerDownload(await zip.generateAsync({ type: "blob" }), `${name}.zip`);
      }
      setExportOpen(false);
    } catch (error) {
      setExportError(toUiError(error));
    }
  }, [assetsForSource, currentSourceCfi, currentUnit, targetPage, typstForCurrentPage]);

  const exportAllTypst = useCallback(async () => {
    const document = currentDocumentRef.current;
    if (!document) return;
    const exportLanguage = languageRef.current;
    setExportError(null);
    const controller = new AbortController();
    try {
      const records = await apiJson<TranslationRecord[]>(
        `/api/documents/${document.id}/translations?targetLanguage=${exportLanguage}`,
      );
      // One file per saved page; selections stay out. An unsaved draft or a saved task replaces the stored text.
      const wholePage = (unit: string | undefined): boolean =>
        document.format === "epub" ? isEpubPageUnit(unit ?? "") : !unit;
      const entries = new Map<
        string,
        { pageNumber: number; unit: string; sourceCfi?: string; typst: string }
      >();
      const put = (
        pageNumber: number,
        unit: string | undefined,
        sourceCfi: string | undefined,
        typst: string,
      ): void => {
        entries.set(`${pageNumber}/${unit ?? ""}`, {
          pageNumber,
          unit: unit ?? "",
          ...(sourceCfi ? { sourceCfi } : {}),
          typst: typst.trim(),
        });
      };
      for (const record of records) {
        if (wholePage(record.unit)) {
          put(record.pageNumber, record.unit, record.sourceCfi, record.typst);
        }
      }
      for (const task of tasks) {
        if (
          task.documentId !== document.id ||
          task.targetLanguage !== exportLanguage ||
          !wholePage(task.unit)
        ) {
          continue;
        }
        if (hasRetainedDraft(task)) {
          put(task.pageNumber, task.unit, task.sourceCfi, task.draft.typst);
        } else if (task.stage === "saved" && task.saved?.typst) {
          put(task.pageNumber, task.unit, task.sourceCfi, task.saved.typst);
        }
      }
      const ordered = [...entries.values()].sort(
        (a, b) =>
          a.pageNumber - b.pageNumber ||
          compareEpubCfi(a.sourceCfi ?? "", b.sourceCfi ?? "") ||
          a.unit.localeCompare(b.unit),
      );
      if (ordered.length === 0) {
        setExportError({ code: "EXPORT_NONE" });
        return;
      }
      const zip = new JSZip();
      const seen = new Set<string>();
      // The running number keeps a sorted listing of the EPUB files in reading order.
      const width = String(ordered.length).length;
      for (const [index, entry] of ordered.entries()) {
        if (entry.typst === "") continue;
        const stem =
          document.format === "epub"
            ? `${String(index + 1).padStart(width, "0")}-s${entry.pageNumber}-${exportLanguage}`
            : `p${entry.pageNumber}-${exportLanguage}`;
        zip.file(`${stem}.typ`, stripPlaceholderControls(entry.typst));
        await addSourceAssets(zip, seen, document.id, entry.sourceCfi, controller.signal);
      }
      const blob = await zip.generateAsync({ type: "blob" });
      triggerDownload(
        blob,
        `${baseName(document.name)}-${exportLanguage}-translations.zip`,
      );
      setExportOpen(false);
    } catch (error) {
      setExportError(toUiError(error));
    }
  }, [addSourceAssets, tasks]);

  const exportDraftTypst = useCallback(
    async (document?: DocumentRecord) => {
      const target = document ?? currentDocumentRef.current;
      if (!target) return;
      const drafts = tasks
        .filter(
          (task) => task.documentId === target.id && hasRetainedDraft(task),
        )
        .sort(
          (a, b) =>
            a.pageNumber - b.pageNumber ||
            (a.unit ?? "").localeCompare(b.unit ?? "") ||
            a.targetLanguage.localeCompare(b.targetLanguage),
        );
      if (drafts.length === 0) return;
      const controller = new AbortController();
      try {
        const zip = new JSZip();
        const seen = new Set<string>();
        // shortcut: only the open book can supply image originals, so another book's drafts export as text; upgrade if exporting without opening is wanted.
        const withAssets = target.id === currentDocumentRef.current?.id;
        for (const task of drafts) {
          zip.file(
            `${target.format === "epub" ? "s" : "p"}${task.pageNumber}-${task.targetLanguage}${
              task.unit ? `-${task.unit}` : ""
            }.typ`,
            stripPlaceholderControls(task.draft!.typst),
          );
          if (withAssets) {
            await addSourceAssets(zip, seen, target.id, task.sourceCfi, controller.signal);
          }
        }
        triggerDownload(
          await zip.generateAsync({ type: "blob" }),
          `${baseName(target.name)}-unsaved.zip`,
        );
      } catch (error) {
        setExportError(toUiError(error));
      }
    },
    [addSourceAssets, tasks],
  );

  const uploadPdf = useCallback(
    async (body: Blob, name: string, count: number): Promise<DocumentRecord> => {
      const query = new URLSearchParams({
        name,
        pageCount: String(count),
        format: "pdf",
      });
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
    setLibraryActionError(null);
    try {
      const response = await apiFetch(
        `/api/documents/${document.id}/file`,
      );
      const blob = await response.blob();
      triggerDownload(blob, document.name);
    } catch (error) {
      setLibraryActionError(toUiError(error));
    }
  }, []);

  const deleteDocument = useCallback(
    async (document: DocumentRecord) => {
      setLibraryActionError(null);
      libraryRefreshRef.current?.abort();
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
              onExtra: () => exportDraftTypst(document),
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
        setLibraryActionError(toUiError(error));
      }
    },
    [
      abortOutlineWork,
      ask,
      currentHasWork,
      exportDraftTypst,
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
      epubBatch.status === "running" ||
      tasks.some(
        (task) => isActiveStage(task.stage) || hasRetainedDraft(task),
      );
    if (!busy) return;
    const handler = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [epubBatch.status, modified, outline.stage, previewOnly, tasks]);

  useEffect(() => {
    const handler = (): void => {
      if (viewTimerRef.current !== null) {
        window.clearTimeout(viewTimerRef.current);
        viewTimerRef.current = null;
      }
      const document = currentDocumentRef.current;
      const view = currentViewSnapshot();
      if (document && view && !previewOnlyRef.current) {
        pendingViewsRef.current.set(document.id, view);
      }
      for (const [documentId, pending] of pendingViewsRef.current) {
        void apiFetch(`/api/documents/${documentId}/view`, {
          ...jsonInit("PUT", pending),
          keepalive: true,
        }).catch(() => {});
      }
    };
    window.addEventListener("pagehide", handler);
    return () => window.removeEventListener("pagehide", handler);
  }, [currentViewSnapshot]);

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
      // The ratio is of the width without the splitter, centred under the pointer.
      const raw = (moveEvent.clientX - rect.left - SPLITTER_WIDTH / 2) / (rect.width - SPLITTER_WIDTH);
      setSplitRatio(clamp(raw, MIN_SPLIT, MAX_SPLIT));
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
    else if (event.key === "Home") next = MIN_SPLIT;
    else if (event.key === "End") next = MAX_SPLIT;
    else if (event.key === "Enter") next = 0.5;
    else return;
    event.preventDefault();
    setSplitRatio(clamp(next, MIN_SPLIT, MAX_SPLIT));
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
  const pageDisabledReason = !currentDocument
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
  const epubLocatingReason =
    isEpubDocument && (!epubTarget || epubStyleBusy)
      ? epubLocation && !epubStyleBusy
        ? t.page.disabled.noContent
        : t.page.disabled.locating
      : null;
  const translationDisabledReason =
    pageDisabledReason ??
    epubLocatingReason ??
    (currentTask && hasRetainedDraft(currentTask)
      ? t.page.disabled.unsavedDraft
      : null) ??
    (aiGate === "checking" ? t.ai.checking : null);
  // Until the AI is ready, the main button leads the way there instead of failing on its first request.
  const translateLabel =
    !translationDisabledReason && aiGate === "unconfigured"
      ? t.ai.configure
      : !translationDisabledReason && aiGate === "failed"
        ? t.ai.retryCheck
        : canRegenerate
          ? t.page.retranslate
          : currentUnit && !isEpubPageUnit(currentUnit)
            ? t.page.translateSelection
            : t.page.translate;

  const outlineGenerationDisabledReason =
    !currentDocument || currentDocument.format === "epub"
      ? null
      : pageDisabledReason ??
        (tasks.some(
          (task) =>
            task.documentId === currentDocument.id && isActiveStage(task.stage),
        )
          ? t.outline.disabledActive
          : null);

  const previewTypst =
    currentTask?.stage === "generating"
      ? currentTask.preview
      : currentTask?.stage === "repairing"
        ? currentTask.preview || currentTask.draft?.typst || ""
        : currentTask?.draft &&
            (currentTask.stage === "validating" || currentTask.stage === "saving")
          ? currentTask.draft.typst
          : "";
  const hasExportable =
    Boolean(typstForCurrentPage()) ||
    currentTask?.stage === "saved" ||
    Boolean(currentTask && hasRetainedDraft(currentTask));
  const retainedDraft =
    currentTask && hasRetainedDraft(currentTask) ? currentTask : null;
  const shownTypst = retainedDraft ? retainedDraft.draft.typst : savedRecord?.typst;

  const draftFailure = (() => {
    const error = currentTask?.error;
    if (!currentTask || !error || !hasRetainedDraft(currentTask)) return null;
    // The panel shows this failure's output once the latest round recorded it.
    const latestRound = currentTask.repairRounds?.at(-1);
    const summaryOnly =
      (latestRound?.status === "compile-failed" ||
        latestRound?.status === "request-failed") &&
      ["validating", "preparing", "repairing"].includes(error.stage ?? "");
    const detail = errorText({ code: error.code, params: error.params }, locale);
    const failure = (text: string) => ({
      text,
      error: summaryOnly ? { code: error.code } : error,
    });
    switch (error.stage) {
      case "validating":
        return failure(t.page.unsaved.validationFailed(detail));
      case "preparing":
      case "repairing":
        return failure(t.page.unsaved.repairFailed(detail));
      case "saving":
        return failure(t.page.unsaved.saveFailed(detail));
      default:
        return failure(t.page.unsaved.operationFailed(detail));
    }
  })();

  const pageStatus = (() => {
    if (currentTask) {
      switch (currentTask.stage) {
        case "queued":
        case "preparing":
        case "generating":
        case "repairing":
        case "validating":
        case "saving":
        case "saved":
        case "unsaved":
          return t.stages[currentTask.stage];
        case "error":
          return savedRecord ? t.page.mode.saved : t.stages.error;
        case "cancelled":
          return savedRecord && !hasRetainedDraft(currentTask)
            ? t.page.mode.saved
            : t.stages.cancelled;
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
      const document = currentDocumentRef.current;
      if (!document || document.id !== task.documentId) return;
      if (languageRef.current !== task.targetLanguage) {
        handleLanguageChange(task.targetLanguage);
      }
      if (document.format === "epub") {
        const { sourceCfi, unit } = task;
        if (sourceCfi && unit) {
          clearEpubSelection();
          setEpubPinned({
            pageNumber: task.pageNumber,
            unit,
            sourceCfi,
            ...(task.epubPage ? { epubPage: task.epubPage } : {}),
            ...(task.epubLayout ? { epubLayout: task.epubLayout } : {}),
          });
          viewTouchedRef.current = true;
          void runEpubCommand((bridge) => bridge.display(sourceCfi));
        }
      } else {
        if (bridgeRef.current && viewerReadyRef.current) {
          bridgeRef.current.setPage(task.pageNumber);
        }
        setPageValue(task.pageNumber);
        saveProgress(task.documentId, task.pageNumber, task.targetLanguage);
      }
      setRightTab("page");
      setNarrowTab("translation");
    },
    [clearEpubSelection, handleLanguageChange, runEpubCommand, saveProgress, setPageValue],
  );

  const closeEpubToc = useCallback(() => {
    setEpubTocOpen(false);
    epubTocButtonRef.current?.focus();
  }, []);

  const openEpubTocEntry = useCallback(
    (entry: EpubTocEntry) => {
      if (!entry.href) return;
      closeEpubToc();
      navigateEpub(entry.href);
    },
    [closeEpubToc, navigateEpub],
  );

  const epubSectionIndex = epubLocation?.sectionIndex ?? null;
  const epubChapter = useMemo(() => {
    if (!isEpubDocument) return null;
    const id = currentTocId(epubToc, epubSectionIndex);
    return epubToc.find((entry) => entry.id === id)?.label ?? null;
  }, [isEpubDocument, epubToc, epubSectionIndex]);

  const localeApplyBlockedReason = (() => {
    // A batch still locating its pages has queued nothing yet, but a reload would silently end it.
    if (epubBatch.status === "running" || tasks.some((task) => isActiveStage(task.stage))) {
      return t.settings.languageBlockedActive;
    }
    if (tasks.some((task) => hasRetainedDraft(task))) {
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
        epubBatchControllerRef.current !== null ||
        tasks.some(
          (task) => isActiveStage(task.stage) || hasRetainedDraft(task),
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

  const showLeft = narrow ? narrowTab === "pdf" : paneMode !== "right";
  const showRight = narrow ? narrowTab !== "pdf" : paneMode !== "left";
  const singlePane = narrow || paneMode !== "both";
  const panesStyle = singlePane
    ? undefined
    : {
        gridTemplateColumns: `minmax(0, ${splitRatio}fr) ${SPLITTER_WIDTH}px minmax(0, ${
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
          aria-current={screen === "library" ? "page" : undefined}
          onClick={openLibrary}
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
          accept="application/pdf,.pdf,application/epub+zip,.epub"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) openFile(file);
          }}
        />
        {screen === "reader" && (
          <span
            className="file-name"
            title={currentDocument?.name ?? t.appBar.noPdf}
          >
            {currentDocument?.name ??
              (previewOnly && pendingRef.current?.kind === "preview"
                ? pendingRef.current.file.name
                : t.appBar.noPdf)}
          </span>
        )}
        <span className="app-bar-spacer" />
        {screen === "reader" && modified && (
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
        {screen === "reader" && modified && (
          <button
            type="button"
            className="app-button"
            disabled={savingCopy}
            onClick={() => void discardModifications()}
          >
            {t.appBar.discardChanges}
          </button>
        )}
        {screen === "library" && (currentDocument || previewOnly) && (
          <button type="button" className="app-button" onClick={showReader}>
            {t.library.returnToReader}
          </button>
        )}
        {screen === "reader" && (
          <button
            type="button"
            className="app-button fullscreen-button"
            onClick={toggleFullscreen}
          >
            {t.appBar.fullscreen}
          </button>
        )}
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

      <div className="app-content">
        <Library
          documents={library.documents}
          active={screen === "library"}
          currentDocumentId={currentDocument?.id ?? null}
          currentPage={page}
          error={libraryActionError}
          onOpen={(document) => openDocument(document, document.currentPage)}
          onDownload={(document) => void downloadDocument(document)}
          onDelete={(document) => void deleteDocument(document)}
          onOpenPdf={() => fileInputRef.current?.click()}
          onDropPdf={(file) => openFile(file)}
        />
        {session > 0 && (
          <main
            ref={workspaceRef}
            className={`workspace${narrow ? " narrow" : ""}${screen === "library" ? " is-hidden" : ""}`}
            tabIndex={-1}
            inert={screen === "library"}
            aria-hidden={screen === "library"}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const file = event.dataTransfer.files?.[0];
              if (file) openFile(file);
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

        {!narrow && <LayoutSwitch mode={paneMode} ratio={splitRatio} onChange={changeLayout} />}

        <div className={`workspace-panes${singlePane ? " single" : ""}`} style={panesStyle}>

        <section
          className={`pdf-pane${isEpubDocument ? " epub-pane" : ""}`}
          aria-label={t.tabs.original}
          inert={!showLeft}
          aria-hidden={!showLeft}
        >
          {currentDocument?.format === "epub" ? (
            <>
              <EpubToolbar
                disabled={!viewerReady}
                tocOpen={epubTocOpen}
                tocId="epub-toc"
                tocButtonRef={epubTocButtonRef}
                onToggleToc={() => setEpubTocOpen((open) => !open)}
                atStart={epubLocation?.atStart ?? true}
                atEnd={epubLocation?.atEnd ?? true}
                onPrevious={() => stepEpub("prev")}
                onNext={() => stepEpub("next")}
                position={
                  epubLocation
                    ? {
                        section: epubLocation.sectionIndex + 1,
                        sections: pageCount,
                        page: epubLocation.page,
                        pages: epubLocation.total,
                      }
                    : null
                }
                style={epubStyle}
                fixedLayout={epubFixedLayout}
                onStyleChange={changeEpubStyle}
                onResetStyle={resetEpubStyle}
              />
              <div className="epub-stage">
                <EpubViewerFrame
                  sessionKey={session}
                  document={currentDocument}
                  title={currentDocument.name}
                  onBridge={handleEpubBridge}
                  onReady={(info) => void handleEpubReady(info)}
                  onRelocated={handleEpubRelocated}
                  onSelection={handleEpubSelection}
                  onError={handleViewerError}
                  onStep={turnPage}
                />
                {epubTocOpen && (
                  <EpubTocPanel
                    id="epub-toc"
                    toc={epubToc}
                    sectionIndex={epubSectionIndex}
                    onNavigate={openEpubTocEntry}
                    onClose={closeEpubToc}
                  />
                )}
              </div>
            </>
          ) : (
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
              onTurnPage={turnPage}
              onPassword={(password) => {
                passwordRef.current = password;
              }}
            />
          )}
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
          {!viewerError && epubActionError && (
            <div className="viewer-error" role="alert">
              <p>{t.epub.actionFailed(errorText(epubActionError, locale))}</p>
            </div>
          )}
        </section>

        {!narrow && paneMode === "both" && (
          <div
            className="splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label={t.splitter}
            aria-valuemin={Math.round(MIN_SPLIT * 100)}
            aria-valuemax={Math.round(MAX_SPLIT * 100)}
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
          inert={!showRight}
          aria-hidden={!showRight}
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
                disabledReason={pageDisabledReason}
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
                epubBatch={epubBatch}
                onStartEpubBatch={(options) => void startEpubBatch(options)}
                onSelectUntranslatedEpub={(saved) => void selectUntranslatedEpubSections(saved)}
                onStopAll={stopAllTranslation}
                aiStatus={ai.state === "ready" ? ai.snapshot.status : null}
                aiStatusError={ai.state === "error" ? ai.error : null}
                onConfigureAi={() => setSettingsOpen(true)}
                onRetryAiStatus={() => void refreshAiStatus(true)}
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
                  <strong>
                    {isEpubDocument
                      ? epubLocation
                        ? t.epub.position(
                            epubLocation.sectionIndex + 1,
                            pageCount,
                            epubLocation.page,
                            epubLocation.total,
                          )
                        : t.epub.locating
                      : t.common.pageOf(page, pageCount)}
                  </strong>
                  <span className="muted">
                    {isEpubDocument ? epubChapter : t.page.actualOrder}
                  </span>
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
                      Boolean(currentTask && isActiveStage(currentTask.stage))
                    }
                    title={canRegenerate ? t.page.regenerateHint : undefined}
                    onClick={() => void translateCurrent(canRegenerate)}
                  >
                    {translateLabel}
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

              {epubSelection && (
                <div className="epub-selection" role="status">
                  <span>
                    {t.page.selection(epubSelection.text.slice(0, 80))}
                  </span>
                  <button type="button" onClick={clearEpubSelection}>
                    {t.page.clearSelection}
                  </button>
                </div>
              )}

              {epubPinned && epubPinned.unit !== epubLocation?.unit && (
                <div className="epub-selection epub-range-note" role="status">
                  <span>
                    <strong>{t.page.originalRange}</strong>{" "}
                    {t.page.originalRangeNote(
                      t.batch.epub.taskPage(
                        epubPinned.pageNumber,
                        epubPinned.epubPage ?? null,
                        epubPinned.unit.slice(-6),
                      ),
                    )}
                  </span>
                  <button type="button" onClick={() => setEpubPinned(null)}>
                    {t.page.showVisiblePage}
                  </button>
                </div>
              )}

              {currentTask?.contextWarnings?.length &&
              (currentTask.stage === "saved" || currentTask.stage === "unsaved") ? (
                <p className="page-warning" role="status">
                  {t.page.contextWarning}
                </p>
              ) : null}

              {translationDisabledReason && (
                <p className="field-error" role="status">
                  {translationDisabledReason}
                </p>
              )}

              {!translationDisabledReason && aiGate === "unconfigured" && (
                <p className="field-error muted" role="status">
                  {t.ai.notConfigured}
                </p>
              )}

              {!translationDisabledReason && ai.state === "error" && (
                <p className="field-error" role="alert">
                  {t.ai.checkFailed(errorText(ai.error, locale))}
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

                {currentTask?.repairRounds && isActiveStage(currentTask.stage) && (
                  <TypstRepairPanel task={currentTask} />
                )}

                {currentDocument &&
                  currentTask &&
                  ["generating", "repairing", "validating", "saving"].includes(
                    currentTask.stage,
                  ) && (
                    <div className="stream-preview">
                      {["generating", "repairing", "validating"].includes(
                        currentTask.stage,
                      ) && (
                        <button
                          type="button"
                          onClick={() => queue.cancel(currentTask.key)}
                        >
                          {t.page.cancelPage}
                        </button>
                      )}
                      {previewTypst ? (
                        <TranslationView
                          typst={previewTypst}
                          loadAssets={loadDisplayedAssets}
                          streaming
                        />
                      ) : (
                        <p className="muted">{t.page.waitingModel}</p>
                      )}
                    </div>
                  )}

                {currentDocument &&
                  currentTask &&
                  ["queued", "preparing"].includes(currentTask.stage) && (
                    <div className="stream-preview">
                      <p className="muted">{t.stages[currentTask.stage]}…</p>
                    </div>
                  )}

                {currentDocument &&
                  !(currentTask && isActiveStage(currentTask.stage)) && (
                    <>
                      {currentTask &&
                        !hasRetainedDraft(currentTask) &&
                        (currentTask.stage === "error" ||
                          currentTask.stage === "cancelled") && (
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
                            <>
                              <span>
                                {errorText(
                                  { code: currentTask.error.code, params: currentTask.error.params },
                                  locale,
                                )}
                              </span>
                              <ErrorDetails error={currentTask.error} />
                            </>
                          )}
                          <div className="inline-actions">
                            {currentTask.error && AI_SETTINGS_CODES[currentTask.error.code] === true && (
                              <button type="button" onClick={() => setSettingsOpen(true)}>
                                {t.ai.openSettings}
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={Boolean(translationDisabledReason)}
                              onClick={() => {
                                if (requireAi()) queue.retry(currentTask.key);
                              }}
                            >
                              {t.page.retry}
                            </button>
                          </div>
                        </div>
                      )}

                      {shownTypst !== undefined && (
                        <div
                          className={retainedDraft ? "unsaved-banner" : undefined}
                          role={retainedDraft ? "alert" : undefined}
                        >
                          {retainedDraft && (
                            <>
                              <strong>
                                {retainedDraft.stage === "cancelled"
                                  ? t.page.cancelled
                                  : t.page.unsaved.title}
                              </strong>
                              <p>{t.page.unsaved.body}</p>
                              {draftFailure && (
                                <div role="alert">
                                  <p>{draftFailure.text}</p>
                                  <ErrorDetails error={draftFailure.error} />
                                </div>
                              )}
                              <div className="inline-actions">
                                <button
                                  type="button"
                                  onClick={() => queue.retry(retainedDraft.key)}
                                >
                                  {t.page.retrySave}
                                </button>
                                <button
                                  type="button"
                                  disabled={Boolean(pageDisabledReason)}
                                  onClick={() => {
                                    if (requireAi()) queue.repair(retainedDraft.key);
                                  }}
                                >
                                  {retainedDraft.repairRounds?.length
                                    ? t.page.continueRepair
                                    : t.page.repair}
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
                                    if (confirmed) queue.discard(retainedDraft.key);
                                  }}
                                >
                                  {t.page.discardDraft}
                                </button>
                              </div>
                              <p className="muted">{t.repair.note}</p>
                              {retainedDraft.repairRounds && (
                                <TypstRepairPanel task={retainedDraft} />
                              )}
                            </>
                          )}
                          {/* One mount for the saved text and its draft: the first keystroke turns one into the other and must not close the editor. */}
                          <TranslationView
                            key={currentKey}
                            typst={shownTypst}
                            loadAssets={loadDisplayedAssets}
                            dirty={retainedDraft !== null}
                            editingEnabled={!modified && !previewOnly}
                            onEdit={editCurrentSource}
                            onSave={saveCurrentDraft}
                            onDiscard={discardCurrentDraft}
                            onTurnPage={turnPage}
                          />
                          {!retainedDraft && savedRecord && (
                            <>
                              <p className="translation-meta">
                                {TARGET_LANGUAGE_LABELS[savedRecord.targetLanguage]} ·{" "}
                                {savedRecord.provider}/{savedRecord.model} ·{" "}
                                {formatDateTime(locale, savedRecord.translatedAt)}
                              </p>
                              {currentTask?.stage === "saved" &&
                                currentTask.repairRounds && (
                                  <TypstRepairPanel task={currentTask} />
                                )}
                            </>
                          )}
                        </div>
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
                                <p>{t.page.emptyGuide}</p>
                                <p className="muted">{t.page.consentSummary}</p>
                                <details className="consent-details">
                                  <summary>{t.page.consentDetails}</summary>
                                  <p className="muted">{t.page.consent}</p>
                                </details>
                              </>
                            )}
                            {storedState.status === "idle" && isEpubDocument && (
                              <p className="muted">
                                {epubLocation ? t.epub.noContent : t.epub.locating}
                              </p>
                            )}
                          </div>
                        )}
                    </>
                  )}
              </div>
            </div>
          )}
        </section>
        </div>
      </main>
        )}
      </div>

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
          <button type="button" onClick={() => void exportCurrentPage()}>
            {t.export.currentPage}
          </button>
          <button type="button" onClick={() => void exportAllTypst()}>
            {t.export.allPages}
          </button>
          <button type="button" onClick={() => setExportOpen(false)}>
            {t.common.cancel}
          </button>
        </div>
      </ModalDialog>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false);
          void refreshAiStatus(false);
        }}
        onSnapshotChange={showAiSnapshot}
        uiLocale={locale}
        onApplyUiLocale={applyUiLocale}
        localeApplyBlockedReason={localeApplyBlockedReason}
        dataDirectory={library.dataDirectory}
      />

      <ConfirmDialog options={askState} onSettle={settleAsk} />
    </div>
  );
}
