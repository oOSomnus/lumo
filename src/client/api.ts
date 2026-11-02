import type { z } from "zod";
import {
  aiLoginEventSchema,
  translateStreamEventSchema,
  type AiCatalog,
  type AiConfig,
  type AiCredentialKind,
  type AiLoginEvent,
  type AiSettingsSnapshot,
  type TranslatePageInput,
  type TranslationContent,
  type TranslationRecord,
  type UiLocale,
} from "../shared/contracts";

const MAX_STREAM_LINE_BYTES = 2 * 1024 * 1024;

let cachedToken: string | null | undefined;

export function accessToken(): string | null {
  if (cachedToken === undefined) {
    cachedToken =
      typeof window === "undefined"
        ? null
        : new URLSearchParams(window.location.search).get("token");
  }
  return cachedToken;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function isTerminalLoginEvent(event: AiLoginEvent): boolean {
  return event.type === "done" || event.type === "error" || event.type === "cancelled";
}

export class TranslationStreamError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly draft?: TranslationContent,
  ) {
    super(message);
    this.name = "TranslationStreamError";
  }
}

async function errorFromResponse(response: Response): Promise<ApiError> {
  let code = "HTTP_ERROR";
  let message = `request failed with HTTP ${response.status}`;
  try {
    const body = (await response.json()) as {
      error?: { code?: unknown; message?: unknown };
    };
    if (typeof body.error?.code === "string") code = body.error.code;
    if (typeof body.error?.message === "string") message = body.error.message;
  } catch {
    // Non-JSON error body; keep the HTTP status message.
  }
  return new ApiError(code, response.status, message);
}

export async function apiFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = accessToken();
  if (!token) {
    throw new ApiError(
      "LOCAL_ACCESS_REQUIRED",
      401,
      "missing access code; open the link printed in the terminal",
    );
  }
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "omit",
    cache: "no-store",
  });
  if (!response.ok) {
    throw await errorFromResponse(response);
  }
  return response;
}

export async function apiJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await apiFetch(path, init);
  return (await response.json()) as T;
}

export function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** Parses UTF-8 NDJSON delivered in arbitrary network chunks. */
export async function readNdjson<T>(
  response: Response,
  schema: z.ZodType<T>,
  onEvent: (event: T) => void,
): Promise<void> {
  if (!response.body) {
    throw new ApiError("INVALID_RESPONSE", 502, "response has no body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const handleLine = (line: string): void => {
    if (line.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new ApiError("INVALID_RESPONSE", 502, "stream contains invalid JSON");
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new ApiError("INVALID_RESPONSE", 502, "stream contains an unknown event");
    }
    onEvent(parsed.data);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        if (line.length > MAX_STREAM_LINE_BYTES) {
          await reader.cancel().catch(() => {});
          throw new ApiError("INVALID_RESPONSE", 502, "stream line exceeds 2 MiB");
        }
        buffer = buffer.slice(newline + 1);
        handleLine(line);
      }
      if (buffer.length > MAX_STREAM_LINE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new ApiError("INVALID_RESPONSE", 502, "stream line exceeds 2 MiB");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== "") handleLine(buffer);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export interface TranslationStreamResult {
  translation: TranslationRecord;
  cacheHit: boolean;
}

export async function requestTranslation(
  input: TranslatePageInput,
  options: {
    signal?: AbortSignal;
    onDelta?: (chunk: { contentIndex: number; text: string }) => void;
    onSaving?: () => void;
  } = {},
): Promise<TranslationStreamResult> {
  const response = await apiFetch("/api/translate", {
    ...jsonInit("POST", input),
    signal: options.signal,
  });

  let result: TranslationStreamResult | undefined;
  let failure: TranslationStreamError | undefined;
  let terminalSeen = false;

  await readNdjson(response, translateStreamEventSchema, (event) => {
    if (terminalSeen) return;
    switch (event.type) {
      case "delta":
        options.onDelta?.({ contentIndex: event.contentIndex, text: event.text });
        break;
      case "saving":
        options.onSaving?.();
        break;
      case "done":
        terminalSeen = true;
        result = {
          translation: event.translation,
          cacheHit: event.cacheHit,
        };
        break;
      case "error":
        terminalSeen = true;
        failure = new TranslationStreamError(
          event.error.code,
          event.error.message,
          event.draft,
        );
        break;
      case "start":
        break;
    }
  });

  if (failure) throw failure;
  if (!result) {
    throw new TranslationStreamError(
      "STREAM_INTERRUPTED",
      "connection ended before a terminal translation event",
    );
  }
  return result;
}

export async function fetchTranslation(
  documentId: string,
  pageNumber: number,
  targetLanguage: string,
  signal?: AbortSignal,
): Promise<TranslationRecord | null> {
  return apiJson(
    `/api/documents/${documentId}/translations/${pageNumber}/${targetLanguage}`,
    { signal },
  );
}

export async function saveTranslationRecord(
  documentId: string,
  pageNumber: number,
  targetLanguage: string,
  content: TranslationContent,
  signal?: AbortSignal,
): Promise<TranslationRecord> {
  return apiJson(
    `/api/documents/${documentId}/translations/${pageNumber}/${targetLanguage}`,
    { ...jsonInit("PUT", content), signal },
  );
}

export async function startAiLogin(
  provider: string,
  type: AiCredentialKind,
  options: {
    signal?: AbortSignal;
    onEvent: (event: AiLoginEvent) => void;
  },
): Promise<void> {
  const response = await apiFetch("/api/ai/login", {
    ...jsonInit("POST", { provider, type }),
    signal: options.signal,
  });
  await readNdjson(response, aiLoginEventSchema, options.onEvent);
}

export async function answerAiLogin(
  sessionId: string,
  promptId: string,
  value: string,
): Promise<void> {
  await apiFetch(
    `/api/ai/login/${encodeURIComponent(sessionId)}/answer`,
    jsonInit("POST", { promptId, value }),
  );
}

export async function cancelAiLogin(sessionId: string): Promise<void> {
  await apiFetch(`/api/ai/login/${encodeURIComponent(sessionId)}/cancel`, {
    method: "POST",
  });
}

export async function removeAiCredential(provider: string): Promise<void> {
  await apiFetch(`/api/ai/credentials/${encodeURIComponent(provider)}`, {
    method: "DELETE",
  });
}

export function fetchAiSettings(signal?: AbortSignal): Promise<AiSettingsSnapshot> {
  return apiJson("/api/ai/settings", { signal });
}

export function saveAiSettings(
  config: AiConfig,
  signal?: AbortSignal,
): Promise<AiSettingsSnapshot> {
  return apiJson("/api/ai/settings", { ...jsonInit("PUT", config), signal });
}

export function fetchAiCatalog(
  provider?: string,
  signal?: AbortSignal,
): Promise<AiCatalog> {
  const query = provider ? `?provider=${encodeURIComponent(provider)}` : "";
  return apiJson(`/api/ai/catalog${query}`, { signal });
}

export function refreshAiCatalog(
  provider: string,
  signal?: AbortSignal,
): Promise<AiCatalog> {
  return apiJson("/api/ai/catalog/refresh", {
    ...jsonInit("POST", { provider }),
    signal,
  });
}

export function saveUiLocale(locale: UiLocale): Promise<{ uiLocale: UiLocale }> {
  return apiJson("/api/settings", jsonInit("PATCH", { uiLocale: locale }));
}

export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
