import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { AiConfig } from "../shared/contracts";
import {
  AiError,
  assembleFinalMarkdown,
  buildTranslationContext,
  createAiRuntime,
  registerCustomProvider,
} from "./ai";

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "mock",
    model: "mock-vision",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

describe("buildTranslationContext", () => {
  test("sends the text layer and the page image as one user message", () => {
    const context = buildTranslationContext({
      documentId: "a".repeat(64),
      pageNumber: 2,
      targetLanguage: "ja",
      text: "Heading\nBody",
      imageBase64: "/9j/AAAA",
      force: false,
    });

    const content = context.messages[0]!.content;
    expect(content).toContainEqual(expect.objectContaining({ type: "image", mimeType: "image/jpeg" }));
    expect(content).toContainEqual(
      expect.objectContaining({ type: "text", text: expect.stringContaining("日本語") }),
    );
    expect(content).toContainEqual(
      expect.objectContaining({ type: "text", text: expect.stringContaining("Heading\nBody") }),
    );
  });
});

describe("assembleFinalMarkdown", () => {
  test("joins text blocks and rejects tools, truncation, and empty output", () => {
    expect(assembleFinalMarkdown(assistant([{ type: "text", text: "# One\n" }, { type: "text", text: "Two" }]))).toBe("# One\nTwo");

    expect(() => assembleFinalMarkdown(assistant([{ type: "text", text: "x" }], "length"))).toThrow(AiError);
    expect(() =>
      assembleFinalMarkdown(assistant([{ type: "toolCall", id: "1", name: "x", arguments: {} }])),
    ).toThrow(AiError);
    expect(() => assembleFinalMarkdown(assistant([{ type: "text", text: "   " }]))).toThrow(AiError);
    expect(() => assembleFinalMarkdown(assistant([{ type: "text", text: "x".repeat(200_001) }]))).toThrow(AiError);
  });
});

describe("createAiRuntime", () => {
  test("reports missing configuration before any request", async () => {
    const runtime = createAiRuntime(null, builtinModels());
    await expect(runtime.checkConfigured()).resolves.toMatchObject({ ok: false, code: "AI_NOT_CONFIGURED" });
  });

  test("rejects text-only models with a model error", async () => {
    const config: AiConfig = {
      provider: "amazon-bedrock",
      model: "amazon.nova-micro-v1:0",
    };
    const runtime = createAiRuntime(config, builtinModels());
    await expect(runtime.checkConfigured()).resolves.toMatchObject({ ok: false, code: "AI_MODEL_UNSUPPORTED" });
  });

  test("rejects a reasoning effort the model does not support", async () => {
    const config: AiConfig = {
      provider: "openai",
      model: "gpt-5",
      reasoningEffort: "xhigh",
    };
    const runtime = createAiRuntime(config, builtinModels());
    await expect(runtime.checkConfigured()).resolves.toMatchObject({
      ok: false,
      code: "AI_MODEL_UNSUPPORTED",
    });
  });

  test("accepts a local custom endpoint without an API key", async () => {
    const config: AiConfig = {
      provider: "custom",
      model: "local-vision",
      baseUrl: "http://127.0.0.1:8000/v1",
      contextWindow: 128000,
      maxTokens: 4096,
    };
    const runtime = createAiRuntime(
      config,
      registerCustomProvider(builtinModels(), config),
    );
    await expect(runtime.checkConfigured()).resolves.toEqual({ ok: true });
  });
});
