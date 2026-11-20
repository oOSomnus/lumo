import type { ColorTheme, EpubReaderView } from "../shared/contracts";
import { epubStyleOf } from "../shared/epub";
import type { EpubLayoutSnapshot } from "../shared/epub";
import type { BookLike, RenditionLike, SectionLike } from "./epub-js";
import { rangeBoundaryCfis, readPage } from "./epub-page";
import type { PageRead } from "./epub-page";
import { injectStyle, readingCss, STYLE_KEY } from "./epub-style";

// The stylesheet turn, the foreground rendition's presentation, and the hidden
// renditions that lay a section out at another size. The sandboxed viewer still
// owns the book lifecycle and the message protocol; this module owns how
// renditions are styled, shown, and taken down.

interface Hidden {
  host: HTMLElement;
  rendition: RenditionLike;
  css: string;
}

export interface EpubPageCursor {
  display(target: string | number): Promise<void>;
  next(): Promise<unknown>;
  prev(): Promise<unknown>;
  read(): PageRead | null;
}

/** Two frames: epub.js reports a location one frame after a display and fails if the rendition is gone by then. */
const frames = (): Promise<void> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    // A hidden tab never paints.
    setTimeout(resolve, 100);
  });

const isAbort = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

/** A range CFI means its first position; anything else (a spine index, an href) goes to epub.js as it is. */
const startOf = (target: string | number): string | number =>
  typeof target === "string" ? (rangeBoundaryCfis(target)?.start ?? target) : target;

/**
 * The single stylesheet turn of this iframe. epub.js gives the serialize hook
 * no rendition, so the sheet is set for one navigation at a time; sections that
 * load during a turn are written with that sheet instead of the resting one.
 */
export class EpubStyleTurn {
  private ambient = "";
  private turn: Promise<unknown> = Promise.resolve();

  constructor(private readonly restingCss: () => string) {}

  run<T>(css: string, run: () => Promise<T>): Promise<T> {
    const turn = this.turn.then(async () => {
      this.ambient = css;
      try {
        return await run();
      } finally {
        this.ambient = this.restingCss();
      }
    });
    this.turn = turn.catch(() => undefined);
    return turn;
  }

  serialize(section: SectionLike): void {
    if (this.ambient && section.output !== undefined) {
      section.output = injectStyle(section.output, this.ambient);
    }
  }
}

/** `display`, but a section epub.js cannot load rejects instead of leaving the call and its queue pending forever. */
const show = async (
  rendition: RenditionLike,
  target: string | number,
): Promise<void> => {
  let refuse: ((error: unknown) => void) | undefined;
  const refused = new Promise<never>((_, reject) => {
    refuse = (error) =>
      reject(error instanceof Error ? error : new Error(String(error)));
    rendition.once("displayerror", refuse);
  });
  try {
    await Promise.race([rendition.display(target), refused]);
  } catch (error) {
    rendition.displaying?.resolve();
    throw error;
  } finally {
    if (refuse) rendition.off("displayerror", refuse);
  }
};

