import {
  DEFAULT_TRANSLATION_ZOOM,
  readerViewSchema,
  type ReaderView,
} from "../shared/contracts";
import { sameScrollMemory } from "./scroll-memory";

// The outbox for a book's reading view: what was changed, what is being
// written, and what failed. The reader still measures positions and restores
// renderers; this module owns the asynchronous rules around them.

export interface ReaderViewTransport {
  load(documentId: string): Promise<ReaderView | null>;
  save(documentId: string, view: ReaderView): Promise<ReaderView>;
  keepalive(documentId: string, view: ReaderView): Promise<unknown>;
}

export interface ReaderViewSnapshot {
  documentId: string;
  view: ReaderView;
}

export interface ReaderViewRead {
  view: ReaderView | null;
  fetched: boolean;
}

export function sameReaderView(a: ReaderView, b: ReaderView): boolean {
  if (a.format !== b.format) return false;
  if (!sameScrollMemory(a.scrollMemory, b.scrollMemory)) return false;
  if (
    (a.translationZoom ?? DEFAULT_TRANSLATION_ZOOM) !==
    (b.translationZoom ?? DEFAULT_TRANSLATION_ZOOM)
  ) {
    return false;
  }
  if (a.format === "epub" && b.format === "epub") {
    return (
      a.cfi === b.cfi &&
      a.fontSize === b.fontSize &&
      a.fontFamily === b.fontFamily &&
      a.lineHeight === b.lineHeight
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

const SAVE_DELAY_MS = 250;

export class ReaderViewStore {
  private readonly pending = new Map<string, ReaderView>();
  private readonly failed = new Map<string, ReaderView>();
  private readonly saved = new Map<string, ReaderView>();
  private readonly markers = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private draining: Promise<void> | null = null;

  constructor(
    private readonly transport: ReaderViewTransport,
    private readonly onSaveFailure: (failed: boolean) => void,
  ) {}

  /** Selecting a book clears its deletion marker so a re-uploaded id can persist again. */
  selected(documentId: string): void {
    this.markers.delete(documentId);
  }

  /** A presentation change: reverting to the saved view drops its queued write. */
  changed(documentId: string, view: ReaderView): void {
    const saved = this.saved.get(documentId);
    if (saved && sameReaderView(saved, view)) {
      this.pending.delete(documentId);
      return;
    }
    this.pending.set(documentId, view);
    this.failed.delete(documentId);
    this.schedule();
  }

  /** A scroll: the position is queued even when it equals the saved one. */
  scrolled(documentId: string, view: ReaderView): void {
    const saved = this.saved.get(documentId);
    if (saved && sameReaderView(saved, view)) return;
    this.pending.set(documentId, view);
    this.failed.delete(documentId);
    this.schedule();
  }

  /** Replaces the queued write unconditionally, including with the saved view itself. */
  capture(documentId: string, view: ReaderView, schedule = false): void {
    this.pending.set(documentId, view);
    this.failed.delete(documentId);
    if (schedule) this.schedule();
  }

  /** Pending, then saved, then the server unless a fresh read was asked for. */
  async load(
    documentId: string,
    isCurrent: () => boolean,
    fresh = false,
  ): Promise<ReaderViewRead> {
    if (!fresh) {
      const cached = this.pending.get(documentId) ?? this.saved.get(documentId);
      if (cached) return { view: cached, fetched: false };
    }
    const stored = await this.transport.load(documentId);
    if (!isCurrent()) return { view: null, fetched: false };
    const parsed = stored ? readerViewSchema.safeParse(stored) : null;
    if (!parsed?.success) return { view: null, fetched: true };
    this.saved.set(documentId, parsed.data);
    return { view: parsed.data, fetched: true };
  }

  /** Writes everything queued, after any write already running. */
  async flush(current?: ReaderViewSnapshot): Promise<boolean> {
    this.cancel();
    if (current) {
      const saved = this.saved.get(current.documentId);
      if (!saved || !sameReaderView(saved, current.view)) {
        this.pending.set(current.documentId, current.view);
      }
    }
    await this.drain();
    return this.pending.size === 0 && this.failed.size === 0;
  }

  /** Queues the failed views again and clears the warning before the retry runs. */
  retry(): void {
    for (const [documentId, view] of this.failed) {
      if (!this.pending.has(documentId)) this.pending.set(documentId, view);
    }
    this.failed.clear();
    this.onSaveFailure(false);
    void this.drain();
  }

  /** Deletes every trace of the book; late replies for it must not resurrect the cache. */
  deleted(documentId: string): void {
    this.markers.add(documentId);
    this.pending.delete(documentId);
    this.failed.delete(documentId);
    this.saved.delete(documentId);
    this.reportFailure();
  }

  /** The page is going away: send what is queued without waiting for a reply. */
  pagehide(current?: ReaderViewSnapshot): void {
    this.cancel();
    if (current) this.pending.set(current.documentId, current.view);
    for (const [documentId, view] of this.pending) {
      void this.transport.keepalive(documentId, view).catch(() => {});
    }
  }

  /** The reader is unmounting; a queued write is not sent. */
  dispose(): void {
    this.cancel();
  }

  private schedule(): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, SAVE_DELAY_MS);
  }

  private cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    const run = (async () => {
      for (;;) {
        const entry = this.pending.entries().next().value;
        if (!entry) break;
        const [documentId, view] = entry;
        const stored = await this.save(documentId, view);
        if (!stored && this.pending.get(documentId) === view) {
          this.pending.delete(documentId);
        }
      }
      this.reportFailure();
    })().finally(() => {
      this.draining = null;
    });
    this.draining = run;
    return run;
  }

  private async save(documentId: string, view: ReaderView): Promise<boolean> {
    try {
      const stored = await this.transport.save(documentId, view);
      if (this.markers.has(documentId)) return true;
      this.saved.set(documentId, stored);
      this.failed.delete(documentId);
      if (this.pending.get(documentId) === view) this.pending.delete(documentId);
      return true;
    } catch {
      if (!this.markers.has(documentId)) {
        this.failed.set(documentId, view);
        this.onSaveFailure(true);
      }
      return false;
    }
  }

  private reportFailure(): void {
    this.onSaveFailure(this.pending.size > 0 || this.failed.size > 0);
  }
}
