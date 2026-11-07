import type { Database } from "bun:sqlite";
import {
  translatePageInputSchema,
  type TranslatePageInput,
  type TranslateStreamEvent,
  type TranslationContent,
} from "../shared/contracts";
import { isEpubUnitOf } from "../shared/epub";
import type { AiRuntime } from "./ai";
import type { AiManager } from "./ai-settings";
import {
  applyDataHeaders,
  classifyError,
  HttpError,
  readJson,
} from "./http";
import { getDocument, getTranslation } from "./storage";

export const MAX_TRANSLATE_BODY_BYTES = 8 * 1024 * 1024;
export const TRANSLATE_TIMEOUT_MS = 120_000;

const encoder = new TextEncoder();

function ndjsonResponse(
  body: ReadableStream<Uint8Array>,
): Response {
  const response = new Response(body, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
  });
  applyDataHeaders(response);
  return response;
}

function oneLineStream(event: TranslateStreamEvent): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      controller.close();
    },
  });
}

function aiEventError(error: unknown, timedOut: boolean): {
  code: string;
  message: string;
} {
  if (timedOut) {
    return { code: "AI_TIMEOUT", message: "translation timed out after 120 seconds" };
  }
  const classified = classifyError(error);
  return { code: classified.code, message: classified.message };
}

export function createGenerationStream(
  input: TranslatePageInput,
  ai: AiRuntime,
  request: Request,
): ReadableStream<Uint8Array> {
  const abortController = new AbortController();
  let timedOut = false;
  let closed = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    abortController.abort(new Error("translation timed out"));
  }, TRANSLATE_TIMEOUT_MS);

  const abortFromRequest = () => abortController.abort(request.signal.reason);
  if (request.signal.aborted) abortController.abort(request.signal.reason);
  else request.signal.addEventListener("abort", abortFromRequest, { once: true });

  const cleanup = () => {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", abortFromRequest);
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: TranslateStreamEvent): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          return true;
        } catch {
          closed = true;
          abortController.abort(new Error("client disconnected"));
          return false;
        }
      };

      const finish = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Stream already errored or was cancelled.
        }
        cleanup();
      };

      void (async () => {
        emit({ type: "start" });
        try {
          const content: TranslationContent = await ai.translatePage(
            input,
            abortController.signal,
            ({ contentIndex, delta }) => {
              emit({ type: "delta", contentIndex, text: delta });
            },
            (progress) => {
              if (!abortController.signal.aborted) {
                emit({ type: "repair", progress });
              }
            },
          );

          if (abortController.signal.aborted) {
            emit({
              type: "error",
              error: aiEventError(abortController.signal.reason, timedOut),
            });
            finish();
            return;
          }

          emit({ type: "generated", content });
          finish();
        } catch (error) {
          if (closed) {
            finish();
            return;
          }
          if (request.signal.aborted) {
            finish();
            return;
          }
          emit({ type: "error", error: aiEventError(error, timedOut) });
          finish();
        }
      })();
    },
    cancel() {
      closed = true;
      abortController.abort(new Error("client disconnected"));
      cleanup();
    },
  });
}

export async function handleTranslate(
  request: Request,
  ctx: { db: Database; ai: Pick<AiManager, "getRuntime"> },
): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "method not allowed");
  }
  const input = await readJson(
    request,
    MAX_TRANSLATE_BODY_BYTES,
    translatePageInputSchema,
  );

  const document = getDocument(ctx.db, input.documentId);
  if (!document) {
    throw new HttpError(404, "DOCUMENT_NOT_FOUND", "document does not exist");
  }
  if (document.format !== input.format) {
    throw new HttpError(
      400,
      "INVALID_REQUEST",
      "translation input format does not match the document",
    );
  }
  if (input.pageNumber > document.pageCount) {
    throw new HttpError(400, "INVALID_REQUEST", "page number is outside the document");
  }
  if (
    input.format === "epub" &&
    !(await isEpubUnitOf(input.unit, input.sourceCfi))
  ) {
    throw new HttpError(400, "INVALID_REQUEST", "invalid translation location");
  }

  if (!input.force && !("repair" in input)) {
    const cached = getTranslation(ctx.db, input);
    if (cached) {
      return ndjsonResponse(
        oneLineStream({ type: "cached", translation: cached }),
      );
    }
  }

  const runtime = await ctx.ai.getRuntime();
  const configured = await runtime.checkConfigured();
  if (!configured.ok) {
    throw new HttpError(503, configured.code, configured.message);
  }

  return ndjsonResponse(createGenerationStream(input, runtime, request));
}
