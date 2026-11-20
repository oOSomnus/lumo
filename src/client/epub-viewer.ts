import type { TranslationContext, TranslationReference } from "../shared/contracts";
import { epubTranslationUnit } from "../shared/epub";
import type { EpubLayoutSnapshot } from "../shared/epub";
import { MAX_TRANSLATION_CONTEXT_CHARS } from "../shared/limits";
import { EpubBridgeError } from "./epub-bridge";
import type {
  EpubContextSide,
  EpubPreparedUnit,
  EpubRelocation,
  EpubSelection,
} from "./epub-bridge";
import { createEpubContent } from "./epub-content";
import type { EpubContent } from "./epub-content";
import type { BookLike, ContentsLike, EpubGlobal, RenditionLike } from "./epub-js";
import { EpubRenditions, EpubStyleTurn } from "./epub-rendition";
import {
  collapseSpace,
  edgeText,
  insideEndCfi,
  pageSignature,
  rangeBoundaryCfis,
  readPage,
  selectedTextRange,
} from "./epub-page";
import type { PageRead } from "./epub-page";
import type {
  EpubFailureCode,
  EpubReplies,
  EpubRequest,
  ParentMessage,
  ViewerMessage,
} from "./epub-protocol";
import { watchReaderKeys } from "./page-keys";
import type { ReaderShortcut } from "./page-keys";
import { watchPointerActivity } from "./pointer-activity";
import { flattenEpubToc } from "./epub-toc";

// The sandboxed half of the EPUB reader. It owns the book, the foreground
// rendition the user reads in, and the hidden renditions that lay a section out
// at some other size (page enumeration, neighbouring pages). Protocol: epub-protocol.ts.

interface Session {
  generation: number;
  /** Navigates and destroys every rendition; the viewer only reads events and contents from `rendition`. */
  renditions: EpubRenditions;
  rendition: Pick<RenditionLike, "on" | "hooks" | "getContents" | "currentLocation">;
  content: EpubContent;
  closed: boolean;
  requests: Map<number, AbortController>;
  acks: Map<number, () => void>;
  /** Moves of the foreground rendition run one after another. */
  moves: Promise<unknown>;
  /** Relocation posts queue the same way; `queued` is the one that has not started yet. */
  posts: Promise<void>;
  queued: Promise<void> | null;
  lastPosted: string;
  /** Counts the moments a selection still being measured stops being the current one; only the latest, unmoved selection may be posted. */
  selectionSeq: number;
  /** Stops the key and pointer listeners of every section document the foreground rendition showed. */
  docStops: Map<Document, () => void>;
}

let current: Session | null = null;
let openToken = 0;

// One turn per iframe, shared by every session: epub.js serializes sections on
// its own schedule, so a second queue would race the first one's stylesheet.
const styles = new EpubStyleTurn(() => current?.renditions.css ?? "");

const post = (message: ViewerMessage): void => window.parent.postMessage(message, location.origin);

/** A reading shortcut in the book: the reader page acts on it, so its own rules (pinned ranges, bounds, serialized moves) apply. */
function forwardKey(session: Session, shortcut: ReaderShortcut): boolean {
  if (current !== session || session.closed) return false;
  post({ type: "shortcut", generation: session.generation, shortcut });
  return true;
}

/** The mouse moved over the book; the reader page shows its immersive page buttons. */
function forwardPointer(session: Session): void {
  if (current !== session || session.closed) return;
  post({ type: "pointer", generation: session.generation });
}

const unavailable = (message: string): EpubBridgeError =>
  new EpubBridgeError("EPUB_PAGE_UNAVAILABLE", message);

const isAbort = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

async function describePage(
  content: EpubContent,
  read: PageRead,
): Promise<{ sourceCfi: string | null; unit: string | null }> {
  const visible = read.visible;
  if (!visible) return { sourceCfi: null, unit: null };
  const live = pageSignature(visible.range);
  // The iframe parses HTML and the section document XML; a range the two read differently cannot be translated back.
  if ((await content.signatureOf(visible.cfi)) !== live) return { sourceCfi: null, unit: null };
  return { sourceCfi: visible.cfi, unit: await epubTranslationUnit("page", visible.cfi) };
}

