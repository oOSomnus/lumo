import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  aiConfigSchema,
  MAX_AI_PROVIDER_CHARS,
  uiLocaleSchema,
  type AiCatalog,
  type AiSettingsSnapshot,
  type UiLocale,
} from "../shared/contracts";
import type { AiManager } from "./ai-settings";
import { HttpError, jsonResponse, readJson } from "./http";
import { saveUiLocale } from "./storage";

const MAX_LOCALE_BYTES = 1024;
const MAX_AI_SETTINGS_BYTES = 16 * 1024;
const MAX_CATALOG_REFRESH_BYTES = 16 * 1024;

const localeBodySchema = z.strictObject({ uiLocale: uiLocaleSchema });
const providerBodySchema = z.strictObject({
  provider: z.string().min(1).max(MAX_AI_PROVIDER_CHARS),
});
const providerQuerySchema = z.string().min(1).max(MAX_AI_PROVIDER_CHARS);

function methodNotAllowed(): never {
  throw new HttpError(405, "METHOD_NOT_ALLOWED", "method not allowed");
}

function providerQuery(url: URL): string | undefined {
  for (const key of url.searchParams.keys()) {
    if (key !== "provider") {
      throw new HttpError(400, "INVALID_REQUEST", "unknown query parameter");
    }
  }
  const values = url.searchParams.getAll("provider");
  if (values.length === 0) return undefined;
  if (values.length !== 1) {
    throw new HttpError(400, "INVALID_REQUEST", "provider must appear once");
  }
  const parsed = providerQuerySchema.safeParse(values[0]);
  if (!parsed.success) {
    throw new HttpError(400, "INVALID_REQUEST", "invalid provider");
  }
  return parsed.data;
}

export async function handleSettings(
  request: Request,
  url: URL,
  ctx: { ai: AiManager; db: Database },
): Promise<Response | null> {
  const method = request.method.toUpperCase();

  if (url.pathname === "/api/settings") {
    if (method !== "PATCH") methodNotAllowed();
    const body: { uiLocale: UiLocale } = await readJson(
      request,
      MAX_LOCALE_BYTES,
      localeBodySchema,
    );
    return jsonResponse({ uiLocale: saveUiLocale(ctx.db, body.uiLocale) });
  }

  if (url.pathname === "/api/ai/settings") {
    if (method === "GET") {
      return jsonResponse(await ctx.ai.getSettings());
    }
    if (method === "PUT") {
      const config = await readJson(request, MAX_AI_SETTINGS_BYTES, aiConfigSchema);
      const snapshot: AiSettingsSnapshot = await ctx.ai.saveConfig(config);
      return jsonResponse(snapshot);
    }
    methodNotAllowed();
  }

  if (url.pathname === "/api/ai/catalog") {
    if (method !== "GET") methodNotAllowed();
    const catalog: AiCatalog = await ctx.ai.getCatalog(providerQuery(url));
    return jsonResponse(catalog);
  }

  if (url.pathname === "/api/ai/catalog/refresh") {
    if (method !== "POST") methodNotAllowed();
    const body = await readJson(
      request,
      MAX_CATALOG_REFRESH_BYTES,
      providerBodySchema,
    );
    return jsonResponse(await ctx.ai.refreshCatalog(body.provider, request.signal));
  }

  return null;
}
