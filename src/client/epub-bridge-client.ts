import type { EpubReaderView } from "../shared/contracts";
import type { EpubLayoutSnapshot } from "../shared/epub";
import {
  EpubBridgeError,
  type EpubBridge,
  type EpubPageLocation,
  type EpubPreparedUnit,
  type EpubReadyInfo,
  type EpubRelocation,
  type EpubSelection,
} from "./epub-bridge";
import type {
  EpubFailureCode,
  EpubReplies,
  EpubRequest,
  ParentMessage,
  ViewerMessage,
} from "./epub-protocol";
import type { TypstAsset } from "./typst";

export interface EpubBridgeEvents {
  /** The iframe script runs and can take `open`. */
  onViewerReady(): void;
  onReady(info: EpubReadyInfo): void;
  onRelocated(relocation: EpubRelocation): void;
  onSelection(selection: EpubSelection | null): void;
  /** The book itself could not be opened. */
  onFatal(failure: { code: EpubFailureCode; message: string }): void;
}

interface Handler {
  reply?: (result: unknown) => void;
  page?: (page: EpubPageLocation) => void;
  done?: () => void;
  fail: (error: Error) => void;
}

interface SharedCall {
  id: number;
  promise: Promise<unknown>;
  consumers: number;
}

type ReplyRequest = Exclude<EpubRequest, { op: "pages" }>;

const abortError = (): DOMException =>
  new DOMException("The EPUB request was cancelled", "AbortError");

const notReady = (): EpubBridgeError =>
  new EpubBridgeError("EPUB_NOT_READY", "the EPUB is not open yet");

const layoutKey = (layout: EpubLayoutSnapshot | null): string =>
  layout
    ? `${layout.width}x${layout.height}|${layout.style.fontSize}|${layout.style.fontFamily}|${layout.style.lineHeight}|${layout.style.theme}`
    : "-";

/**
 * The reader page's end of the iframe protocol (see epub-protocol.ts). Calls
 * for the same range share one request; a request is cancelled when its last
 * caller leaves, and opening another book fails everything still in flight.
 */
export class EpubBridgeClient implements EpubBridge {
  private generation = 0;
  private ready = false;
  private nextId = 0;
  private readonly handlers = new Map<number, Handler>();
  private readonly shared = new Map<string, SharedCall>();

  constructor(
    private readonly frame: HTMLIFrameElement,
    private readonly events: EpubBridgeEvents,
  ) {
    window.addEventListener("message", this.onMessage);
  }

  get viewport(): { width: number; height: number } {
    return { width: this.frame.clientWidth, height: this.frame.clientHeight };
  }

  hello(): void {
    this.post({ type: "hello" });
  }

  /** Starts a new book; `bytes` is transferred to the iframe. */
  open(bytes: ArrayBuffer): void {
    this.invalidate();
    this.post({ type: "open", generation: this.generation, bytes }, [bytes]);
  }

  dispose(): void {
    window.removeEventListener("message", this.onMessage);
    this.invalidate();
  }

  prepare(
    sourceCfi: string,
    layout: EpubLayoutSnapshot | null,
    signal: AbortSignal,
  ): Promise<EpubPreparedUnit> {
    return this.share(
      `prepare|${sourceCfi}|${layoutKey(layout)}`,
      { op: "prepare", sourceCfi, layout },
      signal,
    );
  }

  assets(sourceCfi: string, signal: AbortSignal): Promise<readonly TypstAsset[]> {
    return this.share(`assets|${sourceCfi}`, { op: "assets", sourceCfi }, signal);
  }