async function postRelocation(session: Session): Promise<void> {
  const read = readPage(session.rendition);
  if (!read || session.closed) return;
  const where = await describePage(session.content, read);
  if (session.closed) return;
  session.content.keep(read.sectionIndex);
  const relocation: EpubRelocation = {
    sectionIndex: read.sectionIndex,
    startCfi: read.startCfi,
    sourceCfi: where.sourceCfi,
    unit: where.unit,
    page: read.page,
    total: read.total,
    atStart: read.atStart,
    atEnd: read.atEnd,
  };
  const key = JSON.stringify(relocation);
  if (key === session.lastPosted) return;
  session.lastPosted = key;
  post({ type: "relocated", generation: session.generation, relocation });
}

/** Posts the current position; the returned promise settles once it was posted (or nothing changed). */
function publish(session: Session): Promise<void> {
  if (session.queued) return session.queued;
  const run = session.posts.then(() => {
    session.queued = null;
    return postRelocation(session);
  });
  session.queued = run;
  session.posts = run.catch(() => undefined);
  return run;
}

/** Runs one move of the foreground rendition after the earlier ones, then posts where it ended up. */
function move(session: Session, step: () => Promise<unknown>): Promise<void> {
  const turn = session.moves.then(async () => {
    if (session.closed) throw new DOMException("closed", "AbortError");
    session.selectionSeq += 1;
    await step();
    await publish(session);
  });
  session.moves = turn.catch(() => undefined);
  return turn;
}

async function handleSelection(session: Session, contents: ContentsLike): Promise<void> {
  const seq = ++session.selectionSeq;
  const selection = contents.window.getSelection();
  const range =
    selection && selection.rangeCount > 0 ? selectedTextRange(contents, selection.getRangeAt(0)) : null;
  const text = range ? collapseSpace(range.toString()) : "";
  let value: EpubSelection | null = null;
  if (range && text) {
    const sourceCfi = contents.cfiFromRange(range);
    if ((await session.content.signatureOf(sourceCfi)) === pageSignature(range)) {
      value = {
        sourceCfi,
        text,
        unit: await epubTranslationUnit("selection", sourceCfi),
        sectionIndex: contents.sectionIndex,
      };
    }
  }
  // A newer selection, a clear or a move happened while this one was measured: what it found is no longer the selection.
  if (!session.closed && seq === session.selectionSeq) {
    post({ type: "selection", generation: session.generation, selection: value });
  }
}

function waitAck(session: Session, id: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = (): void => {
      session.acks.delete(id);
      reject(signal.reason);
    };
    session.acks.set(id, () => {
      signal.removeEventListener("abort", stop);
      session.acks.delete(id);
      resolve();
    });
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
}

/** Every screen page of the sections, one `page` message each; the consumer's `ack` paces the layout work. */
async function pages(
  session: Session,
  id: number,
  sectionIndexes: readonly number[],
  layout: EpubLayoutSnapshot,
  signal: AbortSignal,
): Promise<void> {
  await session.renditions.withPages(layout, async (page) => {
    for (const sectionIndex of sectionIndexes) {
      signal.throwIfAborted();
      await page.display(sectionIndex);
      let read = page.read();
      for (;;) {
        signal.throwIfAborted();
        if (!read || read.sectionIndex !== sectionIndex) throw unavailable("the section could not be paged");
        const where = await describePage(session.content, read);
        if (where.sourceCfi && where.unit) {
          post({
            type: "page",
            generation: session.generation,
            id,
            page: {
              sectionIndex,
              startCfi: read.startCfi,
              sourceCfi: where.sourceCfi,
              unit: where.unit,
              page: read.page,
              total: read.total,
            },
          });
          await waitAck(session, id, signal);
        }
        if (read.page >= read.total) break;
        await page.next();
        const next = page.read();
        if (!next || next.sectionIndex !== sectionIndex || next.page <= read.page) {
          throw unavailable(`the section stopped paging at page ${read.page} of ${read.total}`);
        }
        read = next;
      }
      session.content.release(sectionIndex);
    }
  });
}

