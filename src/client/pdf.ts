import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { MAX_IMAGE_BASE64_CHARS } from "../shared/contracts";
import {
  MAX_CONTEXT_IMAGE_BASE64_CHARS,
  MAX_PAGE_TEXT_CHARS,
  MAX_TRANSLATION_CONTEXT_CHARS,
} from "../shared/limits";
import type { TranslationContext, TranslationReference } from "../shared/contracts";
import { accessToken } from "./api";
import type { PreparedTranslationPage } from "./translation-queue";
import type { ViewerBridge } from "./pdfBridge";

export class PagePreparationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly params?: Record<string, string | number>,
  ) {
    super(message);
    this.name = "PagePreparationError";
  }
}

const RENDER_LONG_EDGE = 2000;
const CONTEXT_EDGE_LONG_EDGE = 1000;
const CONTEXT_EDGE_RATIO = 0.2;

export async function extractPageText(page: PDFPageProxy): Promise<string> {
  const content = await page.getTextContent();
  let text = "";
  for (const item of content.items) {
    if (!("str" in item)) continue;
    text += item.str;
    text += item.hasEOL ? "\n" : " ";
  }
  return text.trim();
}

export async function preparePageForTranslation(
  page: PDFPageProxy,
  targetDocument: Document,
  signal: AbortSignal,
): Promise<{ text: string; imageBase64: string }> {
  signal.throwIfAborted();

  const text = await extractPageText(page);
  if (text.length > MAX_PAGE_TEXT_CHARS) {
    throw new PagePreparationError(
      "PAGE_TEXT_TOO_LARGE",
      `this page produced ${text.length} characters, over the 100000 limit`,
      { length: text.length },
    );
  }

  const base = page.getViewport({ scale: 1 });
  const scale = RENDER_LONG_EDGE / Math.max(base.width, base.height);
  const viewport = page.getViewport({ scale });

  const canvas = targetDocument.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));

  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    throw new PagePreparationError("PAGE_RENDER_FAILED", "the browser could not create a canvas");
  }

  const renderTask = page.render({
    canvas,
    viewport,
    background: "#ffffff",
  });
  const onAbort = () => renderTask.cancel();
  signal.addEventListener("abort", onAbort, { once: true });

  let dataUrl: string;
  try {
    await renderTask.promise;
    signal.throwIfAborted();
    dataUrl = canvas.toDataURL("image/jpeg", 0.9);
  } catch (error) {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    throw new PagePreparationError(
      "PAGE_RENDER_FAILED",
      error instanceof Error ? error.message : "the page could not be rendered",
    );
  } finally {
    signal.removeEventListener("abort", onAbort);
    canvas.width = 0;
    canvas.height = 0;
  }

  const imageBase64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  if (!imageBase64.startsWith("/9j/")) {
    throw new PagePreparationError("PAGE_RENDER_FAILED", "the page image is not JPEG");
  }
  if (imageBase64.length > MAX_IMAGE_BASE64_CHARS) {
    throw new PagePreparationError(
      "PAGE_IMAGE_TOO_LARGE",
      "the page image exceeds the 6000000 character limit",
      { length: imageBase64.length },
    );
  }

  return { text, imageBase64 };
}

