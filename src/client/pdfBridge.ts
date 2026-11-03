import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import {
  outlineEntriesSchema,
  readerViewSchema,
  type OutlineEntry,
  type ReaderView,
} from "../shared/contracts";

export class ViewerBridgeError extends Error {
  constructor(
    readonly code:
      | "PDF_NOT_READY"
      | "PDF_VIEWER_UNAVAILABLE"
      | "PDF_OPEN_FAILED"
      | "OUTLINE_INVALID",
    message: string,
    readonly params?: Record<string, string | number>,
  ) {
    super(message);
    this.name = "ViewerBridgeError";
  }
}

export interface PdfEventBusLike {
  on(
    name: string,
    listener: (event: unknown) => void,
    options?: { once?: boolean },
  ): void;
  off(name: string, listener: (event: unknown) => void): void;
}

interface AnnotationStorageLike {
  size: number;
  onSetModified: (() => void) | null;
  readonly serializable: Readonly<{
    hash: string;
    transfer?: readonly ImageBitmap[];
  }>;
}

interface PdfDocumentLike {
  numPages: number;
  getData(): Promise<Uint8Array>;
  saveDocument(): Promise<Uint8Array>;
  getPage(pageNumber: number): Promise<PDFPageProxy>;
  getOutline: PDFDocumentProxy["getOutline"];
  getDestination: PDFDocumentProxy["getDestination"];
  getPageIndex: PDFDocumentProxy["getPageIndex"];
  cachedPageNumber: PDFDocumentProxy["cachedPageNumber"];
  annotationStorage: AnnotationStorageLike;
}

interface PdfViewerLike {
  currentScaleValue: string;
  pagesRotation: number;
  scrollMode: number;
  spreadMode: number;
  isInPresentationMode: boolean;
}

export interface PdfViewerApplicationLike {
  initializedPromise: Promise<void>;
  eventBus: PdfEventBusLike;
  pdfDocument?: PdfDocumentLike;
  pdfViewer: PdfViewerLike;
  page: number;
  pagesCount: number;
  open(args: {
    url?: string;
    data?: Uint8Array;
    httpHeaders?: Record<string, string>;
    originalUrl?: string;
    disableRange?: boolean;
    disableStream?: boolean;
    withCredentials?: boolean;
  }): Promise<void>;
}

export function viewerApplication(window: Window): PdfViewerApplicationLike | null {
  const candidate = (window as Window & { PDFViewerApplication?: unknown })
    .PDFViewerApplication;
  if (!candidate || typeof candidate !== "object") return null;
  return candidate as PdfViewerApplicationLike;
}

function annotationStorageHash(storage: AnnotationStorageLike): string {
  const serializable = storage.serializable;
  if (serializable.transfer) {
    for (const bitmap of serializable.transfer) bitmap.close();
  }
  return serializable.hash;
}

export interface ViewerEventHandlers {
  onDocumentInit?: () => void;
  onPageChanging?: (pageNumber: number) => void;
  onDocumentError?: (error: ViewerBridgeError) => void;
  onViewChanging?: (view: ReaderView) => void;
}

export class ViewerBridge {
  readonly #app: PdfViewerApplicationLike;
  readonly #window: Window;
  #modifiedListener: ((modified: boolean) => void) | null = null;
  #restoring = 0;

  constructor(app: PdfViewerApplicationLike, window: Window) {
    this.#app = app;
    this.#window = window;
  }

  get document(): Document {
    return this.#window.document;
  }

  get pageCount(): number {
    return this.#app.pdfDocument?.numPages ?? 0;
  }

  get page(): number {
    return this.#app.page;
  }

