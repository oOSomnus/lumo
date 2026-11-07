import { describe, expect, test } from "bun:test";
import type {
  AssistantMessage,
  Context,
  MutableModels,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { AiConfig, TranslatePageInput, TypstRepairProgress } from "../shared/contracts";
import {
  AiError,
  assembleFinalTypst,
  assembleOutlineHeadings,
  buildOutlineContext,
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

function userParts(context: Context) {
  const message = context.messages[0];
  if (message?.role !== "user" || typeof message.content === "string") {
    throw new Error("expected a user message with content parts");
  }
  return message.content;
}

describe("buildTranslationContext", () => {
  test("sends the text layer and the page image as one user message", () => {
    const context = buildTranslationContext({
      documentId: "a".repeat(64),
      pageNumber: 2,
      targetLanguage: "ja",
      format: "pdf",
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

  test("sends sanitized EPUB XHTML with stable image paths and previews", () => {
    const path = `assets/${"b".repeat(64)}.png`;
    const context = buildTranslationContext({
      documentId: "a".repeat(64),
      pageNumber: 1,
      targetLanguage: "de",
      format: "epub",
      unit: `page-${"c".repeat(64)}`,
      sourceCfi: "epubcfi(/6/4!/4/2,/1:0,/1:9)",
      xhtml: "<h1>Titel</h1><img src=\"assets/x.png\" alt=\"Figure\"/>",
      images: [{ path, imageBase64: "/9j/AAAA" }],
      force: false,
    });
    const content = context.messages[0]!.content;
    expect(content).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining(path),
      }),
    );
    expect(content).toContainEqual(
      expect.objectContaining({ type: "text", text: expect.stringContaining("Titel") }),
    );
    expect(content).toContainEqual(
      expect.objectContaining({ type: "image", mimeType: "image/jpeg", data: "/9j/AAAA" }),
    );
  });

  test("lists every asset the XHTML names once, marking which ones come with a preview", () => {
    const withPreview = `assets/${"1".repeat(64)}.png`;
    const without = `assets/${"2".repeat(64)}.gif`;
    const drawing = `assets/${"3".repeat(64)}.svg`;
    const context = buildTranslationContext({
      documentId: "a".repeat(64),
      pageNumber: 1,
      targetLanguage: "de",
      format: "epub",
      unit: `page-${"c".repeat(64)}`,
      sourceCfi: "epubcfi(/6/4!/4/2,/1:0,/1:9)",
      xhtml: `<p>Text</p><img src="${without}" alt="b"/><img src="${withPreview}" alt="a"/><img src="${without}" alt="again"/><svg><image href="${drawing}"/></svg>`,
      images: [{ path: withPreview, imageBase64: "/9j/AAAA" }],
      force: false,
    });
    const text = userParts(context).find((part) => part.type === "text")!.text;
    const manifest = text.slice(text.indexOf("Images available"));
    const entry = (path: string) => manifest.split("\n").find((line) => line.includes(path))!;
    for (const path of [withPreview, without, drawing]) {
      expect(manifest.split(path)).toHaveLength(2);
    }
    const note = (path: string) => entry(path).replace(/^\d+\. /, "").replace(path, "");
    expect(note(without)).toBe(note(drawing));
    expect(note(withPreview)).not.toBe(note(without));
  });

  test("a Typst repair resends the failed source and diagnostics and nothing else", () => {
    const context = buildTranslationContext({
      documentId: "a".repeat(64),
      pageNumber: 2,
      targetLanguage: "ja",
      format: "pdf",
      force: false,
      repair: {
        typst: "#strong[unclosed",
        diagnostics: "error: unclosed delimiter (line 1, column 8)\n1 | #strong⟦[⟧unclosed",
      },
    });

    const content = context.messages[0]!.content;
    expect(content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("#strong[unclosed"),
      }),
    ]);
    expect(JSON.stringify(content)).toContain("unclosed delimiter");
  });

  test("wraps the current page in labelled, read-only neighbouring references", () => {
    const context = buildTranslationContext({
      documentId: "a".repeat(64),
      pageNumber: 2,
      targetLanguage: "ja",
      format: "pdf",
      text: "Current page text",
      imageBase64: "/9j/CURRENT",
      force: false,
      context: {
        previous: { text: "Previous tail", imageBase64: "/9j/PREVIOUS" },
        next: { text: "Next head" },
      },
    });

    const parts = userParts(context).map((part) =>
      part.type === "image" ? part.data : part.text,
    );
    const positions = [
      "Previous tail",
      "/9j/PREVIOUS",
      "Current page text",
      "/9j/CURRENT",
      "Next head",
    ].map((needle) => parts.findIndex((part) => part.includes(needle)));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test("adds no reference block for a side that does not exist", () => {
    const context = buildTranslationContext({
      documentId: "a".repeat(64),
      pageNumber: 1,
      targetLanguage: "ja",
      format: "pdf",
      text: "Current page text",
      imageBase64: "/9j/CURRENT",
      force: false,
      context: { next: { text: "Next head" } },
    });

    const labels = userParts(context).flatMap((part) =>
      part.type === "text" && part.text.startsWith("Read-only context") ? [part.text] : [],
    );
    expect(labels).toHaveLength(1);
    expect(labels[0]).toContain("the start of the next page");
  });

  test("keeps an EPUB neighbouring image apart from the page's own images", () => {
    const context = buildTranslationContext({
      documentId: "a".repeat(64),
      pageNumber: 1,
      targetLanguage: "de",
      format: "epub",
      unit: `page-${"c".repeat(64)}`,
      sourceCfi: "epubcfi(/6/4!/4/2,/1:0,/1:9)",
      xhtml: "<h1>Titel</h1>",
      images: [{ path: `assets/${"b".repeat(64)}.png`, imageBase64: "/9j/CURRENT" }],
      force: false,
      context: { previous: { imageBase64: "/9j/PREVIOUS" } },
    });

    const parts = userParts(context).map((part) =>
      part.type === "image" ? part.data : part.text,
    );
    const xhtmlAt = parts.findIndex((part) => part.includes("Titel"));
    expect(parts.filter((part) => part.startsWith("/9j/"))).toEqual(["/9j/PREVIOUS", "/9j/CURRENT"]);
    expect(parts.indexOf("/9j/PREVIOUS")).toBeLessThan(xhtmlAt);
    expect(parts.indexOf("/9j/CURRENT")).toBeGreaterThan(xhtmlAt);
  });
});

describe("assembleFinalTypst", () => {
  test("joins text blocks and rejects tools, truncation, and empty output", () => {
    expect(assembleFinalTypst(assistant([{ type: "text", text: "# One\n" }, { type: "text", text: "Two" }]))).toBe("# One\nTwo");

    expect(() => assembleFinalTypst(assistant([{ type: "text", text: "x" }], "length"))).toThrow(AiError);
    expect(() =>
      assembleFinalTypst(assistant([{ type: "toolCall", id: "1", name: "x", arguments: {} }])),
    ).toThrow(AiError);
    expect(() => assembleFinalTypst(assistant([{ type: "text", text: "   " }]))).toThrow(AiError);
    expect(() => assembleFinalTypst(assistant([{ type: "text", text: "x".repeat(200_001) }]))).toThrow(AiError);
  });

  test("drops placeholder control bytes that Typst cannot parse", () => {
    expect(
      assembleFinalTypst(
        assistant([{ type: "text", text: "= A\u0000\u0007\nB\u007f" }]),
      ),
    ).toBe("= A\nB");
    expect(() =>
      assembleFinalTypst(assistant([{ type: "text", text: "\u0000\u0001" }])),
    ).toThrow(AiError);
  });
});

describe("assembleFinalTypst for a Typst repair", () => {
  const lines = [
    "#set page(width: 180mm, height: auto)",
    "#strong[应收账款（Accounts Receivable）",
    "金额 \\$1,234.50，$x^2 + y$ 保持不变。",
    '#image("assets/figure.png")',
    "重复 重复",
  ];
  const source = lines.join("\n");
  const closeBracket = {
    oldText: "#strong[应收账款（Accounts Receivable）",
    newText: "#strong[应收账款（Accounts Receivable）]",
  };
  const closed = [lines[0], `${lines[1]}]`, ...lines.slice(2)].join("\n");

  // A string reply is sent as written; anything else is sent as JSON.
  function repair(
    reply: unknown,
    from = source,
    stopReason?: AssistantMessage["stopReason"],
  ) {
    const text = typeof reply === "string" ? reply : JSON.stringify(reply);
    return assembleFinalTypst(assistant([{ type: "text", text }], stopReason), from);
  }

  function failureCode(run: () => unknown): string {
    try {
      run();
    } catch (error) {
      return error instanceof AiError ? error.code : String(error);
    }
    return "no error";
  }

  test("replaces only the failing fragment and keeps the rest of the page verbatim", () => {
    expect(repair({ edits: [closeBracket] })).toBe(closed);
  });

  test("applies edits in order to the previous result, inserts at an anchor and deletes with empty text", () => {
    expect(
      repair({
        edits: [
          closeBracket,
          // Only matches once the first edit has been applied.
          { oldText: "Receivable）]\n金额", newText: "Receivable）]\n\n金额" },
          { oldText: "\n重复 重复", newText: "" },
        ],
      }),
    ).toBe([lines[0], `${lines[1]}]`, "", ...lines.slice(2, 4)].join("\n"));
  });

  test("inserts replacement text literally", () => {
    const literal = "$& $1 $$ $` \\ \\n 🙂\n${x}";
    expect(repair({ edits: [{ oldText: "重复 重复", newText: literal }] })).toBe(
      [...lines.slice(0, 4), literal].join("\n"),
    );
  });

  test("ignores a replacement that changes nothing next to a real one", () => {
    expect(
      repair({ edits: [{ oldText: "重复", newText: "重复" }, { oldText: "不存在", newText: "不存在" }, closeBracket] }),
    ).toBe(closed);
  });

  test("accepts the complete document as the alternative reply", () => {
    expect(repair({ typst: closed })).toBe(closed);
    expect(repair({ typst: "= A\u0000\nB" })).toBe("= A\nB");
  });

  test("sizes the reply limit for JSON escaping rather than for Typst", () => {
    // The largest valid document, with every character written as a \uXXXX escape.
    const escaped = `{"typst":"${"\\u0061".repeat(200_000)}"}`;
    expect(escaped.length).toBeGreaterThan(1_000_000);
    expect(repair(escaped)).toBe("a".repeat(200_000));
    // A short document padded with whitespace is far longer than any legitimate reply.
    expect(failureCode(() => repair(`{"typst":"a"}${" ".repeat(1_300_000)}`))).toBe(
      "INVALID_AI_OUTPUT",
    );
  });

  test("treats an overlapping match as ambiguous", () => {
    const edit = { edits: [{ oldText: "aa", newText: "b" }] };
    expect(repair(edit, "xaay")).toBe("xby");
    expect(failureCode(() => repair(edit, "aaa"))).toBe("INVALID_AI_OUTPUT");
  });

  test("rejects replies that cannot be applied exactly", () => {
    const rejected: Record<string, unknown> = {
      "oldText absent": { edits: [{ oldText: "#strong[不存在", newText: "x" }] },
      "oldText twice": { edits: [{ oldText: "重复", newText: "x" }] },
      "empty oldText": { edits: [{ oldText: "", newText: "x" }] },
      "oldText equals newText": {
        edits: [{ oldText: "重复 重复", newText: "重复 重复" }],
      },
      "typst equal to the source": { typst: source },
      "replacements that cancel out": {
        edits: [
          { oldText: "重复 重复", newText: "XYZ" },
          { oldText: "XYZ", newText: "重复 重复" },
        ],
      },
      "no edits": { edits: [] },
      "edit with an unknown field": {
        edits: [{ ...closeBracket, replaceAll: true }],
      },
      "edit without newText": { edits: [{ oldText: "重复 重复" }] },
      "unknown top-level field": { edits: [closeBracket], note: "done" },
      "both branches": { edits: [closeBracket], typst: closed },
      "late failure after a valid edit": {
        edits: [closeBracket, { oldText: "#strong[不存在", newText: "x" }],
      },
      "intermediate document over the limit": {
        edits: [
          { oldText: "重复 重复", newText: "y".repeat(200_000) },
          { oldText: "y".repeat(200_000), newText: "" },
        ],
      },
      "blank document": { typst: " \n " },
      "document over the limit": { typst: "x".repeat(200_001) },
      "array root": [{ typst: closed }],
      "fenced JSON": `\`\`\`json\n${JSON.stringify({ edits: [closeBracket] })}\n\`\`\``,
      "truncated JSON": '{"edits":[{"oldText":"重复 重复"',
      "empty reply": "",
      "plain Typst reply": closed,
    };
    expect(
      Object.entries(rejected)
        .filter(([, reply]) => failureCode(() => repair(reply)) !== "INVALID_AI_OUTPUT")
        .map(([name]) => name),
    ).toEqual([]);
  });

  test("refuses a reply that makes the document ill-formed Unicode, but not one that leaves an existing flaw alone", () => {
    for (const reply of [
      '{"typst":"= ok \\ud83d"}',
      '{"edits":[{"oldText":"重复 重复","newText":"\\udc00"}]}',
    ]) {
      expect(failureCode(() => repair(reply))).toBe("INVALID_AI_OUTPUT");
    }
    // A flaw already in the source is not the reply's doing, and must not trap the repair loop.
    expect(repair({ edits: [closeBracket] }, `${source}\ud83d`)).toBe(`${closed}\ud83d`);
  });

  test("still rejects truncated output and tool calls", () => {
    expect(failureCode(() => repair({ edits: [closeBracket] }, source, "length"))).toBe(
      "INVALID_AI_OUTPUT",
    );
    expect(
      failureCode(() =>
        assembleFinalTypst(
          assistant([{ type: "toolCall", id: "1", name: "x", arguments: {} }]),
          source,
        ),
      ),
    ).toBe("INVALID_AI_OUTPUT");
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

  describe("translatePage over a synthetic provider stream", () => {
    const mockModel = {
      id: "mock-vision",
      name: "mock",
      provider: "mock",
      api: "openai-completions",
      input: ["text", "image"],
      maxTokens: 4096,
    };

    function runtimeFor(streamSimple: unknown) {
      return createAiRuntime(
        { provider: "mock", model: "mock-vision" },
        {
          getModel: () => mockModel,
          getAuth: async () => ({ apiKey: "test" }),
          streamSimple,
        } as unknown as MutableModels,
      );
    }

    function streaming(chunks: string[]) {
      return runtimeFor(() => ({
        async *[Symbol.asyncIterator]() {
          for (const delta of chunks) {
            yield { type: "text_delta", contentIndex: 0, delta };
          }
        },
        result: async () => assistant([{ type: "text", text: chunks.join("") }]),
      }));
    }

    /** Answers the n-th model call with the n-th reply and records the context of every call. */
    function scripted(replies: { text: string; stopReason?: AssistantMessage["stopReason"] }[]) {
      const contexts: Context[] = [];
      const runtime = runtimeFor((_model: unknown, context: Context) => {
        const reply = replies[contexts.length]!;
        contexts.push(context);
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "text_delta", contentIndex: 0, delta: reply.text };
          },
          result: async () => assistant([{ type: "text", text: reply.text }], reply.stopReason),
        };
      });
      return { runtime, contexts };
    }

    const page: TranslatePageInput = {
      documentId: "a".repeat(64),
      pageNumber: 2,
      targetLanguage: "en",
      format: "pdf",
      text: "Original page text",
      imageBase64: "/9j/AAAA",
      force: false,
    };
    const failed = "#set page(width: 180mm, height: auto)\n#strong[Accounts Receivable\nBody";
    const repairPage: TranslatePageInput = {
      documentId: "a".repeat(64),
      pageNumber: 2,
      targetLanguage: "en",
      format: "pdf",
      force: false,
      repair: { typst: failed, diagnostics: "unclosed delimiter" },
    };
    const signal = new AbortController().signal;

    test("assembles a repair from streamed JSON edits without sending them as draft text", async () => {
      const reply = JSON.stringify({
        edits: [{ oldText: "#strong[Accounts Receivable", newText: "#strong[Accounts Receivable]" }],
      });
      const streamed: string[] = [];
      const content = await streaming([reply.slice(0, 40), reply.slice(40)]).translatePage(
        repairPage,
        signal,
        ({ delta }) => streamed.push(delta),
      );
      expect(content.typst).toBe(
        "#set page(width: 180mm, height: auto)\n#strong[Accounts Receivable]\nBody",
      );
      expect(streamed).toEqual([]);
    });

    test("a plain translation still streams its Typst as it arrives", async () => {
      const streamed: string[] = [];
      const content = await streaming(["= Title\n", "Body"]).translatePage(
        page,
        signal,
        ({ delta }) => streamed.push(delta),
      );
      expect(streamed).toEqual(["= Title\n", "Body"]);
      expect(content.typst).toBe("= Title\nBody");
    });

    test("a repair may stream more JSON than the Typst limit, a plain translation may not", async () => {
      // 600,012 raw characters that decode to 100,000.
      const escaped = `{"typst":"${"\\u0061".repeat(100_000)}"}`;
      const repaired = await streaming([escaped]).translatePage(repairPage, signal, () => {});
      expect(repaired.typst).toBe("a".repeat(100_000));
      await expect(
        streaming([escaped]).translatePage(page, signal, () => {}),
      ).rejects.toMatchObject({ code: "INVALID_AI_OUTPUT" });
    });

    const noop = JSON.stringify({ edits: [{ oldText: "Body", newText: "Body" }] });
    const fix = JSON.stringify({
      edits: [{ oldText: "#strong[Accounts Receivable", newText: "#strong[Accounts Receivable]" }],
    });
    const fixed = "#set page(width: 180mm, height: auto)\n#strong[Accounts Receivable]\nBody";

    test("a repair reply that cannot be applied gets one follow-up turn", async () => {
      const { runtime, contexts } = scripted([{ text: noop }, { text: fix }]);
      const content = await runtime.translatePage(repairPage, signal, () => {});
      expect(content.typst).toBe(fixed);
      expect(contexts.map((context) => context.messages.map((message) => message.role))).toEqual([
        ["user"],
        ["user", "assistant", "user"],
      ]);
    });

    test("gives up after the second unusable repair reply", async () => {
      const { runtime, contexts } = scripted([{ text: noop }, { text: noop }, { text: fix }]);
      await expect(runtime.translatePage(repairPage, signal, () => {})).rejects.toMatchObject({
        code: "INVALID_AI_OUTPUT",
      });
      expect(contexts).toHaveLength(2);
    });

    test("does not ask again after a truncated repair reply or for a plain translation", async () => {
      const truncated = scripted([{ text: fix, stopReason: "length" }, { text: fix }]);
      const progress: TypstRepairProgress[] = [];
      await expect(
        truncated.runtime.translatePage(repairPage, signal, () => {}, (event) => progress.push(event)),
      ).rejects.toMatchObject({ code: "INVALID_AI_OUTPUT" });
      expect(truncated.contexts).toHaveLength(1);
      expect(progress.at(-1)).toEqual({
        phase: "rejected",
        replyAttempt: 1,
        error: { code: "INVALID_AI_OUTPUT", message: "translation stopped with reason length" },
      });

      const plain = scripted([{ text: "   " }, { text: "= Title" }]);
      await expect(plain.runtime.translatePage(page, signal, () => {})).rejects.toMatchObject({
        code: "INVALID_AI_OUTPUT",
      });
      expect(plain.contexts).toHaveLength(1);
    });

    test("reports each repair reply in order: the rejected one, then the applied one", async () => {
      const { runtime } = scripted([{ text: noop }, { text: fix }]);
      const progress: TypstRepairProgress[] = [];
      await runtime.translatePage(repairPage, signal, () => {}, (event) => progress.push(event));
      expect(progress).toEqual([
        { phase: "requesting", replyAttempt: 1 },
        {
          phase: "rejected",
          replyAttempt: 1,
          error: { code: "INVALID_AI_OUTPUT", message: "Typst repair makes no change" },
        },
        { phase: "requesting", replyAttempt: 2 },
        { phase: "applied", replyAttempt: 2, change: { mode: "edits", count: 1 } },
      ]);
    });

    test("publishes no applied event for a reply that fails as a whole", async () => {
      const partlyMissing = JSON.stringify({
        edits: [
          { oldText: "#strong[Accounts Receivable", newText: "#strong[Accounts Receivable]" },
          { oldText: "not in the source", newText: "x" },
        ],
      });
      const emptied = JSON.stringify({ typst: "  " });
      for (const [reply, message] of [
        [partlyMissing, "Typst repair oldText was not found"],
        [emptied, "model returned no translation text"],
      ] as const) {
        const { runtime } = scripted([{ text: reply }, { text: fix }]);
        const progress: TypstRepairProgress[] = [];
        await runtime.translatePage(repairPage, signal, () => {}, (event) => progress.push(event));
        expect(progress.slice(0, 2)).toEqual([
          { phase: "requesting", replyAttempt: 1 },
          { phase: "rejected", replyAttempt: 1, error: { code: "INVALID_AI_OUTPUT", message } },
        ]);
        expect(progress.at(-1)).toEqual({
          phase: "applied",
          replyAttempt: 2,
          change: { mode: "edits", count: 1 },
        });
      }
    });

    test("reports a full-document reply as a rewrite", async () => {
      const { runtime } = scripted([{ text: JSON.stringify({ typst: fixed }) }]);
      const progress: TypstRepairProgress[] = [];
      await runtime.translatePage(repairPage, signal, () => {}, (event) => progress.push(event));
      expect(progress.at(-1)).toEqual({
        phase: "applied",
        replyAttempt: 1,
        change: { mode: "rewrite" },
      });
    });

    test("counts only the replacements that change the document", async () => {
      const mixed = JSON.stringify({
        edits: [
          { oldText: "Body", newText: "Body" },
          { oldText: "#strong[Accounts Receivable", newText: "#strong[Accounts Receivable]" },
          { oldText: "Body", newText: "Body text" },
        ],
      });
      const { runtime } = scripted([{ text: mixed }]);
      const progress: TypstRepairProgress[] = [];
      const content = await runtime.translatePage(repairPage, signal, () => {}, (event) =>
        progress.push(event),
      );
      expect(content.typst).toBe(`${fixed} text`);
      expect(progress.at(-1)).toEqual({
        phase: "applied",
        replyAttempt: 1,
        change: { mode: "edits", count: 2 },
      });
    });

    test("reports no repair progress for a plain translation", async () => {
      const progress: TypstRepairProgress[] = [];
      await streaming(["= Title"]).translatePage(page, signal, () => {}, (event) =>
        progress.push(event),
      );
      expect(progress).toEqual([]);
    });

    test("discards a reply that finishes after the request was aborted", async () => {
      const controller = new AbortController();
      const reply = Promise.withResolvers<AssistantMessage>();
      // The stream has nothing left to yield; only its final message is still pending.
      const runtime = runtimeFor(() => ({
        async *[Symbol.asyncIterator]() {},
        result: () => reply.promise,
      }));
      const progress: TypstRepairProgress[] = [];
      const running = runtime.translatePage(repairPage, controller.signal, () => {}, (event) =>
        progress.push(event),
      );
      controller.abort();
      reply.resolve(assistant([{ type: "text", text: fix }]));

      await expect(running).rejects.toMatchObject({ code: "AI_REQUEST_FAILED" });
      expect(progress).toEqual([{ phase: "requesting", replyAttempt: 1 }]);
    });
  });
});

describe("outline extraction", () => {
  const input = {
    documentId: "a".repeat(64),
    pageNumber: 2,
    text: "1. Introduction\nBody",
    imageBase64: "/9j/AAAA",
    previousHeadings: [
      { title: "Preface", level: 1, pageNumber: 1 },
    ],
  };

  test("builds a JSON-only vision request with the previous headings", () => {
    const context = buildOutlineContext(input);
    const content = context.messages[0]!.content;
    expect(content).toContainEqual(
      expect.objectContaining({ type: "image", mimeType: "image/jpeg" }),
    );
    expect(content).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Preface (page 1, level 1)"),
      }),
    );
    expect(context.systemPrompt).toContain('"headings"');
    expect(context.systemPrompt).not.toContain("Target language");
  });

  test("accepts valid JSON and enforces level continuity", () => {
    expect(
      assembleOutlineHeadings(
        assistant([{ type: "text", text: '{"headings":[{"title":" Chapter 1 ","level":2}]}' }]),
        input.previousHeadings,
      ),
    ).toEqual([{ title: "Chapter 1", level: 2 }]);
    expect(() =>
      assembleOutlineHeadings(
        assistant([{ type: "text", text: '{"headings":[{"title":"Too deep","level":3}]}' }]),
        input.previousHeadings,
      ),
    ).toThrow(AiError);
    expect(() =>
      assembleOutlineHeadings(
        assistant([{ type: "text", text: '{"headings":[{"title":"Starts deep","level":2}]}' }]),
        [],
      ),
    ).toThrow(AiError);
  });

  test("rejects fences, invalid JSON, tools, truncation and empty text", () => {
    for (const content of [
      [{ type: "text" as const, text: '```json\n{"headings":[]}\n```' }],
      [{ type: "text" as const, text: '{"headings":' }],
      [{ type: "text" as const, text: "   " }],
      [{ type: "toolCall" as const, id: "1", name: "x", arguments: {} }],
    ]) {
      expect(() => assembleOutlineHeadings(assistant(content), [])).toThrow(AiError);
    }
    expect(() =>
      assembleOutlineHeadings(
        assistant([{ type: "text", text: '{"headings":[]}' }], "length"),
        [],
      ),
    ).toThrow(AiError);
  });

  test("extracts headings through the runtime with a synthetic provider stream", async () => {
    const message = assistant([
      { type: "text", text: '{"headings":[{"title":"Chapter 1","level":1}]}' },
    ]);
    const model = {
      id: "mock-vision",
      name: "mock",
      provider: "mock",
      api: "openai-completions",
      input: ["text", "image"],
      maxTokens: 4096,
    };
    let receivedContext: Context | undefined;
    const models = {
      getModel: () => model,
      getAuth: async () => ({ apiKey: "test" }),
      streamSimple: (_model: unknown, context: Context) => {
        receivedContext = context;
        return {
          async *[Symbol.asyncIterator]() {},
          result: async () => message,
        };
      },
    };
    const runtime = createAiRuntime(
      { provider: "mock", model: "mock-vision" },
      models as unknown as MutableModels,
    );

    await expect(
      runtime.extractOutlinePage(input, new AbortController().signal),
    ).resolves.toEqual([{ title: "Chapter 1", level: 1 }]);
    expect(receivedContext?.systemPrompt).toContain('"headings"');
  });
});
