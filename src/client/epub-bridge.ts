import type {
  EpubReaderView,
  TranslationContext,
} from "../shared/contracts";
import type { EpubLayoutSnapshot } from "../shared/epub";
import type { TypstAsset } from "./typst";

/** One table-of-contents row, flattened in reading order. Groups without a link have `href` and `index` null. */
export interface EpubTocEntry {
  id: string;
  label: string;
  /** 1 for a top-level entry. */
  level: number;
  /** A target `display()` accepts, with its fragment, resolved against the package; null for a group or an unusable link. */
  href: string | null;
  /** The spine index `href` points into; null when it does not resolve to a section of this book. */
  index: number | null;
}

/** An on-screen range of one spine section. */
export interface EpubPageLocation {
  sectionIndex: number;
  /** CFI of the first visible position; what reading progress stores. */
  startCfi: string;
  /** CFI of the visible DOM range; what a translation is keyed to. */
  sourceCfi: string;
  /** `page-<sha256>` of this sourceCfi. */
  unit: string;
  /** 1-based screen page within the section, and how many the section has at this layout. */
  page: number;
  total: number;
}

/**
 * What the foreground rendition publishes after every relayout or move. When no
 * stable DOM range could be built for the screen page, `sourceCfi` and `unit`
 * are null: the reader keeps tracking progress but disables translating until a
 * later relocation has a range. A whole-chapter range is never substituted.
 */
export interface EpubRelocation extends Omit<EpubPageLocation, "sourceCfi" | "unit"> {
  sourceCfi: string | null;
  unit: string | null;
  /** True on the first screen page of the book / the last one. */
  atStart: boolean;
  atEnd: boolean;
}

export interface EpubSelection {
  /** CFI of the selected range. */
  sourceCfi: string;
  text: string;
  /** `sel-<sha256>` of sourceCfi. */
  unit: string;
  sectionIndex: number;
}

export interface EpubReadyInfo {
  sectionCount: number;
  toc: readonly EpubTocEntry[];
  /** pre-paginated books cannot reflow, so font settings do not apply. */
  fixedLayout: boolean;
}

export type EpubContextSide = "previous" | "next";

/** What one range sends to the model; images are kept out and fetched with `assets()` when needed. */
export interface EpubPreparedUnit {
  xhtml: string;
  /** JPEG previews of the images the XHTML refers to by `assets/<hash>.<ext>`. */
  images: { path: string; imageBase64: string }[];
  /** Small excerpts of the real neighbouring screen pages; absent for a selection or when none exists. */
  context?: TranslationContext;
  /** A neighbour that exists but could not be read; the unit itself is still usable. */
  contextWarnings?: EpubContextSide[];
}

/** Rejection of a bridge call; `code` is an i18n error code. */
export class EpubBridgeError extends Error {
  constructor(
    readonly code:
      | "EPUB_NOT_READY"
      | "EPUB_NAVIGATION_FAILED"
      | "EPUB_PAGE_UNAVAILABLE"
      | "EPUB_PAGE_TOO_LARGE"
      | "PAGE_ASSETS_TOO_LARGE"
      | "DOCUMENT_CHANGED",
    message: string,
  ) {
    super(message);
    this.name = "EpubBridgeError";
  }
}

/**
 * The reader's handle on the sandboxed EPUB iframe. Every method that can fail
 * rejects with an `EpubBridgeError` (or an AbortError when the caller's signal
 * aborts); nothing is swallowed. Calls queued with the same book stop being
 * answered when another book is opened.
 */
export interface EpubBridge {
  /** The reading viewport in CSS pixels; a layout snapshot is captured from it. */
  readonly viewport: { readonly width: number; readonly height: number };

  /**
   * The XHTML and image previews of the DOM range `sourceCfi`, plus bounded
   * excerpts of the neighbouring screen pages when `layout` is given (it says
   * how those neighbours are paginated). `null` prepares the range alone.
   * Concurrent identical calls share one piece of work; a call is cancelled by
   * its own signal and the work stops once every caller has cancelled.
   */
  prepare(
    sourceCfi: string,
    layout: EpubLayoutSnapshot | null,
    signal: AbortSignal,
  ): Promise<EpubPreparedUnit>;

  /** The original image files of that range at their `assets/<hash>.<ext>` paths. */
  assets(sourceCfi: string, signal: AbortSignal): Promise<readonly TypstAsset[]>;

  /**
   * Every screen page of the given sections under `layout`, in reading order,
   * measured in a hidden rendition so the visible position never moves. The
   * iframe stays at most one descriptor ahead of the consumer; breaking out of
   * the loop or aborting the signal stops the work and releases the hidden view.
   */
  pages(
    sectionIndexes: readonly number[],
    layout: EpubLayoutSnapshot,
    signal: AbortSignal,
  ): AsyncIterable<EpubPageLocation>;

  /** A spine index, an href (with fragment) or a CFI. Resolves once the new position was published. */
  display(target: string | number): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  /**
   * Applies the four reading settings of `view` (its cfi is ignored). Before
   * the first display they only take effect; afterwards the reading position
   * is kept and a new relocation is published once the layout settled.
   */
  setView(view: EpubReaderView): Promise<void>;
  clearSelection(): void;
  /**
   * The book on screen is about to be replaced: everything it still sends is
   * ignored from now on, calls in flight fail with DOCUMENT_CHANGED and calls
   * fail with EPUB_NOT_READY until the next book reports ready.
   */
  invalidate(): void;
}
