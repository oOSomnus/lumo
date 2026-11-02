import { z } from "zod";
import type { Database } from "bun:sqlite";
import {
  DOCUMENT_UPLOAD_QUERY_SCHEMA,
  documentIdSchema,
  pageNumberSchema,
  readerUpdateSchema,
  readerViewSchema,
  targetLanguageSchema,
  translationContentSchema,
  type LibrarySnapshot,
  type TargetLanguage,
} from "../shared/contracts";
import {
  applyDataHeaders,
  assertContentEncoding,
  assertPdfContentType,
  contentDispositionInline,
  HttpError,
  jsonResponse,
  readBody,
  readJson,
} from "./http";
import {
  getDocument,
  getDocumentFile,
  getReaderView,
  getSettings,
  getTranslation,
  getUiLocale,
  listDocuments,
  listTranslatedPages,
  listTranslations,
  removeDocument,
  saveReaderView,
  saveTranslation,
  storeDocument,
  updateReaderSettings,
} from "./storage";

export const MAX_PDF_BYTES = 100 * 1024 * 1024;
const MAX_TRANSLATION_BYTES = 1024 * 1024;
const MAX_READER_BYTES = 64 * 1024;
const MAX_READER_VIEW_BYTES = 1024;

const languageQuerySchema = z.strictObject({
  targetLanguage: targetLanguageSchema,
});

const translationLocationSchema = z.strictObject({
  documentId: documentIdSchema,
  pageNumber: pageNumberSchema,
  targetLanguage: targetLanguageSchema,
});

function notFound(): never {
  throw new HttpError(404, "DOCUMENT_NOT_FOUND", "document does not exist");
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, "INVALID_REQUEST", "path contains invalid encoding");
  }
}

function hasPdfMagic(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, Math.min(bytes.byteLength, 1024));
  const marker = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
  outer: for (let i = 0; i <= window.byteLength - marker.length; i++) {
    for (let j = 0; j < marker.length; j++) {
      if (window[i + j] !== marker[j]) continue outer;
    }
    return true;
  }
  return false;
}

function pdfResponse(bytes: Uint8Array, name: string): Response {
  // Bun serves typed arrays directly; TypeScript's DOM BodyInit omits
  // Uint8Array<ArrayBufferLike>, so keep the buffer without copying.
  const body = bytes as unknown as BodyInit;
  const response = new Response(body, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": contentDispositionInline(name),
    },
  });
  applyDataHeaders(response);
  return response;
}

function parseDocumentPath(segments: string[]): string {
  const documentId = safeDecode(segments[2] ?? "");
  if (!documentIdSchema.safeParse(documentId).success) {
    throw new HttpError(400, "INVALID_REQUEST", "invalid document id");
  }
  return documentId;
}

function parseTranslationPath(
  segments: string[],
): {
  documentId: string;
  pageNumber: number;
  targetLanguage: TargetLanguage;
} {
  const parsed = translationLocationSchema.safeParse({
    documentId: safeDecode(segments[2] ?? ""),
    pageNumber: Number(safeDecode(segments[4] ?? "")),
    targetLanguage: safeDecode(segments[5] ?? ""),
  });
  if (!parsed.success) {
    throw new HttpError(400, "INVALID_REQUEST", "invalid translation location");
  }
  return parsed.data;
}

