import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { MAX_IMAGE_BASE64_CHARS, MAX_PAGE_TEXT_CHARS } from "../shared/contracts";

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
