// The parts of epub.js 0.3 the viewer touches. Type-only: the library itself
// is a global (`window.ePub`) loaded by epub-viewer.html.

export interface RawTocItem {
  label?: string;
  href?: string;
  subitems?: RawTocItem[];
}

export interface SectionLike {
  index: number;
  href: string;
  url: string;
  document?: Document;
  /** The serialized section; `spine.hooks.serialize` handlers may rewrite it before the iframe is written. */
  output?: string;
  load(request: (path: string) => Promise<unknown>): Promise<unknown>;
  unload(): void;
}

export interface SpineLike {
  length: number;
  get(target: number | string): SectionLike | null;
}

export interface ContentsLike {
  window: Window;
  document: Document;
  sectionIndex: number;
  range(cfi: string): Range | null;
  cfiFromRange(range: Range): string;
  cfiFromNode(node: Node): string;
  addStylesheetCss(css: string, key: string): boolean;
  expand(): void;
}

export interface DisplayedLocation {
  index: number;
  cfi: string;
  displayed: { page: number; total: number };
}

export interface LocatedLike {
  start?: DisplayedLocation;
  end?: DisplayedLocation;
  atStart?: boolean;
  atEnd?: boolean;
}

export interface RenditionLike {
  display(target?: string | number): Promise<unknown>;
  next(): Promise<unknown>;
  prev(): Promise<unknown>;
  on(name: string, listener: (...args: never[]) => void): void;
  once(name: string, listener: (...args: never[]) => void): void;
  off(name: string, listener: (...args: never[]) => void): void;
  currentLocation(): LocatedLike | undefined;
  getContents(): ContentsLike[];
  /** Set while a display is pending; epub.js never settles that display when the section fails to load. */
  displaying?: { resolve(): void };
  destroy(): void;
}

/** What section loading, image reading and CFI resolution need of a book. */
export interface EpubBook {
  spine: SpineLike;
  path?: { directory?: string };
  archive?: { request(path: string, type?: string): Promise<unknown> };
  resolve(path: string, absolute?: boolean): string;
  load(path: string): Promise<unknown>;
}

export interface BookLike extends EpubBook {
  spine: SpineLike & {
    hooks: { serialize: { register(hook: (output: string, section: SectionLike) => void): void } };
  };
  ready: Promise<unknown>;
  packaging: {
    navPath?: string;
    ncxPath?: string;
    metadata?: { layout?: string };
  };
  loaded: { navigation: Promise<{ toc: RawTocItem[] }> };
  renderTo(
    target: string | HTMLElement,
    options: Record<string, unknown>,
  ): RenditionLike;
  destroy(): void;
}

export interface CfiLike {
  spinePos: number;
  toRange(document: Document): Range | null;
}

export interface EpubGlobal {
  (input: ArrayBuffer): BookLike;
  CFI: new (cfi: string) => CfiLike;
}
