import { timingSafeEqual } from "node:crypto";
import type { z } from "zod";
import { ZodError } from "zod";
import type { ApiErrorBody } from "../shared/contracts";
import { AiError } from "./ai";
import { CredentialStorageError, StorageBusyError } from "./ai-credentials";
import { AiConfigError, AiProviderNotFoundError } from "./ai-settings";
import {
  DocumentNotFoundError,
  PageOutOfRangeError,
  StoredAiConfigError,
} from "./storage";

export interface GateConfig {
  token: string;
  /** Origin derived from Bun's actual server.url, never from the request. */
  origin: string;
  /** Host derived from Bun's actual server.url, never from the request. */
  host: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function errorBody(code: string, message: string): ApiErrorBody {
  return { error: { code, message } };
}

export function jsonResponse(value: unknown, status = 200): Response {
  const response = new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
  applyDataHeaders(response);
  return response;
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return jsonResponse(errorBody(code, message), status);
}

export function applyDataHeaders(response: Response): void {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Cross-Origin-Resource-Policy", "same-origin");
}

function timingSafeEqualString(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

/**
 * Rejects requests this local tool did not originate itself.
 * Returns a response to send, or null when the request passes.
 */
export function guardRequest(request: Request, gate: GateConfig): Response | null {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const origin = request.headers.get("origin");

  if (request.headers.get("host") !== gate.host) {
    return errorResponse(403, "FORBIDDEN", "request host is not this server");
  }
  if (url.origin !== gate.origin) {
    return errorResponse(403, "FORBIDDEN", "request origin is not this server");
  }
  if (origin !== null && origin !== gate.origin) {
    return errorResponse(403, "FORBIDDEN", "cross-origin request rejected");
  }
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return errorResponse(403, "FORBIDDEN", "cross-site request rejected");
  }
  if (method === "OPTIONS") {
    return errorResponse(403, "FORBIDDEN", "cross-origin preflight is not supported");
  }
  if (method !== "GET" && method !== "HEAD" && origin === null) {
    return errorResponse(403, "FORBIDDEN", "write requests must come from the app page");
  }

  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return errorResponse(401, "LOCAL_ACCESS_REQUIRED", "open the link printed by the server");
  }
  if (!timingSafeEqualString(authorization.slice("Bearer ".length), gate.token)) {
    return errorResponse(401, "LOCAL_ACCESS_REQUIRED", "access code is invalid or expired");
  }

  return null;
}

export function assertContentEncoding(request: Request): void {
  const encoding = request.headers.get("content-encoding");
  if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
    throw new HttpError(400, "INVALID_REQUEST", "compressed request bodies are not accepted");
  }
}

function mediaType(request: Request): string {
  return (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
}

export function assertJsonContentType(request: Request): void {
  if (mediaType(request) !== "application/json") {
    throw new HttpError(400, "INVALID_REQUEST", "Content-Type must be application/json");
  }
}

export function assertPdfContentType(request: Request): void {
  if (mediaType(request) !== "application/pdf") {
    throw new HttpError(400, "INVALID_REQUEST", "Content-Type must be application/pdf");
  }
}

/** Reads a request body with a hard byte cap, stopping as soon as the cap is exceeded. */
export async function readBody(request: Request, limit: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const parsed = Number(declared);
    if (Number.isFinite(parsed) && parsed > limit) {
      throw new HttpError(
        413,
        "PAYLOAD_TOO_LARGE",
        `request body exceeds ${limit} bytes`,
      );
    }
  }
  if (!request.body) {
    throw new HttpError(400, "INVALID_REQUEST", "request body is required");
  }

  const reader = request.body.getReader();
  const sink = new Bun.ArrayBufferSink();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new HttpError(
          413,
          "PAYLOAD_TOO_LARGE",
          `request body exceeds ${limit} bytes`,
        );
      }
      sink.write(value);
    }
  } finally {
    reader.releaseLock();
  }

  return new Uint8Array(sink.end() as ArrayBuffer);
}

export function parseJson<T>(bytes: Uint8Array, schema: z.ZodType<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "INVALID_REQUEST", "request body is not valid JSON");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(400, "INVALID_REQUEST", describeZodError(parsed.error));
  }
  return parsed.data;
}

