import { afterEach, describe, expect, test } from "bun:test";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiConfig } from "../shared/contracts";
import { openAiCredentialStore, type SqliteCredentialStore } from "./ai-credentials";
import {
  AiConfigError,
  AiProviderNotFoundError,
  createAiManager,
} from "./ai-settings";
import { getAppSettings, openReaderDb, saveAiConfig } from "./storage";

const directories: string[] = [];
const stores: SqliteCredentialStore[] = [];
const databases: Database[] = [];

async function setup(): Promise<{
  directory: string;
  db: Database;
  store: SqliteCredentialStore;
  manager: ReturnType<typeof createAiManager>;
}> {
  const directory = mkdtempSync(join(tmpdir(), "lumo-ai-settings-"));
  directories.push(directory);
  const db = openReaderDb(directory);
  databases.push(db);
  const store = await openAiCredentialStore(directory);
  stores.push(store);
  return { directory, db, store, manager: createAiManager(db, store) };
}

const custom: AiConfig = {
  provider: "custom",
  model: "vision-a",
  baseUrl: "http://127.0.0.1:9/v1",
  contextWindow: 128000,
  maxTokens: 4096,
};

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("createAiManager", () => {
  test("offers the custom provider but no models until a valid config is saved", async () => {
    const { manager } = await setup();
    const empty = await manager.getCatalog("custom");
    expect(empty.models).toEqual([]);
    expect(empty.providers.map((provider) => provider.id)).toContain("custom");

    await manager.saveConfig(custom);
    const configured = await manager.getCatalog("custom");
    expect(configured.models).toEqual([
      expect.objectContaining({ id: "vision-a", contextWindow: 128000 }),
    ]);
  });

  test("rejects unknown providers, unknown models, text-only models and invalid URLs", async () => {
    const { manager } = await setup();
    await expect(
      manager.saveConfig({ provider: "nope", model: "missing" }),
    ).rejects.toBeInstanceOf(AiProviderNotFoundError);
    const catalog = await manager.getCatalog();
    const stableProvider = catalog.providers.find(
      (provider) => provider.id !== "custom" && !provider.canRefreshModels,
    );
    expect(stableProvider).toBeDefined();
    await expect(
      manager.saveConfig({ provider: stableProvider!.id, model: "missing-model" }),
    ).rejects.toBeInstanceOf(AiConfigError);
    await expect(
      manager.saveConfig({ provider: "amazon-bedrock", model: "amazon.nova-micro-v1:0" }),
    ).rejects.toBeInstanceOf(AiConfigError);
    await expect(
      manager.saveConfig({ ...custom, baseUrl: "javascript:alert(1)" }),
    ).rejects.toBeDefined();
  });

  test("reports the reasoning efforts each model supports", async () => {
    const { manager } = await setup();
    const openai = await manager.getCatalog("openai");
    expect(
      openai.models.find((model) => model.id === "gpt-5")?.reasoningEfforts,
    ).toEqual(["minimal", "low", "medium", "high"]);
    expect(
      openai.models.find((model) => model.id === "gpt-4-turbo")?.reasoningEfforts,
    ).toEqual([]);

    const anthropic = await manager.getCatalog("anthropic");
    expect(
      anthropic.models.find((model) => model.id === "claude-fable-5")?.reasoningEfforts,
    ).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  test("rejects unsupported effort choices without changing the saved config", async () => {
    const { manager, db } = await setup();
    await manager.saveConfig({
      provider: "openai",
      model: "gpt-5",
      reasoningEffort: "high",
    });
    await expect(
      manager.saveConfig({
        provider: "openai",
        model: "gpt-5",
        reasoningEffort: "xhigh",
      }),
    ).rejects.toThrow("openai/gpt-5 does not support reasoning effort xhigh");
    await expect(
      manager.saveConfig({
        provider: "openai",
        model: "gpt-4-turbo",
        reasoningEffort: "low",
      }),
    ).rejects.toThrow("openai/gpt-4-turbo does not support reasoning effort low");
    await expect(
      manager.saveConfig({ ...custom, reasoningEffort: "xhigh" }),
    ).rejects.toThrow("custom/vision-a does not support reasoning effort xhigh");
    expect(getAppSettings(db).aiConfig).toEqual({
      provider: "openai",
      model: "gpt-5",
      reasoningEffort: "high",
    });

    await manager.saveConfig({ ...custom, reasoningEffort: "high" });
    expect(getAppSettings(db).aiConfig).toEqual({
      ...custom,
      reasoningEffort: "high",
    });
  });

  test("flags a stored effort that its model does not support", async () => {
    const { manager, db } = await setup();
    saveAiConfig(db, {
      provider: "openai",
      model: "gpt-5",
      reasoningEffort: "xhigh",
    });
    expect((await manager.getSettings()).status).toMatchObject({
      configured: false,
      code: "AI_MODEL_UNSUPPORTED",
    });
    const runtime = await manager.getRuntime();
    await expect(runtime.checkConfigured()).resolves.toMatchObject({
      ok: false,
      code: "AI_MODEL_UNSUPPORTED",
    });
  });

  test("requires a stored credential for providers with login and reports it without leaking", async () => {
    const { manager, store } = await setup();
    const catalog = await manager.getCatalog("openai");
    const model = catalog.models[0];
    if (!model) throw new Error("openai catalog has no image model");
    const config: AiConfig = { provider: "openai", model: model.id };
    await manager.saveConfig(config);
    expect((await manager.getSettings()).status).toMatchObject({
      configured: false,
      code: "AI_NOT_CONFIGURED",
    });

    await store.modify("openai", async () => ({ type: "api_key", key: "sk-secret" }));
    const settings = await manager.getSettings();
    expect(settings.status.configured).toBe(true);
    const refreshed = await manager.getCatalog("openai");
    expect(
      refreshed.providers.find((provider) => provider.id === "openai")
        ?.credentialType,
    ).toBe("api_key");
    expect(JSON.stringify(settings)).not.toContain("sk-secret");
    expect(JSON.stringify(await manager.getCatalog("openai"))).not.toContain("sk-secret");
  });

  test("ignores ambient credentials and refuses external credential records", async () => {
    const previous = { ...process.env };
    try {
      Object.assign(process.env, {
        OPENAI_API_KEY: "env-openai",
        GOOGLE_CLOUD_API_KEY: "env-google",
        AWS_PROFILE: "env-profile",
        AWS_ACCESS_KEY_ID: "env-aws",
        AWS_SECRET_ACCESS_KEY: "env-secret",
        CLOUDFLARE_API_KEY: "env-cloudflare",
        CLOUDFLARE_ACCOUNT_ID: "env-account",
        CLOUDFLARE_GATEWAY_ID: "env-gateway",
      });
      const { manager, store } = await setup();

      const openai = await manager.getCatalog("openai");
      await manager.saveConfig({ provider: "openai", model: openai.models[0]!.id });
      expect((await manager.getSettings()).status).toMatchObject({
        configured: false,
        code: "AI_NOT_CONFIGURED",
      });
      await expect((await manager.getRuntime()).checkConfigured()).resolves.toMatchObject({
        ok: false,
        code: "AI_NOT_CONFIGURED",
      });

      await store.modify("amazon-bedrock", async () => ({
        type: "api_key",
        env: { AWS_PROFILE: "saved-profile" },
      }));
      const bedrock = await manager.getCatalog("amazon-bedrock");
      await manager.saveConfig({
        provider: "amazon-bedrock",
        model: bedrock.models[0]!.id,
      });
      expect((await manager.getSettings()).status).toMatchObject({
        configured: false,
        code: "AI_NOT_CONFIGURED",
      });
      expect(await store.read("amazon-bedrock")).toEqual({
        type: "api_key",
        env: { AWS_PROFILE: "saved-profile" },
      });

      const vertexCredentials = {
        type: "api_key" as const,
        env: {
          GOOGLE_APPLICATION_CREDENTIALS: "/tmp/adc.json",
          GOOGLE_CLOUD_PROJECT: "saved-project",
          GOOGLE_CLOUD_LOCATION: "saved-location",
        },
      };
      await store.modify("google-vertex", async () => vertexCredentials);
      const vertex = await manager.getCatalog("google-vertex");
      await manager.saveConfig({
        provider: "google-vertex",
        model: vertex.models[0]!.id,
      });
      expect((await manager.getSettings()).status).toMatchObject({
        configured: false,
        code: "AI_NOT_CONFIGURED",
      });
      expect(await store.read("google-vertex")).toEqual(vertexCredentials);

      await store.modify("cloudflare-ai-gateway", async () => ({
        type: "api_key",
        key: "cloudflare-key",
      }));
      const cloudflare = await manager.getCatalog("cloudflare-ai-gateway");
      await manager.saveConfig({
        provider: "cloudflare-ai-gateway",
        model: cloudflare.models[0]!.id,
      });
      expect((await manager.getSettings()).status).toMatchObject({
        configured: false,
        code: "AI_NOT_CONFIGURED",
      });
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) delete process.env[key];
      }
      Object.assign(process.env, previous);
    }
  }, 20000);

  test("logs in to Bedrock and Vertex with one app-entered secret", async () => {
    const { manager } = await setup();
    for (const provider of ["amazon-bedrock", "google-vertex"] as const) {
      const catalog = await manager.getCatalog(provider);
      const model = catalog.models[0];
      if (!model) throw new Error(`${provider} has no image model`);
      await manager.saveConfig({ provider, model: model.id });

      const prompts: string[] = [];
      const interaction: AuthInteraction = {
        prompt: async (prompt) => {
          prompts.push(prompt.type);
          return "synthetic-key";
        },
        notify: () => undefined,
      };
      await manager.login(provider, "api_key", interaction);
      expect(prompts).toEqual(["secret"]);
      const settings = await manager.getSettings();
      expect(settings.status.configured).toBe(true);
      const refreshed = await manager.getCatalog(provider);
      expect(
        refreshed.providers.find((option) => option.id === provider)
          ?.credentialType,
      ).toBe("api_key");
    }
  }, 20000);

  test("uses an app-entered key over a conflicting environment value", async () => {
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "env-key";
    let authorization: string | null = null;
    const frames = [
      {
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "vision-a",
        choices: [{ index: 0, delta: { content: "# Native" }, finish_reason: null }],
      },
      {
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "vision-a",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        authorization = request.headers.get("authorization");
        return new Response(
          `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    try {
      const { manager, store } = await setup();
      const catalog = await manager.getCatalog("deepseek");
      await manager.saveConfig({
        provider: "deepseek",
        model: catalog.models[0]!.id,
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
      });
      await store.modify("deepseek", async () => ({
        type: "api_key",
        key: "app-key",
      }));
      const runtime = await manager.getRuntime();
      const translation = await runtime.translatePage(
        {
          documentId: "a".repeat(64),
          pageNumber: 1,
          targetLanguage: "en",
          format: "pdf",
          text: "Hello",
          imageBase64: "/9j/AAAA",
          force: false,
        },
        new AbortController().signal,
        () => undefined,
      );
      expect(authorization ?? "missing").toBe("Bearer app-key");
      expect(translation.typst).toBe("# Native");
    } finally {
      await server.stop(true);
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previous;
    }
  }, 20000);

  test("sends a stored custom key and the selected effort to the endpoint", async () => {
    const { manager, store } = await setup();
    let authorization: string | null = null;
    const bodies: {
      model?: string;
      stream?: boolean;
      reasoning_effort?: string;
      messages?: { role: string }[];
    }[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        authorization = request.headers.get("authorization");
        bodies.push(await request.json());
        const frames = [
          {
            id: "chatcmpl-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "vision-a",
            choices: [{ index: 0, delta: { content: "# Native" }, finish_reason: null }],
          },
          {
            id: "chatcmpl-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "vision-a",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
        ];
        return new Response(
          `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    try {
      const config: AiConfig = {
        ...custom,
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
      };
      await manager.saveConfig(config);
      await store.modify("custom", async () => ({ type: "api_key", key: "stored-key" }));
      const input = {
        documentId: "a".repeat(64),
        pageNumber: 1,
        targetLanguage: "en" as const,
        format: "pdf" as const,
        text: "Hello",
        imageBase64: "/9j/AAAA",
        force: false,
      };

      const runtime = await manager.getRuntime();
      const plain = await runtime.translatePage(
        input,
        new AbortController().signal,
        () => undefined,
      );

      await manager.saveConfig({ ...config, reasoningEffort: "high" });
      const highRuntime = await manager.getRuntime();
      const high = await highRuntime.translatePage(
        input,
        new AbortController().signal,
        () => undefined,
      );

      expect(authorization ?? "missing").toBe("Bearer stored-key");
      expect(bodies[0]).toMatchObject({ model: "vision-a", stream: true });
      expect(bodies[0]?.messages?.[0]?.role).toBe("system");
      expect(bodies[0]).not.toHaveProperty("reasoning_effort");
      expect(bodies[1]).toMatchObject({
        model: "vision-a",
        stream: true,
        reasoning_effort: "high",
      });
      expect(bodies[1]?.messages?.[0]?.role).toBe("system");
      expect(plain.typst).toBe("# Native");
      expect(high.typst).toBe("# Native");
      expect(high).toMatchObject({ provider: "custom", model: "vision-a" });
    } finally {
      await server.stop(true);
    }
  });

  test("pins effort on each runtime while settings change", async () => {
    const { manager } = await setup();
    const received: string[] = [];
    const firstReceived = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    let requestCount = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { reasoning_effort?: string };
        const effort = body.reasoning_effort ?? "default";
        received.push(effort);
        const index = requestCount++;
        if (index === 0) firstReceived.resolve();
        const frames = [
          {
            id: `chatcmpl-${index}`,
            object: "chat.completion.chunk",
            created: 1,
            model: "vision-a",
            choices: [
              { index: 0, delta: { content: `# ${effort}` }, finish_reason: null },
            ],
          },
          {
            id: `chatcmpl-${index}`,
            object: "chat.completion.chunk",
            created: 1,
            model: "vision-a",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
        ];
        if (index === 0) await releaseFirst.promise;
        return new Response(
          `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    try {
      const config: AiConfig = {
        ...custom,
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
      };
      await manager.saveConfig({ ...config, reasoningEffort: "high" });
      const runtimeA = await manager.getRuntime();
      const input = {
        documentId: "a".repeat(64),
        pageNumber: 1,
        targetLanguage: "en" as const,
        format: "pdf" as const,
        text: "Hello",
        imageBase64: "/9j/AAAA",
        force: false,
      };
      const pendingA = runtimeA.translatePage(
        input,
        new AbortController().signal,
        () => undefined,
      );
      await firstReceived.promise;

      await manager.saveConfig({ ...config, reasoningEffort: "low" });
      const runtimeB = await manager.getRuntime();
      const low = await runtimeB.translatePage(
        input,
        new AbortController().signal,
        () => undefined,
      );
      releaseFirst.resolve();
      const high = await pendingA;
      const highAgain = await runtimeA.translatePage(
        input,
        new AbortController().signal,
        () => undefined,
      );

      expect(received).toEqual(["high", "low", "high"]);
      expect(high.typst).toBe("# high");
      expect(low.typst).toBe("# low");
      expect(highAgain.typst).toBe("# high");
    } finally {
      await server.stop(true);
    }
  }, 20000);
});
