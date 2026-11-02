import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryModelsStore,
  createModels,
  createProvider,
  type Credential,
  type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  CredentialStorageError,
  openAiCredentialStore,
  type SqliteCredentialStore,
} from "./ai-credentials";
import {
  openReaderDb,
  saveTranslation,
  storeDocument,
} from "./storage";

const directories: string[] = [];
const stores: SqliteCredentialStore[] = [];
const databases: Database[] = [];

async function openSetup(): Promise<{
  directory: string;
  store: SqliteCredentialStore;
}> {
  const directory = mkdtempSync(join(tmpdir(), "lumo-credentials-"));
  directories.push(directory);
  const store = await openAiCredentialStore(directory);
  stores.push(store);
  return { directory, store };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteCredentialStore", () => {
  test("persists API keys and OAuth metadata, listing only ids and types", async () => {
    const { directory, store } = await openSetup();
    expect(statSync(store.path).mode & 0o777).toBe(0o600);

    const apiKey: Credential = { type: "api_key", key: "sk-live", env: { REGION: "eu" } };
    const oauth: Credential = {
      type: "oauth",
      refresh: "refresh-token",
      access: "access-token",
      expires: Date.now() + 60_000,
      accountId: "account-1",
    };
    await store.modify("openrouter", async () => apiKey);
    await store.modify("anthropic", async () => oauth);

    expect(await store.read("openrouter")).toEqual(apiKey);
    expect(await store.read("anthropic")).toEqual(oauth);
    expect(await store.list()).toEqual([
      { providerId: "anthropic", type: "oauth" },
      { providerId: "openrouter", type: "api_key" },
    ]);
    expect(JSON.stringify(await store.list())).not.toContain("sk-live");
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = await openAiCredentialStore(directory);
    stores.push(reopened);
    expect(await reopened.read("anthropic")).toEqual(oauth);
  });

  test("keeps the previous credential when a replacement fails or is cancelled", async () => {
    const { store } = await openSetup();
    const original: Credential = { type: "api_key", key: "original" };
    await store.modify("openai", async () => original);

    await expect(
      store.modify("openai", async () => {
        throw new Error("refresh failed");
      }),
    ).rejects.toThrow("refresh failed");
    expect(await store.read("openai")).toEqual(original);

    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      store.modify("openai", async () => ({ type: "api_key", key: "new" }), {
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
    expect(await store.read("openai")).toEqual(original);
  });

  test("reports malformed stored credentials without overwriting them", async () => {
    const { store } = await openSetup();
    const raw = new Database(store.path);
    raw.exec(
      "INSERT INTO credentials (providerId, type, data) VALUES ('broken', 'api_key', '{nope')",
    );
    raw.close();

    await expect(store.read("broken")).rejects.toBeInstanceOf(CredentialStorageError);
    await expect(store.modify("broken", async () => undefined)).rejects.toBeInstanceOf(
      CredentialStorageError,
    );
  });

  test("opens only one refresh across two store connections", async () => {
    const { directory, store } = await openSetup();
    const second = await openAiCredentialStore(directory);
    stores.push(second);
    await store.modify("anthropic", async () => ({
      type: "oauth",
      refresh: "old",
      access: "old",
      expires: Date.now() - 1,
    }));

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refreshed: Credential = {
      type: "oauth",
      refresh: "new",
      access: "new",
      expires: Date.now() + 60_000,
    };
    let refreshes = 0;
    const first = store.modify("anthropic", async (current) => {
      await gate;
      refreshes += 1;
      return { ...refreshed, refresh: `${current?.type === "oauth" ? current.refresh : "?"}-new` };
    });
    await Bun.sleep(20);
    const waiting = second.modify("anthropic", async (current) => {
      if (current?.type === "oauth" && current.expires > Date.now()) return undefined;
      refreshes += 1;
      return refreshed;
    });
    release();
    await Promise.all([first, waiting]);

    expect(refreshes).toBe(1);
    expect(await store.read("anthropic")).toMatchObject({ type: "oauth", access: "new" });
  });

  test("refreshes OAuth once through Pi and persists the new access token", async () => {
    const { store } = await openSetup();
    const expired: Credential = {
      type: "oauth",
      refresh: "refresh-1",
      access: "access-old",
      expires: Date.now() - 1_000,
    };
    await store.modify("fake", async () => expired);
    const model: Model<"openai-completions"> = {
      id: "fake-vision",
      name: "Fake vision",
      api: "openai-completions",
      provider: "fake",
      baseUrl: "https://example.invalid/v1",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_000,
      maxTokens: 1_000,
    };
    let refreshes = 0;
    const models = createModels({
      credentials: store,
      modelsStore: new InMemoryModelsStore(),
    });
    models.setProvider(
      createProvider({
        id: "fake",
        auth: {
          oauth: {
            name: "Fake OAuth",
            login: async () => expired,
            refresh: async (credential) => {
              refreshes += 1;
              return {
                ...credential,
                refresh: "refresh-2",
                access: "access-new",
                expires: Date.now() + 60 * 60_000,
              };
            },
            toAuth: async (credential) => ({ apiKey: credential.access }),
          },
        },
        models: [model],
        api: openAICompletionsApi(),
      }),
    );

    const first = await models.getAuth(model);
    expect(first?.auth.apiKey).toBe("access-new");
    expect(refreshes).toBe(1);
    expect(await store.read("fake")).toMatchObject({
      type: "oauth",
      refresh: "refresh-2",
      access: "access-new",
    });

    const second = await models.getAuth(model);
    expect(second?.auth.apiKey).toBe("access-new");
    expect(refreshes).toBe(1);
  });

  test("holds the credential lock during refresh without blocking reader writes", async () => {
    const { directory, store } = await openSetup();
    const db = openReaderDb(directory);
    databases.push(db);
    const document = storeDocument(
      db,
      { name: "doc.pdf", pageCount: 1 },
      new TextEncoder().encode("%PDF-1.7 credentials"),
    );

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresh = store.modify("openai", async () => {
      await gate;
      return { type: "api_key", key: "key" };
    });
    await Bun.sleep(20);

    expect(
      saveTranslation(
        db,
        { documentId: document.id, pageNumber: 1, targetLanguage: "en" },
        { markdown: "# saved", provider: "p", model: "m" },
      ).markdown,
    ).toBe("# saved");
    let settled = false;
    void refresh.finally(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    release();
    await refresh;
    expect(await store.read("openai")).toEqual({ type: "api_key", key: "key" });
  });
});