  async *pages(
    sectionIndexes: readonly number[],
    layout: EpubLayoutSnapshot,
    signal: AbortSignal,
  ): AsyncGenerator<EpubPageLocation> {
    signal.throwIfAborted();
    if (!this.ready) throw notReady();
    const generation = this.generation;
    const id = ++this.nextId;
    const queue: EpubPageLocation[] = [];
    const state: { finished: boolean; failure: Error | null; wake: (() => void) | null } = {
      finished: false,
      failure: null,
      wake: null,
    };
    const notify = (): void => {
      const wake = state.wake;
      state.wake = null;
      wake?.();
    };
    this.handlers.set(id, {
      page: (page) => {
        queue.push(page);
        notify();
      },
      done: () => {
        state.finished = true;
        notify();
      },
      fail: (error) => {
        state.failure = error;
        notify();
      },
    });
    const onAbort = (): void => {
      state.failure = abortError();
      notify();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    this.post({
      type: "request",
      generation,
      id,
      request: { op: "pages", sectionIndexes: [...sectionIndexes], layout },
    });
    try {
      for (;;) {
        while (queue.length === 0 && !state.finished && !state.failure) {
          await new Promise<void>((resolve) => {
            state.wake = resolve;
          });
        }
        if (state.failure) throw state.failure;
        const page = queue.shift();
        if (!page) return;
        // The viewer measures the next page while the consumer works on this one.
        this.post({ type: "ack", generation, id });
        yield page;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.cancel(id);
    }
  }

  async display(target: string | number): Promise<void> {
    await this.send({ op: "display", target }).promise;
  }

  async next(): Promise<void> {
    await this.send({ op: "next" }).promise;
  }

  async prev(): Promise<void> {
    await this.send({ op: "prev" }).promise;
  }

  async setView(view: EpubReaderView): Promise<void> {
    await this.send({ op: "setView", view }).promise;
  }

  clearSelection(): void {
    if (this.ready) this.post({ type: "clear-selection", generation: this.generation });
  }

  private readonly onMessage = (event: MessageEvent<unknown>): void => {
    if (event.source !== this.frame.contentWindow || event.origin !== window.location.origin) {
      return;
    }
    const message = event.data as ViewerMessage | null;
    if (!message || typeof message !== "object") return;
    if (message.type === "viewer-ready") {
      this.events.onViewerReady();
      return;
    }
    if (message.generation !== this.generation) return;
    switch (message.type) {
      case "ready":
        this.ready = true;
        this.events.onReady(message.info);
        break;
      case "relocated":
        this.events.onRelocated(message.relocation);
        break;
      case "selection":
        this.events.onSelection(message.selection);
        break;
      case "reply":
        this.take(message.id)?.reply?.(message.result);
        break;
      case "page":
        this.handlers.get(message.id)?.page?.(message.page);
        break;
      case "done":
        this.take(message.id)?.done?.();
        break;
      case "failure":
        if (message.id === null || message.code === "EPUB_OPEN_FAILED") {
          this.events.onFatal({ code: message.code, message: message.message });
        } else {
          this.take(message.id)?.fail(new EpubBridgeError(message.code, message.message));
        }
        break;
    }
  };

  private post(message: ParentMessage, transfer: Transferable[] = []): void {
    this.frame.contentWindow?.postMessage(message, window.location.origin, transfer);
  }

  private take(id: number): Handler | undefined {
    const handler = this.handlers.get(id);
    this.handlers.delete(id);
    return handler;
  }

  /** Stops the viewer's work for `id` and fails whoever still waits for it. */
  private cancel(id: number): void {
    const handler = this.take(id);
    if (!handler) return;
    this.post({ type: "cancel", generation: this.generation, id });
    handler.fail(abortError());
  }

  /** The book these calls were made against is gone; its messages no longer match the generation. */
  invalidate(): void {
    this.generation += 1;
    this.ready = false;
    const error = new EpubBridgeError("DOCUMENT_CHANGED", "another EPUB was opened");
    const handlers = [...this.handlers.values()];
    this.handlers.clear();
    this.shared.clear();
    for (const handler of handlers) handler.fail(error);
  }

  private send<K extends ReplyRequest["op"]>(
    request: Extract<ReplyRequest, { op: K }>,
  ): { id: number; promise: Promise<EpubReplies[K]> } {
    if (!this.ready) return { id: 0, promise: Promise.reject(notReady()) };
    const id = ++this.nextId;
    const promise = new Promise<EpubReplies[K]>((resolve, reject) => {
      this.handlers.set(id, { reply: resolve as (result: unknown) => void, fail: reject });
    });
    this.post({ type: "request", generation: this.generation, id, request });
    return { id, promise };
  }

  private share<K extends "prepare" | "assets">(
    key: string,
    request: Extract<ReplyRequest, { op: K }>,
    signal: AbortSignal,
  ): Promise<EpubReplies[K]> {
    if (signal.aborted) return Promise.reject(abortError());
    let call = this.shared.get(key);
    if (!call) {
      const sent = this.send(request);
      const created: SharedCall = { id: sent.id, promise: sent.promise, consumers: 0 };
      call = created;
      this.shared.set(key, created);
      const forget = (): void => {
        if (this.shared.get(key) === created) this.shared.delete(key);
      };
      sent.promise.then(forget, forget);
    }
    const entry = call;
    entry.consumers += 1;
    return new Promise<EpubReplies[K]>((resolve, reject) => {
      const onAbort = (): void => {
        entry.consumers -= 1;
        if (entry.consumers === 0) {
          if (this.shared.get(key) === entry) this.shared.delete(key);
          this.cancel(entry.id);
        }
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      entry.promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value as EpubReplies[K]);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }
}