/** The reference of the screen page next to the range on `side`: its nearest text, else its nearest image; null when there is none. */
async function neighbour(
  session: Session,
  sourceCfi: string,
  side: EpubContextSide,
  layout: EpubLayoutSnapshot,
  signal: AbortSignal,
): Promise<TranslationReference | null> {
  const bounds = rangeBoundaryCfis(sourceCfi);
  if (!bounds) throw unavailable("the range has no readable position");
  const previous = side === "previous";
  const anchor = previous ? bounds.start : insideEndCfi(bounds.end);
  const edge = previous ? "end" : "start";
  const found = await session.renditions.withReference(
    layout,
    signal,
    async (page) => {
      await page.display(anchor);
      const here = page.read();
      if (!here) throw unavailable("the page could not be located");
      if (previous ? here.atStart : here.atEnd) return null;
      await (previous ? page.prev() : page.next());
      const there = page.read();
      if (!there) throw unavailable("the neighbouring page could not be located");
      if (there.sectionIndex === here.sectionIndex && there.page === here.page) return null;
      const visible = there.visible;
      if (!visible) return null;
      session.content.release(here.sectionIndex);
      session.content.release(there.sectionIndex);
      return {
        text: edgeText(visible.range, edge, MAX_TRANSLATION_CONTEXT_CHARS),
        cfi: visible.cfi,
      };
    },
  );
  if (!found) return null;
  if (found.text) return { text: found.text };
  const imageBase64 = await session.content.edgeImage(found.cfi, edge, signal);
  return imageBase64 ? { imageBase64 } : null;
}

async function neighbours(
  session: Session,
  sourceCfi: string,
  layout: EpubLayoutSnapshot,
  signal: AbortSignal,
): Promise<{ context: TranslationContext | null; warnings: EpubContextSide[] }> {
  const context: TranslationContext = {};
  const warnings: EpubContextSide[] = [];
  for (const side of ["previous", "next"] as const) {
    try {
      const reference = await neighbour(session, sourceCfi, side, layout, signal);
      if (reference) context[side] = reference;
    } catch (error) {
      if (signal.aborted || isAbort(error)) throw error;
      console.error(`neighbouring ${side} page unavailable`, error);
      warnings.push(side);
    }
  }
  return { context: context.previous || context.next ? context : null, warnings };
}

async function prepare(
  session: Session,
  sourceCfi: string,
  layout: EpubLayoutSnapshot | null,
  signal: AbortSignal,
): Promise<EpubPreparedUnit> {
  const own = session.content.prepare(sourceCfi, signal);
  own.catch(() => undefined); // awaited below; a neighbour failure first must not leave it unhandled
  const near = layout ? await neighbours(session, sourceCfi, layout, signal) : null;
  const prepared: EpubPreparedUnit = await own;
  if (near?.context) prepared.context = near.context;
  if (near && near.warnings.length > 0) prepared.contextWarnings = near.warnings;
  return prepared;
}

function reply(
  session: Session,
  id: number,
  signal: AbortSignal,
  result: EpubReplies[keyof EpubReplies],
): void {
  if (!signal.aborted && !session.closed) {
    post({ type: "reply", generation: session.generation, id, result });
  }
}

function serve(session: Session, id: number, request: EpubRequest): void {
  const controller = new AbortController();
  const { signal } = controller;
  session.requests.set(id, controller);
  const run = async (): Promise<void> => {
    switch (request.op) {
      case "prepare":
        reply(session, id, signal, await prepare(session, request.sourceCfi, request.layout, signal));
        return;
      case "assets":
        reply(session, id, signal, await session.content.assets(request.sourceCfi, signal));
        return;
      case "pages":
        await pages(session, id, request.sectionIndexes, request.layout, signal);
        if (!signal.aborted && !session.closed) post({ type: "done", generation: session.generation, id });
        return;
      case "display":
        await move(session, () => session.renditions.display(request.target));
        break;
      case "next":
        await move(session, () => session.renditions.next());
        break;
      case "prev":
        await move(session, () => session.renditions.prev());
        break;
      case "setView":
        await move(session, () => session.renditions.setView(request.view, request.theme));
        break;
    }
    reply(session, id, signal, undefined);
  };
  run()
    .catch((error: unknown) => {
      if (signal.aborted || session.closed || isAbort(error)) return;
      const navigation = request.op !== "prepare" && request.op !== "assets" && request.op !== "pages";
      fail(session, id, error, navigation ? "EPUB_NAVIGATION_FAILED" : "EPUB_PAGE_UNAVAILABLE");
    })
    .finally(() => session.requests.delete(id));
}

function fail(session: Session, id: number | null, error: unknown, fallback: EpubFailureCode): void {
  post({
    type: "failure",
    generation: session.generation,
    id,
    code: error instanceof EpubBridgeError ? error.code : fallback,
    message: error instanceof Error ? error.message : String(error),
  });
}

