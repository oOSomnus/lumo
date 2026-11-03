import type { Database } from "bun:sqlite";
import { outlinePageInputSchema } from "../shared/contracts";
import type { AiManager } from "./ai-settings";
import { HttpError, jsonResponse, readJson } from "./http";
import { getDocument } from "./storage";

export const MAX_OUTLINE_PAGE_BODY_BYTES = 8 * 1024 * 1024;
export const OUTLINE_PAGE_TIMEOUT_MS = 120_000;

export async function handleOutlinePage(
  request: Request,
  ctx: { db: Database; ai: Pick<AiManager, "getRuntime"> },
  timeoutMs = OUTLINE_PAGE_TIMEOUT_MS,
): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "method not allowed");
  }
  const input = await readJson(
    request,
    MAX_OUTLINE_PAGE_BODY_BYTES,
    outlinePageInputSchema,
  );

  const document = getDocument(ctx.db, input.documentId);
  if (!document) {
    throw new HttpError(404, "DOCUMENT_NOT_FOUND", "document does not exist");
  }
  if (input.pageNumber > document.pageCount) {
    throw new HttpError(400, "INVALID_REQUEST", "page number is outside the document");
  }

  const runtime = await ctx.ai.getRuntime();
  const configured = await runtime.checkConfigured();
  if (!configured.ok) {
    throw new HttpError(503, configured.code, configured.message);
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("outline generation timed out"));
  }, timeoutMs);

  const abortFromRequest = () => controller.abort(request.signal.reason);
  if (request.signal.aborted) controller.abort(request.signal.reason);
  else request.signal.addEventListener("abort", abortFromRequest, { once: true });

  try {
    const headings = await runtime.extractOutlinePage(input, controller.signal);
    controller.signal.throwIfAborted();
    return jsonResponse({ headings });
  } catch (error) {
    if (timedOut) {
      throw new HttpError(
        504,
        "AI_TIMEOUT",
        `outline generation timed out after ${Math.round(timeoutMs / 1000)} seconds`,
      );
    }
    if (request.signal.aborted) {
      throw new HttpError(499, "ABORTED", "request was aborted");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", abortFromRequest);
  }
}