export async function readJson<T>(
  request: Request,
  limit: number,
  schema: z.ZodType<T>,
): Promise<T> {
  assertContentEncoding(request);
  assertJsonContentType(request);
  return parseJson(await readBody(request, limit), schema);
}

export function describeZodError(error: ZodError): string {
  const first = error.issues[0];
  if (!first) return "request does not match the expected shape";
  const path = first.path.length > 0 ? `${first.path.join(".")}: ` : "";
  return `${path}${first.message}`;
}

const SQLITE_ERROR_MAP: Record<string, { status: number; code: string }> = {
  SQLITE_BUSY: { status: 503, code: "STORAGE_BUSY" },
  SQLITE_LOCKED: { status: 503, code: "STORAGE_BUSY" },
  SQLITE_FULL: { status: 507, code: "STORAGE_FULL" },
};

export interface ClassifiedError {
  status: number;
  code: string;
  message: string;
}

export function classifyError(error: unknown): ClassifiedError {
  if (error instanceof HttpError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof ZodError) {
    return { status: 400, code: "INVALID_REQUEST", message: describeZodError(error) };
  }
  if (error instanceof DocumentNotFoundError) {
    return { status: 404, code: "DOCUMENT_NOT_FOUND", message: "document does not exist" };
  }
  if (error instanceof PageOutOfRangeError) {
    return {
      status: 400,
      code: "INVALID_REQUEST",
      message: "page number is outside the document",
    };
  }
  if (error instanceof AiConfigError) {
    return { status: 400, code: "INVALID_REQUEST", message: error.message };
  }
  if (error instanceof AiProviderNotFoundError) {
    return { status: 404, code: "AI_PROVIDER_NOT_FOUND", message: error.message };
  }
  if (error instanceof AiError) {
    switch (error.code) {
      case "AI_AUTH_FAILED":
        return { status: 503, code: error.code, message: error.message };
      case "AI_NOT_CONFIGURED":
      case "AI_MODEL_UNSUPPORTED":
        return { status: 503, code: error.code, message: error.message };
      case "AI_REQUEST_FAILED":
      case "INVALID_AI_OUTPUT":
        return { status: 502, code: error.code, message: error.message };
      case "AI_CONFIG_INVALID":
        return { status: 500, code: error.code, message: error.message };
    }
  }
  if (error instanceof StorageBusyError) {
    return { status: 503, code: "STORAGE_BUSY", message: error.message };
  }
  if (error instanceof CredentialStorageError) {
    return { status: 500, code: "STORAGE_ERROR", message: "AI credential storage failed" };
  }
  if (error instanceof StoredAiConfigError) {
    return { status: 500, code: "AI_CONFIG_INVALID", message: error.message };
  }

  if (error instanceof Error) {
    switch (error.name) {
      case "AiLoginBusyError":
        return {
          status: 409,
          code: "AI_LOGIN_BUSY",
          message: "another AI sign-in is already in progress",
        };
      case "AiLoginNotFoundError":
        return {
          status: 404,
          code: "AI_LOGIN_NOT_FOUND",
          message: "AI sign-in session does not exist",
        };
      case "AiLoginStalePromptError":
        return {
          status: 409,
          code: "AI_LOGIN_STALE_PROMPT",
          message: "this AI sign-in prompt is no longer active",
        };
      case "AiLoginValueError":
        return { status: 400, code: "INVALID_REQUEST", message: error.message };
    }
  }

  const sqliteCode = (error as { code?: unknown } | null)?.code;
  if (typeof sqliteCode === "string") {
    const mapped = SQLITE_ERROR_MAP[sqliteCode];
    if (mapped) {
      return {
        status: mapped.status,
        code: mapped.code,
        message:
          mapped.code === "STORAGE_BUSY"
            ? "the database is busy; retry shortly"
            : "the disk is full",
      };
    }
    if (sqliteCode.startsWith("SQLITE_")) {
      return {
        status: 500,
        code: "STORAGE_ERROR",
        message: "database read or write failed",
      };
    }
  }

  console.error("unhandled request error:", error);
  return { status: 500, code: "STORAGE_ERROR", message: "internal error" };
}

export function httpErrorFromUnknown(error: unknown): Response {
  const classified = classifyError(error);
  return errorResponse(classified.status, classified.code, classified.message);
}

/** RFC 5987/6266 Content-Disposition with an ASCII fallback. */
export function contentDispositionInline(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