function textChunk(item: unknown): string | null {
  if (typeof item !== "object" || item === null || !("str" in item)) return null;
  return `${item.str}${"hasEOL" in item && item.hasEOL ? "\n" : " "}`;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

// Reads items from the end only until the trimmed text exceeds the budget.
export function pageTailText(items: readonly unknown[], limit: number): string {
  let tail = "";
  for (let i = items.length - 1; i >= 0; i--) {
    const chunk = textChunk(items[i]) ?? "";
    tail = chunk + tail;
    if (chunk.trim() && tail.trim().length > limit) break;
  }
  const text = tail.trim();
  const excerpt = text.slice(-limit);
  return text.length > limit && isLowSurrogate(excerpt.charCodeAt(0)) ? excerpt.slice(1) : excerpt;
}

// Mirror of pageTailText, reading from the start of the page.
export function pageHeadText(items: readonly unknown[], limit: number): string {
  let head = "";
  for (let i = 0; i < items.length; i++) {
    const chunk = textChunk(items[i]) ?? "";
    head += chunk;
    if (chunk.trim() && head.trim().length > limit) break;
  }
  const text = head.trim();
  const excerpt = text.slice(0, limit);
  return text.length > limit && isHighSurrogate(excerpt.charCodeAt(limit - 1))
    ? excerpt.slice(0, -1)
    : excerpt;
}

// Re-encodes at a smaller long edge until the JPEG fits the neighbour budget.
export async function encodeWithinContextBudget(
  encode: (longEdge: number) => Promise<string>,
): Promise<string> {
  let longEdge = CONTEXT_EDGE_LONG_EDGE;
  for (;;) {
    const base64 = await encode(longEdge);
    if (base64.length <= MAX_CONTEXT_IMAGE_BASE64_CHARS) return base64;
    if (longEdge === 1) {
      throw new PagePreparationError(
        "PAGE_IMAGE_TOO_LARGE",
        "the neighbouring page edge image exceeds the context limit",
        { length: base64.length },
      );
    }
    longEdge = Math.max(1, Math.floor(longEdge * 0.75));
  }
}

type ContextSide = "previous" | "next";

// Neighbour failures become warnings; abort and target failures still reject the whole prepare.
export async function preparePdfTranslationPage(
  bridge: ViewerBridge,
  pageNumber: number,
  signal: AbortSignal,
): Promise<PreparedTranslationPage> {
  const borrowed: { number: number; page: PDFPageProxy }[] = [];
  const borrow = async (number: number) => {
    const page = await bridge.getPage(number);
    borrowed.push({ number, page });
    return page;
  };
  const reference = (number: number, side: ContextSide) =>
    borrow(number).then((page) => referenceFromPage(page, side, bridge.document, signal));

  try {
    const [target, previous, next] = await Promise.allSettled([
      borrow(pageNumber).then((page) => preparePageForTranslation(page, bridge.document, signal)),
      pageNumber > 1 ? reference(pageNumber - 1, "previous") : Promise.resolve(undefined),
      pageNumber < bridge.pageCount ? reference(pageNumber + 1, "next") : Promise.resolve(undefined),
    ]);
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    if (target.status === "rejected") throw target.reason;

    const context: TranslationContext = {};
    const contextWarnings: ContextSide[] = [];
    for (const [side, result] of [["previous", previous], ["next", next]] as const) {
      if (result.status === "rejected") contextWarnings.push(side);
      else if (result.value) context[side] = result.value;
    }
    return {
      format: "pdf",
      text: target.value.text,
      imageBase64: target.value.imageBase64,
      ...(Object.keys(context).length > 0 ? { context } : {}),
      ...(contextWarnings.length > 0 ? { contextWarnings } : {}),
    };
  } finally {
    for (const { number, page } of borrowed) {
      if (number !== bridge.page) page.cleanup();
    }
  }
}

async function referenceFromPage(
  page: PDFPageProxy,
  side: ContextSide,
  targetDocument: Document,
  signal: AbortSignal,
): Promise<TranslationReference> {
  const content = await page.getTextContent();
  signal.throwIfAborted();
  const text =
    side === "previous"
      ? pageTailText(content.items, MAX_TRANSLATION_CONTEXT_CHARS)
      : pageHeadText(content.items, MAX_TRANSLATION_CONTEXT_CHARS);
  if (text) return { text };
  return { imageBase64: await renderContextEdge(page, side, targetDocument, signal) };
}

// Renders only the strip of the neighbouring page that faces the target page.
async function renderContextEdge(
  page: PDFPageProxy,
  side: ContextSide,
  targetDocument: Document,
  signal: AbortSignal,
): Promise<string> {
  const base = page.getViewport({ scale: 1 });
  return encodeWithinContextBudget(async (longEdge) => {
    signal.throwIfAborted();
    const scale = longEdge / Math.max(base.width, base.height * CONTEXT_EDGE_RATIO);
    const pageHeight = base.height * scale;
    const stripHeight = Math.max(1, Math.floor(pageHeight * CONTEXT_EDGE_RATIO));
    const viewport = page.getViewport({
      scale,
      offsetY: side === "previous" ? stripHeight - pageHeight : 0,
    });

    const canvas = targetDocument.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = stripHeight;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new PagePreparationError("PAGE_RENDER_FAILED", "the browser could not create a canvas");
    }

    const renderTask = page.render({ canvas, viewport, background: "#ffffff" });
    const onAbort = () => renderTask.cancel();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await renderTask.promise;
      signal.throwIfAborted();
      const dataUrl = canvas.toDataURL("image/jpeg", 0.75);
      const imageBase64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      if (!imageBase64.startsWith("/9j/")) {
        throw new PagePreparationError("PAGE_RENDER_FAILED", "the page edge image is not JPEG");
      }
      return imageBase64;
    } catch (error) {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      if (error instanceof PagePreparationError) throw error;
      throw new PagePreparationError(
        "PAGE_RENDER_FAILED",
        error instanceof Error ? error.message : "the page edge could not be rendered",
      );
    } finally {
      signal.removeEventListener("abort", onAbort);
      canvas.width = 0;
      canvas.height = 0;
    }
  });
}

interface PdfjsRuntime {
  getDocument(options: Record<string, unknown>): {
    promise: Promise<PDFDocumentProxy>;
    destroy(): Promise<void>;
  };
  GlobalWorkerOptions: { workerSrc: string };
}

async function loadPdfjsRuntime(): Promise<PdfjsRuntime> {
  // The npm package supplies types only; the viewer's pinned official binary is
  // imported at runtime from the same route the iframe uses. Function-wrapped
  // import keeps the bundler from rewriting a URL that only exists at runtime.
  const runtimeUrl = `${location.origin}/pdfjs/build/pdf.mjs`;
  const importAtRuntime = new Function(
    "url",
    "return import(url)",
  ) as (url: string) => Promise<unknown>;
  const namespace: unknown = await importAtRuntime(runtimeUrl);
  if (
    !namespace ||
    typeof namespace !== "object" ||
    !("getDocument" in namespace) ||
    typeof namespace.getDocument !== "function" ||
    !("GlobalWorkerOptions" in namespace) ||
    !namespace.GlobalWorkerOptions ||
    (typeof namespace.GlobalWorkerOptions !== "object" &&
      typeof namespace.GlobalWorkerOptions !== "function")
  ) {
    throw new PagePreparationError(
      "PDF_RUNTIME_UNAVAILABLE",
      "PDF.js runtime module is not available",
    );
  }
  return namespace as PdfjsRuntime;
}