  get hasEdits(): boolean {
    return (this.#app.pdfDocument?.annotationStorage.size ?? 0) > 0;
  }

  async openUrl(url: string, token: string): Promise<void> {
    await this.#app.open({
      url,
      httpHeaders: { Authorization: `Bearer ${token}` },
      disableRange: true,
      disableStream: true,
      withCredentials: false,
    });
  }

  async openBlobUrl(url: string): Promise<void> {
    await this.#app.open({
      url,
      disableRange: true,
      disableStream: true,
      withCredentials: false,
    });
  }

  setPage(pageNumber: number): void {
    this.#app.page = pageNumber;
  }

  getView(): ReaderView {
    if (!this.#app.pdfDocument) {
      throw new ViewerBridgeError("PDF_NOT_READY", "PDF is not open");
    }
    const viewer = this.#app.pdfViewer;
    const parsed = readerViewSchema.safeParse({
      scaleValue: viewer.currentScaleValue,
      rotation: viewer.pagesRotation,
      scrollMode: viewer.scrollMode,
      spreadMode: viewer.spreadMode,
    });
    if (!parsed.success) {
      throw new ViewerBridgeError(
        "PDF_VIEWER_UNAVAILABLE",
        "the viewer reported an unsupported reading view",
      );
    }
    return parsed.data;
  }

  restoreView(view: ReaderView): void {
    const viewer = this.#app.pdfViewer;
    this.#restoring += 1;
    try {
      viewer.scrollMode = view.scrollMode;
      viewer.spreadMode = view.spreadMode;
      viewer.pagesRotation = view.rotation;
      viewer.currentScaleValue = view.scaleValue;
    } finally {
      this.#restoring -= 1;
    }
  }

  async getPage(pageNumber: number): Promise<PDFPageProxy> {
    const document = this.#app.pdfDocument;
    if (!document) throw new ViewerBridgeError("PDF_NOT_READY", "PDF is not open");
    return document.getPage(pageNumber);
  }

  async getOutline(): Promise<{ entries: OutlineEntry[]; skipped: number }> {
    const document = this.#app.pdfDocument;
    if (!document) throw new ViewerBridgeError("PDF_NOT_READY", "PDF is not open");

    type OutlineNode = Awaited<
      ReturnType<PDFDocumentProxy["getOutline"]>
    >[number];
    type PageRef = Parameters<PDFDocumentProxy["getPageIndex"]>[0];

    const resolvePage = async (
      dest: string | unknown[] | null,
    ): Promise<number | null> => {
      try {
        const explicit =
          typeof dest === "string" ? await document.getDestination(dest) : dest;
        if (!Array.isArray(explicit) || explicit.length === 0) return null;
        const ref = explicit[0];
        let pageNumber: number | null = null;
        if (typeof ref === "number") {
          if (Number.isInteger(ref)) pageNumber = ref + 1;
        } else if (ref && typeof ref === "object") {
          const pageRef = ref as PageRef;
          pageNumber = document.cachedPageNumber(pageRef);
          if (!pageNumber) pageNumber = (await document.getPageIndex(pageRef)) + 1;
        }
        if (
          pageNumber === null ||
          !Number.isSafeInteger(pageNumber) ||
          pageNumber < 1 ||
          pageNumber > document.numPages
        ) {
          return null;
        }
        return pageNumber;
      } catch {
        return null;
      }
    };

    let skipped = 0;
    const walk = async (
      nodes: OutlineNode[],
      level: number,
    ): Promise<OutlineEntry[]> => {
      const entries: OutlineEntry[] = [];
      for (const node of nodes) {
        const ownPage = await resolvePage(node.dest);
        const children = Array.isArray(node.items)
          ? await walk(node.items, level + 1)
          : [];
        const pageNumber = ownPage ?? children[0]?.pageNumber ?? null;
        if (pageNumber === null) {
          skipped += 1;
          continue;
        }
        const title = node.title.trim() || String(pageNumber);
        entries.push({ title, level, pageNumber });
        entries.push(...children);
      }
      return entries;
    };

    let nodes: Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>;
    try {
      nodes = await document.getOutline();
    } catch {
      throw new ViewerBridgeError(
        "PDF_OPEN_FAILED",
        "the PDF outline could not be read",
      );
    }

    try {
      const entries = nodes ? await walk(nodes, 1) : [];
      return {
        entries: entries.length > 0 ? outlineEntriesSchema.parse(entries) : [],
        skipped,
      };
    } catch (error) {
      if (error instanceof ViewerBridgeError) throw error;
      throw new ViewerBridgeError(
        "OUTLINE_INVALID",
        "the PDF outline could not be used",
      );
    }
  }

  async getSaveCopyBytes(): Promise<Uint8Array> {
    const document = this.#app.pdfDocument;
    if (!document) throw new ViewerBridgeError("PDF_NOT_READY", "PDF is not open");
    const storage = document.annotationStorage;
    const listener = this.#modifiedListener;
    const hashBefore = annotationStorageHash(storage);
    const bytes =
      storage.size > 0
        ? await document.saveDocument()
        : await document.getData();
    if (
      listener &&
      this.#modifiedListener === listener &&
      this.#app.pdfDocument === document &&
      annotationStorageHash(storage) !== hashBefore
    ) {
      listener(true);
    }
    return bytes;
  }

  markSaved(): void {
    this.#modifiedListener?.(false);
  }

  watchModifications(listener: (modified: boolean) => void): () => void {
    this.#modifiedListener = listener;
    const document = this.#app.pdfDocument;
    if (!document) return () => {};
    const storage = document.annotationStorage;
    const previousSet = storage.onSetModified;

    // Native download resets PDF.js's flag only; the app keeps its unsaved state.
    storage.onSetModified = () => {
      previousSet?.();
      listener(true);
    };

    return () => {
      storage.onSetModified = previousSet;
      this.#modifiedListener = null;
    };
  }

  subscribe(handlers: ViewerEventHandlers): () => void {
    const bus = this.#app.eventBus;
    const onDocumentInit = (): void => handlers.onDocumentInit?.();
    const onPageChanging = (event: unknown): void => {
      const pageNumber = (event as { pageNumber?: unknown }).pageNumber;
      if (typeof pageNumber === "number") handlers.onPageChanging?.(pageNumber);
    };
    const onDocumentError = (event: unknown): void => {
      const message = (event as { message?: unknown }).message;
      handlers.onDocumentError?.(
        new ViewerBridgeError(
          "PDF_OPEN_FAILED",
          typeof message === "string" ? message : "PDF could not be opened",
        ),
      );
    };
    const onViewChanging = (): void => {
      if (
        this.#restoring > 0 ||
        !this.#app.pdfDocument ||
        this.#app.pdfViewer.isInPresentationMode
      ) {
        return;
      }
      let view: ReaderView;
      try {
        view = this.getView();
      } catch {
        return;
      }
      handlers.onViewChanging?.(view);
    };

    bus.on("documentinit", onDocumentInit);
    bus.on("pagechanging", onPageChanging);
    bus.on("documenterror", onDocumentError);
    bus.on("scalechanging", onViewChanging);
    bus.on("rotationchanging", onViewChanging);
    bus.on("scrollmodechanged", onViewChanging);
    bus.on("spreadmodechanged", onViewChanging);
    return () => {
      bus.off("documentinit", onDocumentInit);
      bus.off("pagechanging", onPageChanging);
      bus.off("documenterror", onDocumentError);
      bus.off("scalechanging", onViewChanging);
      bus.off("rotationchanging", onViewChanging);
      bus.off("scrollmodechanged", onViewChanging);
      bus.off("spreadmodechanged", onViewChanging);
    };
  }

  destroy(): void {
    this.#modifiedListener = null;
  }
}

export async function waitForViewer(window: Window): Promise<ViewerBridge> {
  const app = viewerApplication(window);
  if (!app) {
    throw new ViewerBridgeError(
      "PDF_VIEWER_UNAVAILABLE",
      "PDF.js viewer did not expose PDFViewerApplication",
    );
  }
  await app.initializedPromise;
  return new ViewerBridge(app, window);
}
