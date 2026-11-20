import { spawnTypstWorker, TypstError } from "./typst";
import {
  hasRetainedDraft,
  isActiveStage,
  type TranslationTask,
} from "./translation-queue";

/** Translation only, or each original page followed by its translation. */
export type ExportLayout = "translation" | "interleaved";

/**
 * The width translation pages are typeset at; their height always follows the
 * content, so every translation stays one sheet. `original` matches each
 * original page, and `saved` keeps the width the translation was saved with.
 */
export type TranslationWidth = "a4" | "letter" | "a5" | "b5" | "original" | "saved";

export const TRANSLATION_WIDTHS: readonly TranslationWidth[] = [
  "a4",
  "letter",
  "a5",
  "b5",
  "original",
  "saved",
];

const FIXED_WIDTHS: Record<Exclude<TranslationWidth, "original" | "saved">, string> = {
  a4: "210mm",
  letter: "8.5in",
  a5: "148mm",
  b5: "176mm",
};

/** A page size in PostScript points, as PDF.js reports it at scale 1 (rotation applied). */
export interface PageSize {
  width: number;
  height: number;
}

export interface ExportFile {
  path: string;
  data: Uint8Array;
}

// ---------------------------------------------------------------------------
// Page setup override

const OVERRIDE = "lumo-page";
const IDENT = /[\p{ID_Start}_][\p{ID_Continue}-]*/uy;

class ScanError extends Error {}

/**
 * Rewrites a saved translation so its pages are `width` wide with automatic
 * height. A first line binds the override and applies it; every `set page(…)`
 * and `page(…)` call then gets `..lumo-page` as its last argument, so the
 * override wins over the arguments the model wrote (spread arguments are
 * last-wins) while margins, fills and the rest stay as they were. Returns null
 * when the source cannot be scanned with confidence; the caller then keeps the
 * saved source unchanged.
 */