export async function handleLibrary(
  request: Request,
  url: URL,
  ctx: { db: Database; dataDirectory: string },
): Promise<Response> {
  const segments = url.pathname.split("/").filter(Boolean);
  const method = request.method.toUpperCase();

  if (url.pathname === "/api/library") {
    if (method !== "GET") {
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "method not allowed");
    }
    const snapshot: LibrarySnapshot = {
      documents: listDocuments(ctx.db),
      settings: getSettings(ctx.db),
      dataDirectory: ctx.dataDirectory,
      uiLocale: getUiLocale(ctx.db),
    };
    return jsonResponse(snapshot);
  }

  if (url.pathname === "/api/reader") {
    if (method !== "PATCH") {
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "method not allowed");
    }
    const update = await readJson(request, MAX_READER_BYTES, readerUpdateSchema);
    return jsonResponse(updateReaderSettings(ctx.db, update));
  }

  if (url.pathname === "/api/documents") {
    if (method !== "POST") {
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "method not allowed");
    }
    const query = DOCUMENT_UPLOAD_QUERY_SCHEMA.safeParse(
      Object.fromEntries(url.searchParams.entries()),
    );
    if (!query.success) {
      throw new HttpError(400, "INVALID_REQUEST", "invalid upload query");
    }
    assertContentEncoding(request);
    assertPdfContentType(request);
    const bytes = await readBody(request, MAX_PDF_BYTES);
    if (bytes.byteLength === 0) {
      throw new HttpError(400, "INVALID_REQUEST", "PDF file is empty");
    }
    if (!hasPdfMagic(bytes)) {
      throw new HttpError(400, "INVALID_REQUEST", "file is not a PDF");
    }
    const document = storeDocument(ctx.db, query.data, bytes);
    return jsonResponse(document);
  }

  if (segments[0] !== "api" || segments[1] !== "documents" || !segments[2]) {
    throw new HttpError(404, "NOT_FOUND", "unknown API route");
  }
  const documentId = parseDocumentPath(segments);

  if (segments.length === 3 && url.pathname.startsWith("/api/documents/")) {
    if (method === "DELETE") {
      if (!removeDocument(ctx.db, documentId)) notFound();
      const response = new Response(null, { status: 204 });
      applyDataHeaders(response);
      return response;
    }
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "method not allowed");
  }

  if (segments.length === 4 && segments[3] === "view") {
    if (method === "GET") {
      return jsonResponse({
        view: getReaderView(ctx.db, documentId),
      });
    }
    if (method === "PUT") {
      const view = await readJson(
        request,
        MAX_READER_VIEW_BYTES,
        readerViewSchema,
      );
      return jsonResponse({
        view: saveReaderView(ctx.db, documentId, view),
      });
    }
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "method not allowed");
  }

  if (segments.length === 4 && segments[3] === "file") {
    if (method !== "GET") {
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "method not allowed");
    }
    const file = getDocumentFile(ctx.db, documentId);
    if (!file) notFound();
    return pdfResponse(file.data, file.name);
  }

  if (segments.length === 4 && segments[3] === "translation-pages") {
    if (method !== "GET") {
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "method not allowed");
    }
    if (!getDocument(ctx.db, documentId)) notFound();
    const query = languageQuerySchema.safeParse(
      Object.fromEntries(url.searchParams.entries()),
    );
    if (!query.success) {
      throw new HttpError(400, "INVALID_REQUEST", "targetLanguage is required");
    }
    return jsonResponse({
      pages: listTranslatedPages(ctx.db, documentId, query.data.targetLanguage),
    });
  }

  if (segments.length === 4 && segments[3] === "translations") {
    if (method !== "GET") {
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "method not allowed");
    }
    if (!getDocument(ctx.db, documentId)) notFound();
    const query = languageQuerySchema.safeParse(
      Object.fromEntries(url.searchParams.entries()),
    );
    if (!query.success) {
      throw new HttpError(400, "INVALID_REQUEST", "targetLanguage is required");
    }
    return jsonResponse(
      listTranslations(ctx.db, documentId, query.data.targetLanguage),
    );
  }

  if (segments.length === 6 && segments[3] === "translations") {
    const location = parseTranslationPath(segments);
    if (method === "GET") {
      if (!getDocument(ctx.db, documentId)) notFound();
      return jsonResponse(getTranslation(ctx.db, location));
    }
    if (method === "PUT") {
      const content = await readJson(
        request,
        MAX_TRANSLATION_BYTES,
        translationContentSchema,
      );
      const record = saveTranslation(ctx.db, location, content);
      return jsonResponse(record);
    }
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "method not allowed");
  }

  throw new HttpError(404, "NOT_FOUND", "unknown API route");
}
