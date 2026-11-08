import { useEffect, useRef, useState } from "react";
import type { ReaderView, UiLocale } from "../../shared/contracts";
import { toUiError, useI18n, type UiError } from "../i18n";
import { watchPageKeys, type PageStep } from "../page-keys";
import { adaptPdfToolbar } from "../pdf-toolbar";
import { waitForViewer, type ViewerBridge } from "../pdfBridge";

const VIEWER_OPTIONS = {
  defaultUrl: "",
  enableScripting: false,
  disablePreferences: true,
  disableHistory: true,
  viewOnLoad: 1,
  externalLinkTarget: 2,
  defaultZoomValue: "",
  ignoreDestinationZoom: true,
  scrollModeOnLoad: 3,
  spreadModeOnLoad: 0,
  viewerCssTheme: 1,
  enableMerge: false,
  enableSplitMerge: false,
};

interface PdfViewerFrameProps {
  sessionKey: number;
  locale: UiLocale;
  title: string;
  onBridge: (bridge: ViewerBridge | null) => void;
  onDocumentInit: (bridge: ViewerBridge) => void;
  onPageChange: (page: number) => void;
  onViewChange: (view: ReaderView) => void;
  onError: (error: UiError) => void;
  onFilePicked: (file: File) => void;
  onTurnPage: (direction: PageStep) => boolean;
  onPassword?: (password: string) => void;
}

function isPdfFile(file: File): boolean {
  return (
    file.type === "application/pdf" ||
    (file.type === "" && file.name.toLowerCase().endsWith(".pdf"))
  );
}

function setViewerOptions(source: Window, values: Record<string, unknown>): void {
  if (!("PDFViewerApplicationOptions" in source)) return;
  const options = source.PDFViewerApplicationOptions;
  if (
    options &&
    (typeof options === "object" || typeof options === "function") &&
    "setAll" in options &&
    typeof options.setAll === "function"
  ) {
    options.setAll(values);
  }
}

// PDF.js sizes its toolbar for the pointer: 0 is the stock size, 2 the 44px size for fingers.
const toolbarDensity = (source: Window): number =>
  source.matchMedia("(pointer: coarse)").matches ? 2 : 0;

function applyViewerOptions(source: Window, locale: UiLocale): void {
  setViewerOptions(source, {
    ...VIEWER_OPTIONS,
    localeProperties: { lang: locale === "en" ? "en-US" : "zh-CN" },
    toolbarDensity: toolbarDensity(source),
  });
}