export function overridePageWidth(source: string, width: string): string | null {
  const insertions: { at: number; text: string }[] = [];
  const s = source;
  const n = s.length;

  const comment = (i: number): number => {
    if (s.startsWith("//", i)) {
      const end = s.indexOf("\n", i);
      return end < 0 ? n : end;
    }
    // Block comments nest.
    let depth = 0;
    let j = i;
    while (j < n) {
      if (s.startsWith("/*", j)) {
        depth += 1;
        j += 2;
      } else if (s.startsWith("*/", j)) {
        depth -= 1;
        j += 2;
        if (depth === 0) return j;
      } else {
        j += 1;
      }
    }
    throw new ScanError("unterminated comment");
  };

  const isComment = (i: number): boolean =>
    s[i] === "/" && (s[i + 1] === "/" || s[i + 1] === "*");

  const raw = (i: number): number => {
    let ticks = 0;
    while (s[i + ticks] === "`") ticks += 1;
    if (ticks === 2) return i + 2;
    const fence = "`".repeat(ticks >= 3 ? ticks : 1);
    const end = s.indexOf(fence, i + ticks);
    if (end < 0) throw new ScanError("unterminated raw text");
    return end + fence.length;
  };

  const string = (i: number): number => {
    let j = i + 1;
    while (j < n) {
      if (s[j] === "\\") j += 2;
      else if (s[j] === '"') return j + 1;
      else j += 1;
    }
    throw new ScanError("unterminated string");
  };

  const ident = (i: number): string | null => {
    IDENT.lastIndex = i;
    return IDENT.exec(s)?.[0] ?? null;
  };

  const skipSpaces = (i: number): number => {
    while (s[i] === " " || s[i] === "\t") i += 1;
    return i;
  };

  /**
   * Scans code. With a closer, it ends after that closer and reports the last
   * significant character inside; without one it is an embedded statement in
   * markup and ends at the end of the line, a `;`, or an unmatched closer.
   */
  const code = (start: number, closer: ")" | "}" | null): { end: number; last: string } => {
    let i = start;
    let last = "";
    while (i < n) {
      const c = s[i]!;
      if (closer === null) {
        if (c === "\n" || c === "\r") return { end: i, last };
        if (c === ";") return { end: i + 1, last };
        if (c === ")" || c === "}" || c === "]") return { end: i, last };
        if (s.startsWith("//", i)) return { end: comment(i), last };
      }
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        i += 1;
        continue;
      }
      if (isComment(i)) {
        i = comment(i);
        continue;
      }
      if (c === closer) return { end: i + 1, last };
      if (c === ")" || c === "}" || c === "]") throw new ScanError("unbalanced code");
      if (c === '"') {
        i = string(i);
      } else if (c === "`") {
        i = raw(i);
      } else if (c === "(") {
        i = code(i + 1, ")").end;
      } else if (c === "{") {
        i = code(i + 1, "}").end;
      } else if (c === "[") {
        i = markup(i + 1, true);
      } else if (c === "$") {
        i = math(i + 1);
      } else {
        const word = ident(i);
        if (word) {
          const end = i + word.length;
          i = word === "page" && last !== "." ? pageCall(end) : end;
          last = "a";
          continue;
        }
        i += 1;
        last = c;
        continue;
      }
      last = c;
    }
    throw new ScanError("unterminated code");
  };

  // `page` was read and ends at `end`: overrides its arguments when it is a call.
  const pageCall = (end: number): number => {
    if (s[end] === "(") {
      const args = code(end + 1, ")");
      const close = args.end - 1;
      const bare = args.last === "" || args.last === ",";
      insertions.push({ at: close, text: `${bare ? "" : ", "}..${OVERRIDE}` });
      return args.end;
    }
    if (s[end] === "[") {
      insertions.push({ at: end, text: `(..${OVERRIDE})` });
    }
    return end;
  };

  // Calls, trailing content blocks and field accesses that follow an embedded expression.
  const postfix = (start: number): number => {
    let i = start;
    for (;;) {
      if (s[i] === "(") i = code(i + 1, ")").end;
      else if (s[i] === "[") i = markup(i + 1, true);
      else if (s[i] === "." && ident(i + 1)) i += 1 + ident(i + 1)!.length;
      else return i;
    }
  };

  // After `#` in markup or math.
  const embedded = (i: number): number => {
    const c = s[i];
    if (c === "(") return postfix(code(i + 1, ")").end);
    if (c === "{") return code(i + 1, "}").end;
    if (c === "[") return markup(i + 1, true);
    if (c === '"') return string(i);
    const word = ident(i);
    if (!word) return i;
    const end = i + word.length;
    switch (word) {
      case "set": {
        // `set target(args)`, then an optional `if condition` to the end of the line.
        const target = skipSpaces(end);
        const name = ident(target);
        if (!name) return code(end, null).end;
        const after = target + name.length;
        const next = skipSpaces(name === "page" ? pageCall(after) : postfix(after));
        return ident(next) === "if" ? code(next + 2, null).end : next;
      }
      case "context":
        return embedded(skipSpaces(end));
      case "let":
      case "show":
      case "import":
      case "include":
      case "if":
      case "for":
      case "while":
      case "return":
        return code(end, null).end;
      case "page":
        return postfix(pageCall(end));
      default:
        return postfix(end);
    }
  };

  const linkEnd = (i: number): number => {
    let depth = 0;
    let j = i;
    while (j < n) {
      const c = s[j]!;
      if (/\s/.test(c) || c === "<" || c === ">" || c === '"') break;
      if (c === "(" || c === "[") depth += 1;
      else if (c === ")" || c === "]") {
        if (depth === 0) break;
        depth -= 1;
      }
      j += 1;
    }
    return j;
  };

  const isLink = (i: number): boolean =>
    (s.startsWith("http://", i) || s.startsWith("https://", i)) &&
    (i === 0 || !/[\p{L}\p{N}]/u.test(s[i - 1]!));

  // Markup, at the top level or inside `[…]` (then it ends after the closing bracket).
  function markup(start: number, nested: boolean): number {
    let i = start;
    let depth = 0;
    while (i < n) {
      const c = s[i]!;
      if (c === "\\") {
        i += 2;
      } else if (isComment(i)) {
        i = comment(i);
      } else if (c === "h" && isLink(i)) {
        i = linkEnd(i);
      } else if (c === "`") {
        i = raw(i);
      } else if (c === "$") {
        i = math(i + 1);
      } else if (c === "#") {
        i = embedded(i + 1);
      } else if (c === "[") {
        depth += 1;
        i += 1;
      } else if (c === "]") {
        if (depth === 0) {
          if (!nested) throw new ScanError("unbalanced bracket");
          return i + 1;
        }
        depth -= 1;
        i += 1;
      } else {
        i += 1;
      }
    }
    if (nested) throw new ScanError("unterminated content block");
    return n;
  }

  // Math after its opening `$`; brackets need not balance here.
  function math(start: number): number {
    let i = start;
    while (i < n) {
      const c = s[i]!;
      if (c === "\\") i += 2;
      else if (c === "$") return i + 1;
      else if (c === '"') i = string(i);
      else if (isComment(i)) i = comment(i);
      else if (c === "#") i = embedded(i + 1);
      else i += 1;
    }
    throw new ScanError("unterminated math");
  }

  try {
    markup(0, false);
  } catch (error) {
    if (error instanceof ScanError) return null;
    throw error;
  }

  let result = s;
  for (const insertion of insertions.sort((a, b) => b.at - a.at)) {
    result = result.slice(0, insertion.at) + insertion.text + result.slice(insertion.at);
  }
  return `#let ${OVERRIDE} = (width: ${width}, height: auto, flipped: false); #set page(..${OVERRIDE})\n${result}`;
}

