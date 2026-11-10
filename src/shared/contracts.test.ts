import { describe, expect, test } from "bun:test";
import {
  AI_REASONING_EFFORTS,
  MAX_EPUB_CFI_CHARS,
  MAX_OUTLINE_ENTRIES,
  MAX_OUTLINE_HEADINGS_PER_PAGE,
  MAX_TYPST_CHARS,
  MAX_TYPST_DIAGNOSTICS_CHARS,
  TARGET_LANGUAGES,
  aiConfigSchema,
  outlineEntriesSchema,
  outlineHeadingSchema,
  outlinePageInputSchema,
  outlinePageResultSchema,
  readerUpdateSchema,
  readerViewSchema,
  translatePageInputSchema,
  translateStreamEventSchema,
  translationSaveInputSchema,
  typstRepairProgressSchema,
} from "./contracts";
import { MAX_CONTEXT_IMAGE_BASE64_CHARS, MAX_TRANSLATION_CONTEXT_CHARS } from "./limits";

const base = {
  documentId: "a".repeat(64),
  pageNumber: 1,
  targetLanguage: "zh-CN" as const,
  format: "pdf" as const,
  text: "",
  imageBase64: "/9j/AAAA",
};

const cfi = "epubcfi(/6/4!/4/2,/1:0,/1:9)";
const epubBase = {
  documentId: "a".repeat(64),
  pageNumber: 1,
  targetLanguage: "ja" as const,
  format: "epub" as const,
  unit: `page-${"c".repeat(64)}`,
  sourceCfi: cfi,
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

  test("accepts EPUB content units and rejects unsafe or duplicate image paths", () => {
    const epub = {
      documentId: "a".repeat(64),
      pageNumber: 2,
      targetLanguage: "ja" as const,
      format: "epub" as const,
      unit: `page-${"c".repeat(64)}`,
      sourceCfi: cfi,
      xhtml: "<h1>Title</h1>",
      images: [
        { path: `assets/${"b".repeat(64)}.png`, imageBase64: "/9j/AAAA" },
      ],
    };
    expect(translatePageInputSchema.parse(epub)).toMatchObject({
      ...epub,
      force: false,
    });
    expect(() =>
      translatePageInputSchema.parse({ ...epub, format: "pdf" }),
    ).toThrow();
    for (const path of [
      "assets/../../etc/passwd",
      `assets/${"B".repeat(64)}.png`,
      `assets/${"b".repeat(64)}.jpeg`,
      `images/${"b".repeat(64)}.png`,
    ]) {
      expect(() =>
        translatePageInputSchema.parse({
          ...epub,
          images: [{ path, imageBase64: "/9j/AAAA" }],
        }),
      ).toThrow();
    }
    expect(() =>
      translatePageInputSchema.parse({
        ...epub,
        images: [epub.images[0]!, epub.images[0]!],
      }),
    ).toThrow();
  });

  test("accepts a bounded Typst repair for both formats and rejects malformed ones", () => {
    const repair = {
      typst: "#strong[unclosed",
      diagnostics: "error: unclosed delimiter (line 1, column 8)\n1 | #strong⟦[⟧unclosed",
    };
    const pdfRepair = {
      documentId: "a".repeat(64),
      pageNumber: 1,
      targetLanguage: "zh-CN" as const,
      format: "pdf" as const,
      repair,
    };
    const epubRepair = { ...epubBase, repair };
    expect(translatePageInputSchema.parse(pdfRepair)).toMatchObject({ repair });
    expect(translatePageInputSchema.parse(epubRepair)).toMatchObject({ repair });
    expect(translatePageInputSchema.parse(base)).not.toHaveProperty("repair");
    expect(
      translatePageInputSchema.parse({
        ...pdfRepair,
        repair: {
          typst: "x".repeat(MAX_TYPST_CHARS),
          diagnostics: "x".repeat(MAX_TYPST_DIAGNOSTICS_CHARS),
        },
      }),
    ).toHaveProperty("repair");

    for (const bad of [
      { ...repair, typst: "" },
      { ...repair, typst: " \n" },
      { ...repair, typst: "x".repeat(MAX_TYPST_CHARS + 1) },
      { ...repair, diagnostics: "" },
      { ...repair, diagnostics: "x".repeat(MAX_TYPST_DIAGNOSTICS_CHARS + 1) },
      { ...repair, extra: true },
      { typst: repair.typst },
    ]) {
      expect(() => translatePageInputSchema.parse({ ...pdfRepair, repair: bad })).toThrow();
      expect(() => translatePageInputSchema.parse({ ...epubRepair, repair: bad })).toThrow();
    }
  });

  test("a repair carries only its identity and diagnostics, never page content or context", () => {
    const repair = { typst: "#strong[unclosed", diagnostics: "error: unclosed delimiter" };
    const pdfRepair = {
      documentId: "a".repeat(64),
      pageNumber: 1,
      targetLanguage: "zh-CN" as const,
      format: "pdf" as const,
      repair,
    };
    const epubRepair = { ...epubBase, repair };
    for (const extra of [{ text: "page" }, { imageBase64: "/9j/AAAA" }, { sourceCfi: cfi }, { context: {} }]) {
      expect(() => translatePageInputSchema.parse({ ...pdfRepair, ...extra })).toThrow();
    }
    for (const extra of [{ xhtml: "<p>x</p>" }, { images: [] }, { context: { next: { text: "a" } } }]) {
      expect(() => translatePageInputSchema.parse({ ...epubRepair, ...extra })).toThrow();
    }
  });

  test("bounds EPUB CFIs and unit identities", () => {
    const accepted = (input: object) =>
      translatePageInputSchema.safeParse({ ...epubBase, xhtml: "<p>x</p>", images: [], ...input }).success;
    const cfiOfLength = (length: number) => `epubcfi(${"x".repeat(length - "epubcfi()".length)})`;
    expect(accepted({ sourceCfi: cfiOfLength(MAX_EPUB_CFI_CHARS) })).toBe(true);
    expect(accepted({ sourceCfi: cfiOfLength(MAX_EPUB_CFI_CHARS + 1) })).toBe(false);
    for (const sourceCfi of ["", "/6/4!/4/2", "epubcfi()", undefined]) {
      expect(accepted({ sourceCfi })).toBe(false);
    }
    expect(accepted({ unit: `sel-${"c".repeat(64)}` })).toBe(true);
    for (const unit of [`page-${"C".repeat(64)}`, `page-${"c".repeat(63)}`, `page-${"c".repeat(64)}x`, "c".repeat(64), undefined]) {
      expect(accepted({ unit })).toBe(false);
    }
  });

  test("accepts bounded neighbouring-page references and rejects empty, oversized or unknown ones", () => {
    const text = "x".repeat(MAX_TRANSLATION_CONTEXT_CHARS);
    const image = `/9j/${"A".repeat(MAX_CONTEXT_IMAGE_BASE64_CHARS - 4)}`;
    const accepted = (context: object) => translatePageInputSchema.safeParse({ ...base, context }).success;
    expect(accepted({ previous: { text }, next: { imageBase64: image } })).toBe(true);
    expect(accepted({ previous: { text: `${text}x` } })).toBe(false);
    expect(accepted({ next: { imageBase64: `/9j/${"A".repeat(MAX_CONTEXT_IMAGE_BASE64_CHARS)}` } })).toBe(false);
    for (const reference of [{}, { text: "" }, { text: "a", extra: 1 }, { imageBase64: "iVBORw0KGgo=" }]) {
      expect(accepted({ previous: reference })).toBe(false);
    }
    expect(accepted({ before: { text: "a" } })).toBe(false);
    expect(
      translatePageInputSchema.safeParse({ ...epubBase, xhtml: "<p>x</p>", images: [], context: { next: { text: "a" } } }).success,
    ).toBe(true);
  });
});

