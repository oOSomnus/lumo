import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiConfig, UiLocale } from "../shared/contracts";
import { openAiCredentialStore, type SqliteCredentialStore } from "./ai-credentials";
import { createAiManager, type AiManager } from "./ai-settings";
import { httpErrorFromUnknown } from "./http";
import { handleLibrary } from "./library";
import { handleSettings } from "./settings";
import { getUiLocale, openReaderDb } from "./storage";

const directories: string[] = [];
const stores: SqliteCredentialStore[] = [];
const databases: Database[] = [];
const origin = "http://127.0.0.1:1234";

async function setup(): Promise<{
  directory: string;
  db: Database;
  store: SqliteCredentialStore;
  ai: AiManager;
}> {
  const directory = mkdtempSync(join(tmpdir(), "lumo-settings-"));
  directories.push(directory);
  const db = openReaderDb(directory);
  databases.push(db);
  const store = await openAiCredentialStore(directory);
  stores.push(store);
  return { directory, db, store, ai: createAiManager(db, store) };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`${origin}${path}`, init);
}

function callSettings(
  ctx: { ai: AiManager; db: Database },
  path: string,
  init: RequestInit = {},
): Promise<Response | null> {
  return handleSettings(request(path, init), new URL(`${origin}${path}`), ctx);
}

function jsonBody(value: unknown): Pick<RequestInit, "body" | "headers"> {
  return {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  };
}

async function failure(response: Promise<unknown>): Promise<Response> {
  try {
    await response;
  } catch (error) {
    return httpErrorFromUnknown(error);
  }
  throw new Error("expected the request to fail");
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("handleSettings", () => {
  test("updates the locale and rejects strict-body violations", async () => {
    const ctx = await setup();
    const saved = await callSettings(ctx, "/api/settings", {
      method: "PATCH",
      ...jsonBody({ uiLocale: "zh-CN" }),
    });
    expect(saved?.status).toBe(200);
    expect(await saved?.json()).toEqual({ uiLocale: "zh-CN" });
    expect(getUiLocale(ctx.db)).toBe("zh-CN");

    const invalid = await failure(
      callSettings(ctx, "/api/settings", {
        method: "PATCH",
        ...jsonBody({ uiLocale: "fr" }),
      }),
    );
    expect(invalid.status).toBe(400);

    const extra = await failure(
      callSettings(ctx, "/api/settings", {
        method: "PATCH",
        ...jsonBody({ uiLocale: "en", extra: true }),
      }),
    );
    expect(extra.status).toBe(400);

    const wrongType = await failure(
      callSettings(ctx, "/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ uiLocale: "en" }),
      }),
    );
    expect(wrongType.status).toBe(400);
  });

  test("round-trips an AI config and never returns credential secrets", async () => {
    const ctx = await setup();
    const config: AiConfig = {
      provider: "openai",
      model: "gpt-5",
      reasoningEffort: "high",
    };
    const saved = await callSettings(ctx, "/api/ai/settings", {
      method: "PUT",
      ...jsonBody(config),
    });
    expect(saved?.status).toBe(200);
    expect(await saved?.json()).toMatchObject({
      config,
      status: { configured: false, code: "AI_NOT_CONFIGURED" },
    });

    await ctx.store.modify("openai", async () => ({ type: "api_key", key: "sk-hidden" }));
    const read = await callSettings(ctx, "/api/ai/settings");
    const body = await read?.text();
    expect(JSON.parse(body!)).toMatchObject({
      config,
      status: { configured: true },
    });
    expect(body).not.toContain("sk-hidden");

    const unsupported = await failure(
      callSettings(ctx, "/api/ai/settings", {
        method: "PUT",
        ...jsonBody({
          provider: "openai",
          model: "gpt-4-turbo",
          reasoningEffort: "low",
        }),
      }),
    );
    expect(unsupported.status).toBe(400);
  });

  test("validates catalog provider queries and maps unknown providers", async () => {
    const ctx = await setup();
    const duplicate = await failure(
      callSettings(ctx, "/api/ai/catalog?provider=openai&provider=anthropic"),
    );
    expect(duplicate.status).toBe(400);

    const unknown = await failure(callSettings(ctx, "/api/ai/catalog?provider=missing"));
    expect(unknown.status).toBe(404);
    const body = (await unknown.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AI_PROVIDER_NOT_FOUND");
  });

  test("keeps device ids and credentials out of the library snapshot", async () => {
    const ctx = await setup();
    await ctx.store.modify("openai", async () => ({ type: "api_key", key: "sk-hidden" }));
    const response = await handleLibrary(
      request("/api/library"),
      new URL(`${origin}/api/library`),
      { db: ctx.db, dataDirectory: ctx.directory },
    );
    const text = await response.text();
    const snapshot = JSON.parse(text) as { uiLocale: UiLocale };
    expect(snapshot.uiLocale).toBe("en");
    expect(snapshot).not.toHaveProperty("deviceId");
    expect(text).not.toContain("sk-hidden");
  });
});