export function PdfViewerFrame({
  sessionKey,
  locale,
  title,
  onBridge,
  onDocumentInit,
  onPageChange,
  onViewChange,
  onError,
  onFilePicked,
  onTurnPage,
  onPassword,
}: PdfViewerFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const loadCleanupRef = useRef<(() => void) | null>(null);
  const loadIdRef = useRef(0);
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const { t } = useI18n();
  const toolsLabelRef = useRef(t.viewer.tools);
  toolsLabelRef.current = t.viewer.tools;
  const [listenerReady, setListenerReady] = useState(false);
  const callbacks = useRef({
    onBridge,
    onDocumentInit,
    onPageChange,
    onViewChange,
    onError,
    onFilePicked,
    onTurnPage,
    onPassword,
  });
  callbacks.current = {
    onBridge,
    onDocumentInit,
    onPageChange,
    onViewChange,
    onError,
    onFilePicked,
    onTurnPage,
    onPassword,
  };

  useEffect(() => {
    const onViewerLoaded = (event: Event): void => {
      const iframe = iframeRef.current;
      const source = (event as CustomEvent<{ source?: Window }>).detail?.source;
      if (!iframe || !source || source !== iframe.contentWindow) return;
      applyViewerOptions(source, localeRef.current);
    };
    document.addEventListener("webviewerloaded", onViewerLoaded);
    setListenerReady(true);
    return () => document.removeEventListener("webviewerloaded", onViewerLoaded);
  }, []);

  useEffect(() => {
    return () => {
      loadIdRef.current += 1;
      loadCleanupRef.current?.();
      loadCleanupRef.current = null;
      callbacks.current.onBridge(null);
    };
  }, [sessionKey]);

  const handleLoad = async (loadId: number): Promise<(() => void) | null> => {
    const iframe = iframeRef.current;
    const window = iframe?.contentWindow;
    const document = iframe?.contentDocument;
    if (!iframe || !window || !document) return null;
    document.documentElement.lang =
      localeRef.current === "en" ? "en-US" : "zh-CN";

    const onFileInput = (event: Event): void => {
      const target = event.target;
      if (
        !target ||
        typeof target !== "object" ||
        !("id" in target) ||
        target.id !== "fileInput" ||
        !("files" in target)
      ) {
        return;
      }
      // Same-document file input; the cast only restores the element type lost
      // by the structural check across the iframe realm.
      const input = target as unknown as HTMLInputElement;
      const file = input.files?.[0];
      event.preventDefault();
      event.stopPropagation();
      input.value = "";
      if (file && isPdfFile(file)) callbacks.current.onFilePicked(file);
    };

    const onDrop = (event: DragEvent): void => {
      const file = event.dataTransfer?.files?.[0];
      if (!file || !isPdfFile(file)) return;
      event.preventDefault();
      event.stopPropagation();
      callbacks.current.onFilePicked(file);
    };

    // Keep the password in memory only, to validate a saved copy.
    const onPasswordInput = (event: Event): void => {
      const target = event.target;
      if (
        target &&
        typeof target === "object" &&
        "id" in target &&
        target.id === "password" &&
        "value" in target &&
        typeof target.value === "string" &&
        target.value
      ) {
        callbacks.current.onPassword?.(target.value);
      }
    };
    const onPasswordSubmit = (event: Event): void => {
      const target = event.target;
      if (
        !target ||
        typeof target !== "object" ||
        !("id" in target) ||
        target.id !== "passwordSubmit"
      ) {
        return;
      }
      const input = document.querySelector("#password") as HTMLInputElement | null;
      if (input?.value) callbacks.current.onPassword?.(input.value);
    };

    document.addEventListener("change", onFileInput, true);
    document.addEventListener("drop", onDrop, true);
    document.addEventListener("input", onPasswordInput, true);
    document.addEventListener("click", onPasswordSubmit, true);
    const stopKeys = watchPageKeys(document, (direction, event) => {
      // PDF.js dialogs and annotation editors keep their own arrow keys.
      if (document.querySelector("dialog[open]")) return false;
      if ((event.target as Element | null)?.closest?.(".annotationEditorLayer")) return false;
      return callbacks.current.onTurnPage(direction);
    });
    const stopToolbar = adaptPdfToolbar(window, toolsLabelRef.current);
    const coarse = window.matchMedia("(pointer: coarse)");
    const onCoarseChange = (): void =>
      setViewerOptions(window, { toolbarDensity: toolbarDensity(window) });
    coarse.addEventListener("change", onCoarseChange);

    let cancelled = false;
    let bridge: ViewerBridge | null = null;
    let unsubscribe: (() => void) | null = null;

    const cleanup = (): void => {
      cancelled = true;
      document.removeEventListener("change", onFileInput, true);
      document.removeEventListener("drop", onDrop, true);
      document.removeEventListener("input", onPasswordInput, true);
      document.removeEventListener("click", onPasswordSubmit, true);
      stopKeys();
      stopToolbar();
      coarse.removeEventListener("change", onCoarseChange);
      unsubscribe?.();
      bridge?.destroy();
    };

    const stale = (): boolean =>
      cancelled || loadId !== loadIdRef.current || iframeRef.current !== iframe || !iframe.isConnected;

    try {
      bridge = await waitForViewer(window);
      if (stale()) {
        bridge.destroy();
        return cleanup;
      }
      const currentBridge = bridge;
      unsubscribe = currentBridge.subscribe({
        onDocumentInit: () => callbacks.current.onDocumentInit(currentBridge),
        onPageChanging: (page) => callbacks.current.onPageChange(page),
        onViewChanging: (view) => callbacks.current.onViewChange(view),
        onDocumentError: (failure) => callbacks.current.onError(toUiError(failure)),
      });
      callbacks.current.onBridge(currentBridge);
    } catch (error) {
      if (!stale()) {
        callbacks.current.onError(toUiError(error));
      }
    }

    return cleanup;
  };

  if (!listenerReady) return null;

  return (
    <iframe
      key={sessionKey}
      ref={iframeRef}
      className="pdf-frame"
      title={title}
      src="/pdfjs/web/viewer.html"
      referrerPolicy="no-referrer"
      allow="fullscreen"
      onLoad={() => {
        loadCleanupRef.current?.();
        const loadId = ++loadIdRef.current;
        void handleLoad(loadId).then((cleanup) => {
          if (loadId !== loadIdRef.current) {
            cleanup?.();
            return;
          }
          loadCleanupRef.current = cleanup;
        });
      }}
    />
  );
}