async function closeSession(session: Session): Promise<void> {
  session.closed = true;
  for (const stop of session.docStops.values()) stop();
  session.docStops.clear();
  for (const controller of [...session.requests.values()]) controller.abort();
  session.content.dispose();
  await session.renditions.close();
}

async function open(generation: number, bytes: ArrayBuffer): Promise<void> {
  const token = (openToken += 1);
  const previous = current;
  current = null;
  if (previous) await closeSession(previous);
  let book: BookLike | null = null;
  try {
    const globals = window as unknown as { ePub?: EpubGlobal; default?: EpubGlobal };
    const epub = globals.ePub ?? globals.default;
    if (!epub) throw new Error("epub.js did not load");
    book = epub(bytes);
    await book.ready;
    const navigation = await book.loaded.navigation;
    const opened = book;
    const fixedLayout = opened.packaging.metadata?.layout === "pre-paginated";
    const toc = flattenEpubToc(
      navigation.toc,
      opened.packaging.navPath || opened.packaging.ncxPath || "",
      (href) => opened.spine.get(href)?.index ?? null,
    );
    if (token !== openToken) {
      opened.destroy();
      return;
    }
    // After the book's own substitution hook, which registered while it unpacked.
    opened.spine.hooks.serialize.register((_output, section) => styles.serialize(section));
    const rendition = opened.renderTo("viewer", {
      width: "100%",
      height: "100%",
      flow: "paginated",
      spread: "none",
      allowScriptedContent: false,
    });
    const renditions = new EpubRenditions(opened, rendition, fixedLayout, styles);
    const session: Session = {
      generation,
      renditions,
      rendition,
      content: createEpubContent(opened, epub.CFI),
      closed: false,
      requests: new Map(),
      acks: new Map(),
      moves: Promise.resolve(),
      posts: Promise.resolve(),
      queued: null,
      lastPosted: "",
      selectionSeq: 0,
      docStops: new Map(),
    };
    // epub.js relayouts on its own when the window resizes.
    rendition.on("relocated", () => {
      session.selectionSeq += 1;
      publish(session).catch((error: unknown) => console.error("relocation failed", error));
    });
    rendition.on("selected", (_cfiRange: string, contents: ContentsLike) => {
      handleSelection(session, contents).catch((error: unknown) => console.error("selection failed", error));
    });
    // Non-passive and in the capture phase: epub.js forwards key events through passive listeners that cannot cancel them.
    rendition.hooks.content.register((contents) => {
      if (session.closed) return;
      for (const [shown, stop] of session.docStops) {
        if (shown.defaultView) continue;
        stop();
        session.docStops.delete(shown);
      }
      const stopKeys = watchReaderKeys(contents.document, (shortcut) => forwardKey(session, shortcut));
      const stopPointer = watchPointerActivity(contents.document, () => forwardPointer(session));
      session.docStops.set(contents.document, () => {
        stopKeys();
        stopPointer();
      });
    });
    current = session;
    post({
      type: "ready",
      generation,
      info: { sectionCount: opened.spine.length, toc, fixedLayout },
    });
  } catch (error) {
    book?.destroy();
    if (token === openToken) {
      post({
        type: "failure",
        generation,
        id: null,
        code: "EPUB_OPEN_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

window.addEventListener("message", (event: MessageEvent<ParentMessage | null>) => {
  if (event.source !== window.parent || event.origin !== location.origin) return;
  const message = event.data;
  if (!message || typeof message !== "object") return;
  if (message.type === "hello") {
    post({ type: "viewer-ready" });
    return;
  }
  if (message.type === "open") {
    void open(message.generation, message.bytes);
    return;
  }
  const session = current;
  if (!session || session.generation !== message.generation) return;
  switch (message.type) {
    case "request":
      serve(session, message.id, message.request);
      return;
    case "cancel":
      session.requests.get(message.id)?.abort();
      return;
    case "ack":
      session.acks.get(message.id)?.();
      return;
    case "clear-selection":
      session.selectionSeq += 1;
      for (const contents of session.rendition.getContents()) {
        contents.window.getSelection()?.removeAllRanges();
      }
      post({ type: "selection", generation: session.generation, selection: null });
      return;
  }
});

post({ type: "viewer-ready" });

// Focus can also rest on the viewer page itself, outside any section.
watchReaderKeys(document, (shortcut) => (current ? forwardKey(current, shortcut) : false));
watchPointerActivity(document, () => {
  if (current) forwardPointer(current);
});
