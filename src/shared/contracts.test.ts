import { describe, expect, test } from "bun:test";
import {
  AI_REASONING_EFFORTS,
  TARGET_LANGUAGES,
  aiConfigSchema,
  readerUpdateSchema,
  readerViewSchema,
  translatePageInputSchema,
} from "./contracts";

const base = {
  documentId: "a".repeat(64),
  pageNumber: 1,
  targetLanguage: "zh-CN" as const,
  text: "",
  imageBase64: "/9j/AAAA",
};

describe("translatePageInputSchema", () => {
  test("accepts the documented shape and defaults force to false", () => {
    expect(translatePageInputSchema.parse(base)).toMatchObject({ ...base, force: false });
    expect(translatePageInputSchema.parse({ ...base, targetLanguage: "es", force: true }).targetLanguage).toBe("es");
  });

  test("rejects extra fields, invalid ids, pages, languages, and non-JPEG images", () => {
    expect(() => translatePageInputSchema.parse({ ...base, extra: 1 })).toThrow();
    expect(() => translatePageInputSchema.parse({ ...base, documentId: "A".repeat(64) })).toThrow();
    expect(() => translatePageInputSchema.parse({ ...base, pageNumber: 0 })).toThrow();
    expect(() => translatePageInputSchema.parse({ ...base, targetLanguage: "xx" })).toThrow();
    expect(() => translatePageInputSchema.parse({ ...base, imageBase64: "iVBORw0KGgo=" })).toThrow();
  });

  test("lists every supported target language", () => {
    expect(TARGET_LANGUAGES).toEqual(["zh-CN", "zh-TW", "en", "ja", "ko", "de", "fr", "es"]);
  });
});

describe("aiConfigSchema", () => {
  test("requires a full custom endpoint and forbids token limits on built-ins", () => {
    expect(
      aiConfigSchema.parse({
        provider: "custom",
        model: "vision",
        baseUrl: "https://example.com/v1",
        contextWindow: 128000,
        maxTokens: 4096,
      }),
    ).toMatchObject({ provider: "custom", maxTokens: 4096 });
    expect(aiConfigSchema.parse({ provider: "openai", model: "gpt" })).toEqual({
      provider: "openai",
      model: "gpt",
    });
    expect(() => aiConfigSchema.parse({ provider: "custom", model: "vision" })).toThrow();
    expect(() =>
      aiConfigSchema.parse({ provider: "openai", model: "gpt", contextWindow: 1000 }),
    ).toThrow();
    expect(() =>
      aiConfigSchema.parse({
        provider: "custom",
        model: "vision",
        baseUrl: "https://example.com/v1",
        contextWindow: 1000,
        maxTokens: 2000,
      }),
    ).toThrow();
  });

  test("accepts every supported reasoning effort and rejects off or unknown values", () => {
    for (const reasoningEffort of AI_REASONING_EFFORTS) {
      expect(
        aiConfigSchema.parse({ provider: "openai", model: "gpt", reasoningEffort }),
      ).toEqual({ provider: "openai", model: "gpt", reasoningEffort });
    }
    for (const reasoningEffort of ["off", "auto", "default", 1]) {
      expect(() =>
        aiConfigSchema.parse({ provider: "openai", model: "gpt", reasoningEffort }),
      ).toThrow();
    }
    expect(aiConfigSchema.parse({ provider: "openai", model: "gpt" })).not.toHaveProperty(
      "reasoningEffort",
    );
  });

  test("rejects credentials, queries, fragments and non-HTTP base URLs", () => {
    for (const baseUrl of [
      "file:///tmp/model",
      "https://user:pass@example.com/v1",
      "https://example.com/v1?key=x",
      "https://example.com/v1#fragment",
      "not a url",
    ]) {
      expect(() =>
        aiConfigSchema.parse({
          provider: "custom",
          model: "vision",
          baseUrl,
          contextWindow: 1000,
          maxTokens: 100,
        }),
      ).toThrow();
    }
  });
});

describe("readerUpdateSchema", () => {
  test("requires documentId and pageNumber to be set together or cleared together", () => {
    expect(
      readerUpdateSchema.parse({ documentId: null, pageNumber: null, targetLanguage: "en" }),
    ).toEqual({ documentId: null, pageNumber: null, targetLanguage: "en" });
    expect(() =>
      readerUpdateSchema.parse({ documentId: "a".repeat(64), pageNumber: null, targetLanguage: "en" }),
    ).toThrow();
  });
});

describe("readerViewSchema", () => {
  const view = {
    scaleValue: "page-fit",
    rotation: 0,
    scrollMode: 3,
    spreadMode: 0,
  };

  test("accepts PDF.js presets, ratios, and the documented modes", () => {
    for (const scaleValue of [
      "auto",
      "page-actual",
      "page-width",
      "page-height",
      "page-fit",
      "0.1",
      ".5",
      "1.25",
      "25",
    ]) {
      expect(readerViewSchema.parse({ ...view, scaleValue }).scaleValue).toBe(scaleValue);
    }
    expect(
      readerViewSchema.parse({
        scaleValue: "page-width",
        rotation: 270,
        scrollMode: 1,
        spreadMode: 2,
      }),
    ).toMatchObject({ rotation: 270, scrollMode: 1, spreadMode: 2 });
  });

  test("rejects out-of-range ratios, unknown presets, modes, and extra fields", () => {
    for (const scaleValue of [
      "0.09",
      "25.01",
      "125",
      "1e2",
      "Infinity",
      "NaN",
      " 1",
      "",
      "fit",
    ]) {
      expect(() => readerViewSchema.parse({ ...view, scaleValue })).toThrow();
    }
    expect(() => readerViewSchema.parse({ ...view, rotation: 45 })).toThrow();
    expect(() => readerViewSchema.parse({ ...view, scrollMode: 4 })).toThrow();
    expect(() => readerViewSchema.parse({ ...view, spreadMode: 3 })).toThrow();
    expect(() => readerViewSchema.parse({ ...view, extra: true })).toThrow();
  });
});
