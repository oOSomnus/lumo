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
  getPageView(index: number): unknown;
  scrollPageIntoView(options: {
    pageNumber: number;
    destArray: unknown[];
    allowNegativeOffset?: boolean;
    ignoreDestinationZoom?: boolean;
  }): void;
}

/** One node of the tree PDF.js renders in its outline sidebar. */
export interface PdfJsOutlineNode {
  title: string;
  dest: unknown[] | string | null;
  items: PdfJsOutlineNode[];
  count?: number;
  bold?: boolean;
  italic?: boolean;
  color?: Uint8ClampedArray | null;
  url?: string | null;
  action?: string | null;
}

/**
 * The sidebar outline view of the pinned PDF.js viewer. The underscored fields are
 * its internals: replacing a rendered outline resets them, and the bridge puts them back.
 */
interface PdfOutlineViewerLike {
  render(args: { outline: PdfJsOutlineNode[] | null; pdfDocument: PdfDocumentLike }): void;
  _isPagesLoaded?: boolean | null;
  _currentOutlineItemCapability?: { resolve(value: boolean): void } | null;
}

export interface PdfViewerApplicationLike {
  initializedPromise: Promise<void>;
  eventBus: PdfEventBusLike;
  pdfDocument?: PdfDocumentLike;
  pdfViewer: PdfViewerLike;
  pdfOutlineViewer?: PdfOutlineViewerLike | null;
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

/**
 * The sidebar tree for a validated outline. Each entry opens the top of its page and
 * keeps the zoom; a positive count shows a section's children expanded.
 */
export function toPdfJsOutline(entries: readonly OutlineEntry[]): PdfJsOutlineNode[] {
  const root: PdfJsOutlineNode[] = [];
  const stack: { level: number; node: PdfJsOutlineNode }[] = [];
  for (const entry of entries) {
    const node: PdfJsOutlineNode = {
      title: entry.title,
      dest: [entry.pageNumber - 1, { name: "XYZ" }, null, null, null],
      items: [],
      count: 0,
      bold: false,
      italic: false,
      color: null,
      url: null,
      action: null,
    };
    while (stack.length > 0 && stack[stack.length - 1]!.level >= entry.level) stack.pop();
    const parent = stack[stack.length - 1]?.node;
    if (parent) {
      parent.items.push(node);
      parent.count = parent.items.length;
    } else {
      root.push(node);
    }
    stack.push({ level: entry.level, node });
  }
  return root;
}

/** Where the visible part of a page sits, in PDF user space (the units the outline uses). */
export interface PdfScrollLocation {
  pageNumber: number;
  top: number;
  left: number;
}

export interface ViewerEventHandlers {
  onDocumentInit?: () => void;
  onPageChanging?: (pageNumber: number, previous: number | undefined) => void;
  onViewArea?: (location: PdfScrollLocation) => void;
  onPageRendered?: (pageNumber: number) => void;
  onDocumentError?: (error: ViewerBridgeError) => void;
  onViewChanging?: (view: ReaderView) => void;
}

export class ViewerBridge {
  readonly #app: PdfViewerApplicationLike;
  readonly #window: Window;
  #modifiedListener: ((modified: boolean) => void) | null = null;
  #restoring = 0;
  // An imported outline shown in the sidebar instead of the PDF's own, for one open document.
  #sidebarOverride: { document: PdfDocumentLike; tree: PdfJsOutlineNode[] } | null = null;
  #renderingSidebar = false;
  #outlineLoadedListener: ((event: unknown) => void) | null = null;

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
      format: "pdf",
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
    if (view.format !== "pdf") {
      throw new ViewerBridgeError(
        "PDF_VIEWER_UNAVAILABLE",
        "the PDF viewer cannot restore an EPUB reading view",
      );
    }
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