export class EpubRenditions {
  private foregroundCss = "";
  private reference: { key: string; hidden: Hidden } | null = null;
  private referenceTurn: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly book: BookLike,
    private readonly foreground: RenditionLike,
    private readonly fixedLayout: boolean,
    private readonly styles: EpubStyleTurn,
  ) {}

  get css(): string {
    return this.foregroundCss;
  }

  display(target: string | number): Promise<void> {
    return this.styles.run(this.foregroundCss, () =>
      show(this.foreground, startOf(target)),
    );
  }

  next(): Promise<unknown> {
    return this.styles.run(this.foregroundCss, () => this.foreground.next());
  }

  prev(): Promise<unknown> {
    return this.styles.run(this.foregroundCss, () => this.foreground.prev());
  }

  async setView(view: EpubReaderView, theme: ColorTheme): Promise<void> {
    const css = readingCss(epubStyleOf(view), this.fixedLayout, theme);
    if (css === this.foregroundCss) return;
    this.foregroundCss = css;
    // Read before the new sheet changes the layout; with nothing shown yet, the next section is written with it.
    const anchor = readPage(this.foreground)?.startCfi;
    if (!anchor) return;
    await this.styles.run(css, async () => {
      for (const contents of this.foreground.getContents()) {
        contents.addStylesheetCss(css, STYLE_KEY);
        contents.expand();
      }
      await show(this.foreground, anchor);
    });
  }

  /** One hidden rendition for the whole batch; its host goes away after the request finishes. */
  async withPages<T>(
    layout: EpubLayoutSnapshot,
    use: (page: EpubPageCursor) => Promise<T>,
  ): Promise<T> {
    const hidden = this.openHidden(layout);
    try {
      return await use(this.cursor(hidden));
    } finally {
      await this.closeHidden(hidden);
    }
  }

  /** Runs `use` on the reference rendition laid out as `layout`, one caller at a time; a failed one is rebuilt for the next. */
  withReference<T>(
    layout: EpubLayoutSnapshot,
    signal: AbortSignal,
    use: (page: EpubPageCursor) => Promise<T>,
  ): Promise<T> {
    const turn = this.referenceTurn.then(async () => {
      signal.throwIfAborted();
      if (this.closed) throw new DOMException("closed", "AbortError");
      const key = JSON.stringify(layout);
      if (this.reference?.key !== key) {
        const old = this.reference;
        this.reference = null;
        if (old) await this.closeHidden(old.hidden);
        this.reference = { key, hidden: this.openHidden(layout) };
      }
      const { hidden } = this.reference;
      try {
        return await this.styles.run(hidden.css, () =>
          use(this.referenceCursor(hidden)),
        );
      } catch (error) {
        if (!isAbort(error)) {
          this.reference = null;
          await this.closeHidden(hidden);
        }
        throw error;
      }
    });
    this.referenceTurn = turn.catch(() => undefined);
    return turn;
  }

  async close(): Promise<void> {
    this.closed = true;
    await frames();
    if (this.reference) this.destroyHidden(this.reference.hidden);
    this.reference = null;
    this.foreground.destroy();
    this.book.destroy();
  }

  private cursor(hidden: Hidden): EpubPageCursor {
    return {
      display: (target) =>
        this.styles.run(hidden.css, () => show(hidden.rendition, target)),
      next: () => this.styles.run(hidden.css, () => hidden.rendition.next()),
      prev: () => this.styles.run(hidden.css, () => hidden.rendition.prev()),
      read: () => readPage(hidden.rendition),
    };
  }

  /** The reference already runs inside one style lease; navigation must not wait on a nested turn. */
  private referenceCursor(hidden: Hidden): EpubPageCursor {
    return {
      display: (target) => show(hidden.rendition, target),
      next: () => hidden.rendition.next(),
      prev: () => hidden.rendition.prev(),
      read: () => readPage(hidden.rendition),
    };
  }

  private openHidden(layout: EpubLayoutSnapshot): Hidden {
    const host = document.createElement("div");
    host.style.cssText = `position:absolute;left:-100000px;top:0;width:${layout.width}px;height:${layout.height}px;overflow:hidden`;
    document.body.append(host);
    const rendition = this.book.renderTo(host, {
      width: layout.width,
      height: layout.height,
      flow: "paginated",
      spread: "none",
      allowScriptedContent: false,
    });
    // Hidden renditions are only measured, never seen, and colour does not change the layout.
    return { host, rendition, css: readingCss(layout.style, this.fixedLayout, "light") };
  }

  private destroyHidden(hidden: Hidden): void {
    hidden.rendition.destroy();
    hidden.host.remove();
  }

  private async closeHidden(hidden: Hidden): Promise<void> {
    await frames();
    this.destroyHidden(hidden);
  }
}
