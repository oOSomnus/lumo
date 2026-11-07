import { z } from "zod";
import type { Database } from "bun:sqlite";
import {
  DOCUMENT_UPLOAD_QUERY_SCHEMA,
  MAX_EPUB_CFI_CHARS,
  documentIdSchema,
  outlineEntriesSchema,
  pageNumberSchema,
  readerUpdateSchema,
  readerViewSchema,
  targetLanguageSchema,
  translationUnitSchema,
  translationSaveInputSchema,
  type LibrarySnapshot,
  type TargetLanguage,
} from "../shared/contracts";
import { isEpubUnitOf } from "../shared/epub";
import {
  applyDataHeaders,
  assertContentEncoding,
  assertDocumentContentType,
  contentDispositionInline,
  HttpError,
  jsonResponse,
  readJson,
} from "./http";
import { EpubPackageError, readEpubSpineCount } from "./epub";
import {
  getDocument,
  getDocumentFile,
  getGeneratedOutline,
  getReaderView,
  getSettings,
  getTranslation,
  getUiLocale,
  listDocuments,
  listTranslationLocations,
  listTranslations,
  removeDocument,
  saveGeneratedOutline,
  saveReaderView,
  saveTranslation,
  storeDocument,
  updateReaderSettings,
} from "./storage";

const MAX_TRANSLATION_BYTES = 1024 * 1024;
const MAX_READER_BYTES = 64 * 1024;
// A CFI is up to MAX_EPUB_CFI_CHARS characters of up to 4 UTF-8 bytes each.
const MAX_READER_VIEW_BYTES = MAX_EPUB_CFI_CHARS * 4 + 2048;
const MAX_OUTLINE_BYTES = 32 * 1024 * 1024;

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

function hasEpubMagic(bytes: Uint8Array): boolean {
  if (
    bytes.byteLength < 30 ||
    bytes[0] !== 0x50 ||
    bytes[1] !== 0x4b ||
    bytes[2] !== 0x03 ||
    bytes[3] !== 0x04
  ) {
    return false;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const method = view.getUint16(8, true);
  const compressedSize = view.getUint32(18, true);
  const uncompressedSize = view.getUint32(22, true);
  const nameLength = view.getUint16(26, true);
  const extraLength = view.getUint16(28, true);
  if (method !== 0 || compressedSize !== uncompressedSize) return false;
  const nameStart = 30;
  const dataStart = nameStart + nameLength + extraLength;
  if (dataStart + uncompressedSize > bytes.byteLength) return false;
  const name = new TextDecoder().decode(
    bytes.subarray(nameStart, nameStart + nameLength),
  );
  if (name !== "mimetype") return false;
  const content = new TextDecoder().decode(
    bytes.subarray(dataStart, dataStart + uncompressedSize),
  );
  return content === "application/epub+zip";
}

function documentResponse(
  bytes: Uint8Array,
  name: string,
  format: "pdf" | "epub",
): Response {
  // Bun serves typed arrays directly; TypeScript's DOM BodyInit omits
  // Uint8Array<ArrayBufferLike>, so keep the buffer without copying.
  const body = bytes as unknown as BodyInit;
  const response = new Response(body, {
    headers: {
      "Content-Type":
        format === "pdf" ? "application/pdf" : "application/epub+zip",
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

function translationUnit(url: URL): string {
  const parsed = translationUnitSchema.safeParse(url.searchParams.get("unit") ?? "");
  if (!parsed.success) {
    throw new HttpError(400, "INVALID_REQUEST", "invalid translation unit");
  }
  return parsed.data;
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
    const format = query.data.format;
    assertDocumentContentType(request, format);
    const bytes = await request.bytes();
    if (bytes.byteLength === 0) {
      throw new HttpError(
        400,
        "INVALID_REQUEST",
        format === "pdf" ? "PDF file is empty" : "EPUB file is empty",
      );
    }
    if (format === "pdf" ? !hasPdfMagic(bytes) : !hasEpubMagic(bytes)) {
      throw new HttpError(
        400,
        "INVALID_REQUEST",
        format === "pdf" ? "file is not a PDF" : "file is not an EPUB",
      );
    }
    let pageCount = query.data.pageCount;
    if (format === "epub") {
      try {
        pageCount = await readEpubSpineCount(bytes);
      } catch (error) {
        if (error instanceof EpubPackageError) {
          throw new HttpError(400, "INVALID_REQUEST", error.message);
        }
        throw error;
      }
    }
    if (!pageCount) {
      throw new HttpError(400, "INVALID_REQUEST", "pageCount is required");
    }
    const document = storeDocument(
      ctx.db,
      { name: query.data.name, pageCount, format },
      bytes,
    );
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

  if (segments.length === 4 && segments[3] === "outline") {
    const document = getDocument(ctx.db, documentId);
    if (!document) notFound();
    if (document.format !== "pdf") {
      throw new HttpError(
        400,
        "INVALID_REQUEST",
        "outlines are only available for PDF documents",
      );
    }
    if (method === "GET") {
      return jsonResponse({
        outline: getGeneratedOutline(ctx.db, documentId),
      });
    }
    if (method === "PUT") {
      const entries = await readJson(
        request,
        MAX_OUTLINE_BYTES,
        outlineEntriesSchema,
      );
      return jsonResponse({
        outline: saveGeneratedOutline(ctx.db, documentId, entries),
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
    return documentResponse(file.data, file.name, file.format);
  }

  if (segments.length === 4 && segments[3] === "translation-locations") {
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
      locations: listTranslationLocations(
        ctx.db,
        documentId,
        query.data.targetLanguage,
      ),
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
    const location = {
      ...parseTranslationPath(segments),
      unit: translationUnit(url),
    };
    if (method === "GET") {
      if (!getDocument(ctx.db, documentId)) notFound();
      return jsonResponse(getTranslation(ctx.db, location));
    }
    if (method === "PUT") {
      const content = await readJson(
        request,
        MAX_TRANSLATION_BYTES,
        translationSaveInputSchema,
      );
      const document = getDocument(ctx.db, documentId);
      if (!document) notFound();
      const { sourceCfi } = content;
      const identified =
        document.format === "epub"
          ? sourceCfi !== undefined &&
            (await isEpubUnitOf(location.unit, sourceCfi))
          : sourceCfi === undefined;
      if (!identified) {
        throw new HttpError(400, "INVALID_REQUEST", "invalid translation location");
      }
      return jsonResponse(
        saveTranslation(ctx.db, { ...location, sourceCfi }, content),
      );
    }
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "method not allowed");
  }

  throw new HttpError(404, "NOT_FOUND", "unknown API route");
}