// ---------------------------------------------------------------------------
// The combined document

export type OriginalMode = "vector" | "raster";

export type ExportTranslation =
  /** A module the main document includes. */
  | { kind: "include"; path: string }
  /** A translation compiled on its own; its pages are placed as images. */
  | { kind: "embedded"; path: string; pages: number };

export interface ExportEntry {
  pageNumber: number;
  /** Needed for an interleaved original. */
  size?: PageSize;
  /** Null when the page has no translation. */
  translation: ExportTranslation | null;
}

const ORIGINAL_PATH = "original.pdf";

function translationPath(pageNumber: number, extension: "typ" | "pdf"): string {
  return `t/${pageNumber}.${extension}`;
}

function rasterPath(pageNumber: number): string {
  return `o/${pageNumber}.jpg`;
}

function typstString(value: string): string {
  return `"${value.replace(/[\\"]/g, (char) => `\\${char}`).replace(/\r?\n|\r/g, " ")}"`;
}

const points = (value: number): string => `${Math.round(value * 1000) / 1000}pt`;

/**
 * The main document of an export. Each translation starts on a new page; an
 * interleaved original fills a page of its own size before its translation.
 * A translation-only export leaves out pages without a translation.
 */
export function buildExportMain(options: {
  title: string;
  layout: ExportLayout;
  original: OriginalMode;
  entries: readonly ExportEntry[];
}): string {
  const lines = [`#set document(title: ${typstString(options.title)})`];
  for (const entry of options.entries) {
    if (options.layout === "interleaved") {
      if (!entry.size) throw new Error(`page ${entry.pageNumber} has no size`);
      const image =
        options.original === "vector"
          ? `image(${typstString(ORIGINAL_PATH)}, page: ${entry.pageNumber}, width: 100%, height: 100%, fit: "contain")`
          : `image(${typstString(rasterPath(entry.pageNumber))}, width: 100%, height: 100%, fit: "contain")`;
      lines.push(
        `#page(width: ${points(entry.size.width)}, height: ${points(entry.size.height)}, margin: 0pt, ${image})`,
      );
    }
    const translation = entry.translation;
    if (!translation) continue;
    if (translation.kind === "include") {
      lines.push(`#pagebreak(weak: true)`, `#include ${typstString(translation.path)}`);
    } else {
      for (let page = 1; page <= translation.pages; page += 1) {
        lines.push(
          `#page(width: auto, height: auto, margin: 0pt, image(${typstString(translation.path)}, page: ${page}))`,
        );
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Which selected pages are ready

export interface ExportPageStatus {
  saved: number[];
  /** Queued or being translated now. */
  inProgress: number[];
  /** The last attempt failed; it can be retried. */
  failed: number[];
  /** An unsaved draft holds the page until it is saved or discarded. */
  drafts: number[];
  /** No translation and no task. */
  untranslated: number[];
}

/** Sorts the selected pages by what stands between them and the export. */
export function classifyExportPages(
  pages: readonly number[],
  saved: ReadonlySet<number>,
  tasks: readonly Pick<TranslationTask, "pageNumber" | "stage" | "draft">[],
): ExportPageStatus {
  const byPage = new Map(tasks.map((task) => [task.pageNumber, task]));
  const status: ExportPageStatus = {
    saved: [],
    inProgress: [],
    failed: [],
    drafts: [],
    untranslated: [],
  };
  for (const page of pages) {
    const task = byPage.get(page);
    if (saved.has(page)) status.saved.push(page);
    else if (task && hasRetainedDraft(task)) status.drafts.push(page);
    else if (task && (task.stage === "queued" || isActiveStage(task.stage)))
      status.inProgress.push(page);
    else if (task?.stage === "error") status.failed.push(page);
    else status.untranslated.push(page);
  }
  return status;
}

// ---------------------------------------------------------------------------
// Building the PDF

/** Typst rejected a PDF document; `paths` are the files its diagnostics point into. */
export class TypstPdfCompileError extends TypstError {
  constructor(
    message: string,
    readonly paths: readonly string[],
  ) {
    super("TYPST_COMPILE_FAILED", message);
    this.name = "TypstPdfCompileError";
  }
}

export class PdfExportError extends Error {
  constructor(
    readonly code: "EXPORT_PDF_NONE",
    message: string,
  ) {
    super(message);
    this.name = "PdfExportError";
  }
}

/** The original document, opened for one export. */
export interface ExportOriginal {
  /** The stored file; never handed to anything that transfers its buffer. */
  readonly bytes: Uint8Array;
  pageSize(pageNumber: number): Promise<PageSize>;
  renderJpeg(pageNumber: number, signal: AbortSignal): Promise<Uint8Array>;
  /** Pages of a PDF Typst produced. */
  countPages(pdf: Uint8Array): Promise<number>;
}

export interface PdfCompiler {
  /** Compiles `main` with `files`; the caller's buffers are left intact. */
  compile(main: string, files: readonly ExportFile[], signal: AbortSignal): Promise<Uint8Array>;
}

export type PdfExportProgress =
  | { phase: "originals"; done: number; total: number }
  | { phase: "typesetting" };

export interface PdfExportRequest {
  title: string;
  layout: ExportLayout;
  width: TranslationWidth;
  /** Selected page numbers. */
  pages: readonly number[];
  /** Saved Typst per page; a selected page without one has no translation in the export. */
  sources: ReadonlyMap<number, string>;
}

export interface PdfExportResult {
  pdf: Uint8Array;
  /** Pages typeset at their saved width because the chosen width could not be applied. */
  keptSavedWidth: number[];
}

const TRANSLATION_PATH = /^t\/(\d+)\.typ$/;

/**
 * Typesets the export in one Typst document. A translation that breaks the
 * combined document is compiled on its own (with the chosen width, or else as
 * saved) and placed as PDF pages; originals Typst cannot read are rendered to
 * images by PDF.js instead.
 */
export async function buildTranslationPdf(
  request: PdfExportRequest,
  services: { compiler: PdfCompiler; original: ExportOriginal },
  signal: AbortSignal,
  onProgress: (progress: PdfExportProgress) => void = () => {},
): Promise<PdfExportResult> {
  const { compiler, original } = services;
  const pages = [...new Set(request.pages)].sort((a, b) => a - b);
  const interleaved = request.layout === "interleaved";
  if (!pages.some((page) => request.sources.has(page))) {
    throw new PdfExportError("EXPORT_PDF_NONE", "no selected page has a saved translation");
  }

  const sizes = new Map<number, PageSize>();
  if (interleaved || request.width === "original") {
    for (const page of pages) {
      signal.throwIfAborted();
      sizes.set(page, await original.pageSize(page));
    }
  }

  const keptSavedWidth: number[] = [];
  const modules = new Map<number, string>();
  for (const page of pages) {
    const source = request.sources.get(page);
    if (source === undefined) continue;
    if (request.width === "saved") {
      modules.set(page, source);
      continue;
    }
    const rewritten = overridePageWidth(source, widthOf(request.width, sizes.get(page)));
    if (rewritten === null) keptSavedWidth.push(page);
    modules.set(page, rewritten ?? source);
  }

  let mode: OriginalMode = "vector";
  const rasters: ExportFile[] = [];
  const useRaster = async (): Promise<void> => {
    mode = "raster";
    for (const [index, page] of pages.entries()) {
      onProgress({ phase: "originals", done: index, total: pages.length });
      rasters.push({ path: rasterPath(page), data: await original.renderJpeg(page, signal) });
    }
    onProgress({ phase: "originals", done: pages.length, total: pages.length });
  };

  if (interleaved) {
    try {
      await compiler.compile(
        `#image(${typstString(ORIGINAL_PATH)}, page: ${pages[0]})`,
        [{ path: ORIGINAL_PATH, data: original.bytes }],
        signal,
      );
    } catch (error) {
      if (!(error instanceof TypstPdfCompileError)) throw error;
      await useRaster();
    }
  }

  const embedded = new Map<number, { path: string; data: Uint8Array; pages: number }>();
  const isolate = async (page: number): Promise<void> => {
    const source = request.sources.get(page)!;
    const rewritten = modules.get(page)!;
    let pdf: Uint8Array;
    try {
      pdf = await compiler.compile(rewritten, [], signal);
    } catch (error) {
      if (!(error instanceof TypstPdfCompileError) || rewritten === source) throw error;
      pdf = await compiler.compile(source, [], signal);
      keptSavedWidth.push(page);
    }
    embedded.set(page, {
      path: translationPath(page, "pdf"),
      data: pdf,
      pages: await original.countPages(pdf),
    });
  };

  for (;;) {
    signal.throwIfAborted();
    onProgress({ phase: "typesetting" });
    const entries: ExportEntry[] = [];
    const files: ExportFile[] = [];
    for (const page of pages) {
      const isolated = embedded.get(page);
      const module = modules.get(page);
      let translation: ExportTranslation | null = null;
      if (isolated) {
        translation = { kind: "embedded", path: isolated.path, pages: isolated.pages };
        files.push({ path: isolated.path, data: isolated.data });
      } else if (module !== undefined) {
        const path = translationPath(page, "typ");
        translation = { kind: "include", path };
        files.push({ path, data: new TextEncoder().encode(module) });
      }
      if (!translation && !interleaved) continue;
      entries.push({
        pageNumber: page,
        ...(sizes.has(page) ? { size: sizes.get(page)! } : {}),
        translation,
      });
    }
    if (interleaved) {
      files.push(...(mode === "vector" ? [{ path: ORIGINAL_PATH, data: original.bytes }] : rasters));
    }
    const main = buildExportMain({
      title: request.title,
      layout: request.layout,
      original: mode,
      entries,
    });
    try {
      const pdf = await compiler.compile(main, files, signal);
      return { pdf, keptSavedWidth: [...new Set(keptSavedWidth)].sort((a, b) => a - b) };
    } catch (error) {
      if (!(error instanceof TypstPdfCompileError)) throw error;
      const failing = error.paths
        .map((path) => TRANSLATION_PATH.exec(path)?.[1])
        .filter((page): page is string => page !== undefined)
        .map(Number)
        .filter((page) => modules.has(page) && !embedded.has(page));
      if (failing.length > 0) {
        for (const page of failing) await isolate(page);
        continue;
      }
      if (interleaved && mode === "vector") {
        await useRaster();
        continue;
      }
      throw error;
    }
  }
}

function widthOf(width: Exclude<TranslationWidth, "saved">, size: PageSize | undefined): string {
  if (width !== "original") return FIXED_WIDTHS[width];
  if (!size) throw new Error("the original page size is missing");
  return points(size.width);
}

// ---------------------------------------------------------------------------
// A Typst worker of its own

/**
 * Compiles export documents in a dedicated Typst worker, one at a time, with
 * no time limit: an export can be long, and Cancel ends it by terminating the
 * worker. Preview compiles keep their own worker meanwhile.
 */
export class TypstPdfWorker implements PdfCompiler {
  private worker: Worker | null = null;
  private ready: Promise<Worker> | null = null;
  private nextId = 1;
  private pending: {
    id: number;
    resolve: (pdf: Uint8Array) => void;
    reject: (error: unknown) => void;
  } | null = null;

  compile(main: string, files: readonly ExportFile[], signal: AbortSignal): Promise<Uint8Array> {
    if (signal.aborted) return Promise.reject(abortError());
    if (this.pending) return Promise.reject(new Error("a PDF compile is already running"));
    const { promise, resolve, reject } = Promise.withResolvers<Uint8Array>();
    const id = this.nextId++;
    // Terminating the worker is the only way to stop a compile; close() fails this one.
    const onAbort = (): void => this.close();
    signal.addEventListener("abort", onAbort, { once: true });
    const settle = {
      id,
      resolve: (pdf: Uint8Array) => {
        signal.removeEventListener("abort", onAbort);
        this.pending = null;
        resolve(pdf);
      },
      reject: (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        this.pending = null;
        reject(error);
      },
    };
    this.pending = settle;
    void this.start().then(
      (worker) => {
        if (this.pending !== settle) return;
        const copies = files.map((file) => ({ path: file.path, data: file.data.slice() }));
        worker.postMessage(
          { type: "pdf", id, main, files: copies },
          copies.map((file) => file.data.buffer),
        );
      },
      (error: unknown) => {
        if (this.pending === settle) settle.reject(error);
      },
    );
    return promise;
  }

  /** Ends the worker; a compile still running fails. */
  close(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    const pending = this.pending;
    this.pending = null;
    pending?.reject(abortError());
  }

  private start(): Promise<Worker> {
    if (this.ready) return this.ready;
    const spawned = spawnTypstWorker("lumo-typst-pdf", {
      onMessage: (message) => {
        if (this.worker !== spawned.worker) return;
        const pending = this.pending;
        if (!pending || message.id !== pending.id) return;
        if (message.type === "pdf-done" && message.data instanceof Uint8Array) {
          pending.resolve(message.data);
        } else if (message.type === "pdf-failed") {
          pending.reject(
            new TypstPdfCompileError(
              typeof message.message === "string" ? message.message : "Typst compilation failed",
              Array.isArray(message.paths)
                ? message.paths.filter((path): path is string => typeof path === "string")
                : [],
            ),
          );
        }
      },
      onFailure: (error) => {
        if (this.worker !== spawned.worker) return;
        this.worker?.terminate();
        this.worker = null;
        this.ready = null;
        const pending = this.pending;
        this.pending = null;
        pending?.reject(error);
      },
    });
    this.worker = spawned.worker;
    this.ready = spawned.ready;
    return spawned.ready;
  }
}

function abortError(): DOMException {
  return new DOMException("the PDF export was cancelled", "AbortError");
}