export async function validatePdfCopy(
  data: Uint8Array,
  expectedPageCount: number,
  pageToRead: number,
  password?: string,
): Promise<void> {
  const pdfjs = await loadPdfjsRuntime();
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/build/pdf.worker.mjs";

  const task = pdfjs.getDocument({
    // PDF.js transfers this buffer to its worker; callers must retain any bytes
    // they still need (for example an upload Blob) before validation.
    data,
    ...(password ? { password } : {}),
    disableRange: true,
    disableStream: true,
    cMapUrl: "/pdfjs/web/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/web/standard_fonts/",
    wasmUrl: "/pdfjs/web/wasm/",
    iccUrl: "/pdfjs/web/iccs/",
  });

  try {
    const document = await task.promise;
    if (document.numPages !== expectedPageCount) {
      throw new PagePreparationError(
        "COPY_PAGE_COUNT_MISMATCH",
        `the copy has ${document.numPages} pages; expected ${expectedPageCount}`,
        { actual: document.numPages, expected: expectedPageCount },
      );
    }
    await document.getPage(Math.min(Math.max(1, pageToRead), document.numPages));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "name" in error &&
      error.name === "PasswordException"
    ) {
      throw new PagePreparationError(
        "COPY_ENCRYPTED",
        "the copy is encrypted; the password is missing or incorrect",
      );
    }
    throw error;
  } finally {
    await task.destroy().catch(() => {});
  }
}

const COVER_LONG_EDGE = 480;

/**
 * Renders page 1 of a stored PDF into a small JPEG for the shelf. The PDF is
 * fetched by PDF.js from the authenticated app route, so the access code only
 * ever travels in a header and the full file never sits in app memory.
 */
export async function renderDocumentCover(
  documentId: string,
  signal: AbortSignal,
): Promise<Blob> {
  signal.throwIfAborted();
  const token = accessToken();
  if (!token) {
    throw new PagePreparationError(
      "LOCAL_ACCESS_REQUIRED",
      "missing access code; open the link printed in the terminal",
    );
  }
  const pdfjs = await loadPdfjsRuntime();
  signal.throwIfAborted();
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/build/pdf.worker.mjs";

  const task = pdfjs.getDocument({
    url: `${location.origin}/api/documents/${encodeURIComponent(documentId)}/file`,
    httpHeaders: { Authorization: `Bearer ${token}` },
    disableRange: true,
    disableStream: true,
    withCredentials: false,
    cMapUrl: "/pdfjs/web/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/web/standard_fonts/",
    wasmUrl: "/pdfjs/web/wasm/",
    iccUrl: "/pdfjs/web/iccs/",
  });

  let destroyed = false;
  const destroy = async (): Promise<void> => {
    if (destroyed) return;
    destroyed = true;
    await task.destroy().catch(() => {});
  };
  const onAbort = (): void => {
    void destroy();
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    const pdf = await task.promise;
    signal.throwIfAborted();
    const page = await pdf.getPage(1);
    try {
      signal.throwIfAborted();
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(
        1,
        COVER_LONG_EDGE / Math.max(base.width, base.height),
      );
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) {
        throw new PagePreparationError(
          "COVER_RENDER_FAILED",
          "the browser could not create a canvas",
        );
      }

      const renderTask = page.render({
        canvas,
        viewport,
        background: "#ffffff",
      });
      const cancelRender = (): void => renderTask.cancel();
      signal.addEventListener("abort", cancelRender, { once: true });
      try {
        await renderTask.promise;
        signal.throwIfAborted();
        const encoded = Promise.withResolvers<Blob | null>();
        canvas.toBlob(encoded.resolve, "image/jpeg", 0.85);
        const blob = await encoded.promise;
        if (!blob) {
          throw new PagePreparationError(
            "COVER_RENDER_FAILED",
            "the browser could not encode the cover",
          );
        }
        return blob;
      } catch (error) {
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
        if (error instanceof PagePreparationError) throw error;
        throw new PagePreparationError(
          "COVER_RENDER_FAILED",
          error instanceof Error ? error.message : "the cover could not be rendered",
        );
      } finally {
        signal.removeEventListener("abort", cancelRender);
        canvas.width = 0;
        canvas.height = 0;
      }
    } finally {
      page.cleanup();
    }
  } catch (error) {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    if (error instanceof PagePreparationError) throw error;
    throw new PagePreparationError(
      "COVER_RENDER_FAILED",
      error instanceof Error ? error.message : "the cover could not be rendered",
    );
  } finally {
    signal.removeEventListener("abort", onAbort);
    await destroy();
  }
}