describe("translationSaveInputSchema", () => {
  test("keeps the EPUB source CFI optional and bounded", () => {
    const content = { typst: "#p[x]", provider: "openai", model: "gpt" };
    expect(translationSaveInputSchema.parse(content)).toEqual(content);
    expect(translationSaveInputSchema.parse({ ...content, sourceCfi: cfi })).toEqual({ ...content, sourceCfi: cfi });
    expect(() => translationSaveInputSchema.parse({ ...content, sourceCfi: "/6/4" })).toThrow();
    expect(() => translationSaveInputSchema.parse({ ...content, extra: 1 })).toThrow();
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
    format: "pdf" as const,
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
      const parsed = readerViewSchema.parse({ ...view, scaleValue });
      expect(parsed.format === "pdf" ? parsed.scaleValue : null).toBe(scaleValue);
    }
    expect(
      readerViewSchema.parse({
        format: "pdf",
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

  const epubView = {
    format: "epub" as const,
    cfi: null,
    fontSize: 18,
    fontFamily: "serif" as const,
    lineHeight: 1.6 as const,
    theme: "light" as const,
  };

  test("keeps EPUB CFI views separate from PDF views", () => {
    expect(readerViewSchema.parse(epubView)).toEqual(epubView);
    expect(readerViewSchema.parse({ ...epubView, cfi: "epubcfi(/6/4!/4/2/2)" })).toMatchObject({
      format: "epub",
    });
    expect(() => readerViewSchema.parse({ ...epubView, cfi: "x".repeat(4097) })).toThrow();
    expect(() => readerViewSchema.parse({ ...view, cfi: "epubcfi(/6/4)" })).toThrow();
    expect(() => readerViewSchema.parse({ ...epubView, scaleValue: "page-fit" })).toThrow();
  });

  test("keeps at most five recent positions per side", () => {
    const memory = {
      pdf: [{ page: 1, left: 10, top: 20 }],
      translation: [
        { key: "book-1-zh-CN-page", offset: 0.5 },
      ],
    };
    expect(readerViewSchema.parse({ ...view, scrollMemory: memory })).toMatchObject({ scrollMemory: memory });
    expect(readerViewSchema.parse({ ...epubView, scrollMemory: memory })).toMatchObject({ scrollMemory: memory });

    const fivePdf = Array.from({ length: 5 }, (_, index) => ({ page: index + 1, left: 0, top: 0 }));
    expect(() =>
      readerViewSchema.parse({ ...view, scrollMemory: { pdf: [...fivePdf, { page: 6, left: 0, top: 0 }], translation: [] } }),
    ).toThrow();
    for (const bad of [
      { pdf: [{ page: 0, left: 0, top: 0 }], translation: [] },
      { pdf: [{ page: 1, left: Number.NaN, top: 0 }], translation: [] },
      { pdf: [], translation: [{ key: "", offset: 0 }] },
      { pdf: [], translation: [{ key: "x".repeat(257), offset: 0 }] },
      { pdf: [], translation: [{ key: "key", offset: 1.1 }] },
      { pdf: [], translation: [{ key: "key", offset: -0.1 }] },
    ]) {
      expect(() => readerViewSchema.parse({ ...view, scrollMemory: bad })).toThrow();
    }
  });

  test("requires explicit EPUB reading settings within their presets", () => {
    expect(() => readerViewSchema.parse({ format: "epub", cfi: null })).toThrow();
    for (const bad of [
      { fontSize: 11 },
      { fontSize: 37 },
      { fontSize: 18.5 },
      { fontFamily: "monospace" },
      { lineHeight: 1.5 },
      { theme: "blue" },
    ]) {
      expect(() => readerViewSchema.parse({ ...epubView, ...bad })).toThrow();
    }
    expect(
      readerViewSchema.parse({ ...epubView, fontSize: 36, fontFamily: "sans-serif", lineHeight: 2, theme: "dark" }),
    ).toMatchObject({ fontSize: 36, theme: "dark" });
  });
});

describe("outline schemas", () => {
  const entry = { title: "Chapter 1", level: 1, pageNumber: 1 };

  test("accepts headings, entries and page results at their boundaries", () => {
    expect(outlineHeadingSchema.parse({ title: "  Intro  ", level: 10_000 })).toEqual({
      title: "Intro",
      level: 10_000,
    });
    expect(outlineEntriesSchema.parse([entry])).toEqual([entry]);
    expect(
      outlineEntriesSchema.parse([
        entry,
        { title: "Chapter 1", level: 1, pageNumber: 1 },
        { title: "Section 1.1", level: 2, pageNumber: 3 },
      ]),
    ).toHaveLength(3);
    expect(outlinePageResultSchema.parse({ headings: [] })).toEqual({ headings: [] });
    expect(
      outlinePageResultSchema.parse({
        headings: Array.from({ length: MAX_OUTLINE_HEADINGS_PER_PAGE }, () => ({
          title: "Heading",
          level: 1,
        })),
      }).headings,
    ).toHaveLength(MAX_OUTLINE_HEADINGS_PER_PAGE);
  });

  test("rejects invalid titles, levels, skipped levels and decreasing pages", () => {
    for (const title of ["", "   ", "x".repeat(501), "bad\u0000title"]) {
      expect(() => outlineHeadingSchema.parse({ title, level: 1 })).toThrow();
    }
    for (const level of [0, -1, 1.5, 10_001, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => outlineHeadingSchema.parse({ title: "Heading", level })).toThrow();
    }
    expect(() => outlineEntriesSchema.parse([])).toThrow();
    expect(() =>
      outlineEntriesSchema.parse([{ ...entry, level: 2 }]),
    ).toThrow();
    expect(() =>
      outlineEntriesSchema.parse([
        entry,
        { title: "Deep", level: 3, pageNumber: 2 },
      ]),
    ).toThrow();
    expect(() =>
      outlineEntriesSchema.parse([
        entry,
        { title: "Later", level: 2, pageNumber: 3 },
        { title: "Back", level: 2, pageNumber: 2 },
      ]),
    ).toThrow();
    expect(() =>
      outlineEntriesSchema.parse(
        Array.from({ length: MAX_OUTLINE_ENTRIES + 1 }, () => entry),
      ),
    ).toThrow();
  });

  test("reuses the page input limits and bounds previous headings", () => {
    const input = {
      documentId: "a".repeat(64),
      pageNumber: 3,
      text: "Text",
      imageBase64: "/9j/AAAA",
      previousHeadings: [
        { title: "A", level: 1, pageNumber: 1 },
        { title: "A.1", level: 2, pageNumber: 2 },
      ],
    };
    expect(outlinePageInputSchema.parse(input)).toEqual(input);
    expect(() =>
      outlinePageInputSchema.parse({ ...input, extra: true }),
    ).toThrow();
    expect(() =>
      outlinePageInputSchema.parse({ ...input, imageBase64: "iVBORw0KGgo=" }),
    ).toThrow();
    expect(() =>
      outlinePageInputSchema.parse({
        ...input,
        previousHeadings: [
          { title: "Later", level: 1, pageNumber: 4 },
        ],
      }),
    ).toThrow();
    expect(() =>
      outlinePageInputSchema.parse({
        ...input,
        previousHeadings: Array.from({ length: 33 }, () => ({
          title: "A",
          level: 1,
          pageNumber: 1,
        })),
      }),
    ).toThrow();
  });

  test("rejects extra page result fields", () => {
    expect(() =>
      outlinePageResultSchema.parse({ headings: [], extra: true }),
    ).toThrow();
  });
});

describe("typst repair progress", () => {
  test("accepts each repair phase and bounds the rejection message", () => {
    for (const progress of [
      { phase: "requesting", replyAttempt: 1 },
      { phase: "rejected", replyAttempt: 2, error: { code: "INVALID_AI_OUTPUT", message: "bad reply" } },
      {
        phase: "rejected",
        replyAttempt: 1,
        error: { code: "INVALID_AI_OUTPUT", message: "x".repeat(MAX_TYPST_DIAGNOSTICS_CHARS) },
      },
      { phase: "applied", replyAttempt: 1, change: { mode: "edits", count: 2 } },
      { phase: "applied", replyAttempt: 2, change: { mode: "rewrite" } },
    ] as const) {
      expect(typstRepairProgressSchema.parse(progress)).toEqual(progress);
    }
  });

  test("rejects unknown phases, reply numbers, extra fields, and malformed changes", () => {
    for (const progress of [
      { phase: "done", replyAttempt: 1 },
      { phase: "requesting", replyAttempt: 3 },
      { phase: "requesting", replyAttempt: 1, extra: true },
      { phase: "rejected", replyAttempt: 1, error: { code: "INVALID_AI_OUTPUT", message: "" } },
      { phase: "rejected", replyAttempt: 1, error: { code: "AI_REQUEST_FAILED", message: "bad" } },
      {
        phase: "rejected",
        replyAttempt: 1,
        error: { code: "INVALID_AI_OUTPUT", message: "x".repeat(MAX_TYPST_DIAGNOSTICS_CHARS + 1) },
      },
      { phase: "applied", replyAttempt: 1, change: { mode: "edits", count: 0 } },
      { phase: "applied", replyAttempt: 1, change: { mode: "edits", count: 1.5 } },
      { phase: "applied", replyAttempt: 1, change: { mode: "edits" } },
      { phase: "applied", replyAttempt: 1, change: { mode: "rewrite", count: 1 } },
    ]) {
      expect(() => typstRepairProgressSchema.parse(progress)).toThrow();
    }
  });

  test("accepts a repair event only with a valid progress payload", () => {
    const event = { type: "repair", progress: { phase: "requesting", replyAttempt: 1 } } as const;
    expect(translateStreamEventSchema.parse(event)).toEqual(event);
    expect(() =>
      translateStreamEventSchema.parse({
        type: "repair",
        progress: { phase: "requesting", replyAttempt: 3 },
      }),
    ).toThrow();
  });
});