  /**
   * Puts the viewer at a page position in PDF user space, without changing the zoom.
   * False while that page has no view yet; a later `pagerendered` retries.
   */
  restoreScroll(pageNumber: number, position: { left: number; top: number }): boolean {
    if (!this.#app.pdfDocument) return false;
    if (!this.#app.pdfViewer.getPageView(pageNumber - 1)) return false;
    this.#app.pdfViewer.scrollPageIntoView({
      pageNumber,
      // XYZ takes five entries: page, destination kind, x, y and zoom; null keeps the zoom.
      destArray: [null, { name: "XYZ" }, position.left, position.top, null],
      allowNegativeOffset: true,
      ignoreDestinationZoom: true,
    });
    return true;
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
      if (!event || typeof event !== "object") return;
      const pageNumber = "pageNumber" in event ? event.pageNumber : undefined;
      const previous = "previous" in event ? event.previous : undefined;
      if (typeof pageNumber === "number") {
        handlers.onPageChanging?.(
          pageNumber,
          typeof previous === "number" ? previous : undefined,
        );
      }
    };
    const onViewArea = (event: unknown): void => {
      if (!event || typeof event !== "object" || !("location" in event)) return;
      const location = event.location;
      if (!location || typeof location !== "object") return;
      const pageNumber = "pageNumber" in location ? location.pageNumber : undefined;
      const top = "top" in location ? location.top : undefined;
      const left = "left" in location ? location.left : undefined;
      if (
        typeof pageNumber !== "number" ||
        !Number.isInteger(pageNumber) ||
        pageNumber < 1 ||
        typeof top !== "number" ||
        !Number.isFinite(top) ||
        typeof left !== "number" ||
        !Number.isFinite(left)
      ) {
        return;
      }
      handlers.onViewArea?.({ pageNumber, top, left });
    };
    const onPageRendered = (event: unknown): void => {
      if (!event || typeof event !== "object" || !("pageNumber" in event)) return;
      const pageNumber = event.pageNumber;
      if (typeof pageNumber === "number" && Number.isInteger(pageNumber)) {
        handlers.onPageRendered?.(pageNumber);
      }
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
    bus.on("updateviewarea", onViewArea);
    bus.on("pagerendered", onPageRendered);
    bus.on("documenterror", onDocumentError);
    bus.on("scalechanging", onViewChanging);
    bus.on("rotationchanging", onViewChanging);
    bus.on("scrollmodechanged", onViewChanging);
    bus.on("spreadmodechanged", onViewChanging);
    return () => {
      bus.off("documentinit", onDocumentInit);
      bus.off("pagechanging", onPageChanging);
      bus.off("updateviewarea", onViewArea);
      bus.off("pagerendered", onPageRendered);
      bus.off("documenterror", onDocumentError);
      bus.off("scalechanging", onViewChanging);
      bus.off("rotationchanging", onViewChanging);
      bus.off("scrollmodechanged", onViewChanging);
      bus.off("spreadmodechanged", onViewChanging);
    };
  }

  /**
   * Shows an imported outline in the viewer's outline sidebar, or with null brings back
   * the PDF's own. The PDF bytes are never changed. PDF.js renders the native outline
   * after the first page and again on later loads, so an override is re-applied whenever
   * the sidebar reloads for the same document.
   */
  async setSidebarOutline(entries: readonly OutlineEntry[] | null): Promise<void> {
    const outlineViewer = this.#app.pdfOutlineViewer;
    const document = this.#app.pdfDocument;
    if (!outlineViewer || !document) return;
    this.#watchSidebar();

    if (entries) {
      this.#sidebarOverride = { document, tree: toPdfJsOutline(entries) };
      this.#renderSidebar(this.#sidebarOverride.tree, document);
      return;
    }
    const previous = this.#sidebarOverride;
    this.#sidebarOverride = null;
    if (previous?.document !== document) return;
    const native = await document.getOutline();
    if (this.#app.pdfDocument !== document || this.#sidebarOverride) return;
    this.#renderSidebar((native as PdfJsOutlineNode[] | null) ?? null, document);
  }

  #watchSidebar(): void {
    if (this.#outlineLoadedListener) return;
    const listener = (event: unknown): void => {
      const outlineViewer = this.#app.pdfOutlineViewer;
      if (this.#renderingSidebar || !outlineViewer) return;
      if ((event as { source?: unknown } | null)?.source !== outlineViewer) return;
      const override = this.#sidebarOverride;
      if (!override) return;
      if (override.document !== this.#app.pdfDocument) {
        this.#sidebarOverride = null;
        return;
      }
      // After the viewer finishes its own render, not inside it.
      queueMicrotask(() => {
        if (this.#sidebarOverride === override && override.document === this.#app.pdfDocument) {
          this.#renderSidebar(override.tree, override.document);
        }
      });
    };
    this.#outlineLoadedListener = listener;
    this.#app.eventBus.on("outlineloaded", listener);
  }

  #renderSidebar(tree: PdfJsOutlineNode[] | null, document: PdfDocumentLike): void {
    const outlineViewer = this.#app.pdfOutlineViewer;
    if (!outlineViewer) return;
    const pagesLoaded = outlineViewer._isPagesLoaded;
    this.#renderingSidebar = true;
    try {
      outlineViewer.render({ outline: tree, pdfDocument: document });
    } finally {
      this.#renderingSidebar = false;
    }
    // Replacing a rendered outline forgets that the pages had loaded, which would keep the
    // "current outline item" button disabled; the pages are still loaded, so say so again.
    if (typeof pagesLoaded === "boolean" && outlineViewer._isPagesLoaded === null) {
      outlineViewer._isPagesLoaded = pagesLoaded;
      outlineViewer._currentOutlineItemCapability?.resolve(pagesLoaded);
    }
  }

  destroy(): void {
    this.#modifiedListener = null;
    if (this.#outlineLoadedListener) {
      this.#app.eventBus.off("outlineloaded", this.#outlineLoadedListener);
      this.#outlineLoadedListener = null;
    }
    this.#sidebarOverride = null;
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
