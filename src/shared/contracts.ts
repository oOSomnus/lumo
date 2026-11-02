import { z } from "zod";

export const TARGET_LANGUAGES = [
  "zh-CN",
  "zh-TW",
  "en",
  "ja",
  "ko",
  "de",
  "fr",
  "es",
] as const;

export type TargetLanguage = (typeof TARGET_LANGUAGES)[number];

export const TARGET_LANGUAGE_LABELS: Record<TargetLanguage, string> = {
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  en: "English",
  ja: "日本語",
  ko: "한국어",
  de: "Deutsch",
  fr: "Français",
  es: "Español",
};

export const targetLanguageSchema = z.enum(TARGET_LANGUAGES);

export const UI_LOCALES = ["en", "zh-CN"] as const;

export type UiLocale = (typeof UI_LOCALES)[number];

export const uiLocaleSchema = z.enum(UI_LOCALES);

export const documentIdSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "documentId must be a lowercase SHA-256 hex digest");

export const pageNumberSchema = z.number().int().safe().min(1);

export const documentNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !value.includes("\u0000"), "name must not contain NUL");

export const MAX_PAGE_TEXT_CHARS = 100_000;
export const MAX_IMAGE_BASE64_CHARS = 6_000_000;
export const MAX_MARKDOWN_CHARS = 200_000;
export const MAX_PROVIDER_CHARS = 1024;

const jpegBase64Schema = z
  .string()
  .max(MAX_IMAGE_BASE64_CHARS)
  .refine(
    (value) =>
      value.length % 4 === 0 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(value) &&
      value.startsWith("/9j/"),
    "imageBase64 must be base64-encoded JPEG data",
  );

export const translatePageInputSchema = z
  .strictObject({
    documentId: documentIdSchema,
    pageNumber: pageNumberSchema,
    targetLanguage: targetLanguageSchema,
    text: z.string().max(MAX_PAGE_TEXT_CHARS),
    imageBase64: jpegBase64Schema,
    force: z.boolean().default(false),
  });

export type TranslatePageInput = z.infer<typeof translatePageInputSchema>;

export const translationContentSchema = z.strictObject({
  markdown: z
    .string()
    .max(MAX_MARKDOWN_CHARS)
    .refine((value) => value.trim().length > 0, "markdown must not be empty"),
  provider: z.string().min(1).max(MAX_PROVIDER_CHARS),
  model: z.string().min(1).max(MAX_PROVIDER_CHARS),
});

export type TranslationContent = z.infer<typeof translationContentSchema>;

export const readerUpdateSchema = z
  .strictObject({
    documentId: documentIdSchema.nullable(),
    pageNumber: pageNumberSchema.nullable(),
    targetLanguage: targetLanguageSchema,
  })
  .refine(
    (value) =>
      (value.documentId === null) === (value.pageNumber === null),
    "documentId and pageNumber must both be set or both be null",
  );

export type ReaderUpdate = z.infer<typeof readerUpdateSchema>;

const READER_VIEW_PRESETS = [
  "auto",
  "page-actual",
  "page-width",
  "page-height",
  "page-fit",
] as const;

const readerViewScaleSchema = z
  .string()
  .max(32)
  .refine((value) => {
    if ((READER_VIEW_PRESETS as readonly string[]).includes(value)) return true;
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) return false;
    const scale = Number(value);
    return scale >= 0.1 && scale <= 25;
  }, "scaleValue must be a PDF.js zoom preset or a scale between 0.1 and 25");

export const readerViewSchema = z.strictObject({
  scaleValue: readerViewScaleSchema,
  rotation: z.union([
    z.literal(0),
    z.literal(90),
    z.literal(180),
    z.literal(270),
  ]),
  scrollMode: z.union([
    z.literal(0),
    z.literal(1),
    z.literal(2),
    z.literal(3),
  ]),
  spreadMode: z.union([z.literal(0), z.literal(1), z.literal(2)]),
});

export type ReaderView = z.infer<typeof readerViewSchema>;

export const DEFAULT_READER_VIEW: ReaderView = {
  scaleValue: "page-fit",
  rotation: 0,
  scrollMode: 3,
  spreadMode: 0,
};

export interface DocumentRecord {
  id: string;
  name: string;
  size: number;
  pageCount: number;
  currentPage: number;
  createdAt: number;
  lastOpenedAt: number;
}

export interface ReaderSettings {
  lastDocumentId: string | null;
  targetLanguage: TargetLanguage;
}

export interface TranslationRecord {
  documentId: string;
  pageNumber: number;
  targetLanguage: TargetLanguage;
  markdown: string;
  provider: string;
  model: string;
  translatedAt: number;
}

export interface LibrarySnapshot {
  documents: DocumentRecord[];
  settings: ReaderSettings;
  dataDirectory: string;
  uiLocale: UiLocale;
}

export const MAX_AI_PROVIDER_CHARS = 1024;
export const MAX_AI_BASE_URL_CHARS = 4096;

export const AI_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type AiReasoningEffort = (typeof AI_REASONING_EFFORTS)[number];

const httpUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_AI_BASE_URL_CHARS)
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "baseUrl must be an absolute URL" });
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      ctx.addIssue({ code: "custom", message: "baseUrl must use HTTP or HTTPS" });
    }
    if (url.username || url.password) {
      ctx.addIssue({ code: "custom", message: "baseUrl must not contain credentials" });
    }
    if (url.search || url.hash || value.includes("?") || value.includes("#")) {
      ctx.addIssue({ code: "custom", message: "baseUrl must not contain a query or fragment" });
    }
  });

export const aiConfigSchema = z
  .strictObject({
    provider: z.string().trim().min(1).max(MAX_AI_PROVIDER_CHARS),
    model: z.string().trim().min(1).max(MAX_AI_PROVIDER_CHARS),
    baseUrl: httpUrlSchema.optional(),
    contextWindow: z.number().int().safe().positive().optional(),
    maxTokens: z.number().int().safe().positive().optional(),
    reasoningEffort: z.enum(AI_REASONING_EFFORTS).optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.contextWindow !== undefined &&
      value.maxTokens !== undefined &&
      value.maxTokens > value.contextWindow
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["maxTokens"],
        message: "maxTokens must not exceed contextWindow",
      });
    }
    if (value.provider === "custom") {
      if (value.baseUrl === undefined) {
        ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "baseUrl is required" });
      }
      if (value.contextWindow === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["contextWindow"],
          message: "contextWindow is required",
        });
      }
      if (value.maxTokens === undefined) {
        ctx.addIssue({ code: "custom", path: ["maxTokens"], message: "maxTokens is required" });
      }
      return;
    }
    if (value.contextWindow !== undefined || value.maxTokens !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["contextWindow"],
        message: "contextWindow and maxTokens are only valid for custom endpoints",
      });
    }
  });

export type AiConfig = z.infer<typeof aiConfigSchema>;

export type AiCredentialKind = "api_key" | "oauth";

export interface AiSettingsSnapshot {
  config: AiConfig | null;
  status: { configured: boolean; code?: string };
}

export interface AiProviderOption {
  id: string;
  name: string;
  authMethods: AiCredentialKind[];
  credentialType: AiCredentialKind | null;
  canRefreshModels: boolean;
}

export interface AiModelOption {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoningEfforts: AiReasoningEffort[];
}

export interface AiCatalog {
  providers: AiProviderOption[];
  provider: string | null;
  models: AiModelOption[];
}

const aiLoginPromptSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("text"),
    message: z.string(),
    placeholder: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("secret"),
    message: z.string(),
    placeholder: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("select"),
    message: z.string(),
    options: z.array(
      z.strictObject({
        id: z.string(),
        label: z.string(),
        description: z.string().optional(),
      }),
    ),
  }),
  z.strictObject({
    type: z.literal("manual_code"),
    message: z.string(),
    placeholder: z.string().optional(),
  }),
]);

const aiLoginNotificationSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("info"),
    message: z.string(),
    links: z
      .array(z.strictObject({ url: z.string(), label: z.string().optional() }))
      .optional(),
  }),
  z.strictObject({
    type: z.literal("auth_url"),
    url: z.string(),
    instructions: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("device_code"),
    userCode: z.string(),
    verificationUri: z.string(),
    intervalSeconds: z.number().optional(),
    expiresInSeconds: z.number().optional(),
  }),
  z.strictObject({ type: z.literal("progress"), message: z.string() }),
]);

export const aiLoginEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("session"), sessionId: z.string() }),
  z.strictObject({
    type: z.literal("prompt"),
    promptId: z.string(),
    prompt: aiLoginPromptSchema,
  }),
  z.strictObject({
    type: z.literal("prompt_cancelled"),
    promptId: z.string(),
  }),
  z.strictObject({
    type: z.literal("notification"),
    event: aiLoginNotificationSchema,
  }),
  z.strictObject({
    type: z.literal("done"),
    provider: z.string(),
    credentialType: z.enum(["api_key", "oauth"]),
  }),
  z.strictObject({
    type: z.literal("error"),
    error: z.strictObject({ code: z.string(), message: z.string() }),
  }),
  z.strictObject({ type: z.literal("cancelled") }),
]);

export type AiLoginEvent = z.infer<typeof aiLoginEventSchema>;

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export const DOCUMENT_UPLOAD_QUERY_SCHEMA = z.strictObject({
  name: documentNameSchema,
  pageCount: z.coerce.number().int().safe().min(1),
});

export type DocumentUploadQuery = z.infer<typeof DOCUMENT_UPLOAD_QUERY_SCHEMA>;

export const translateStreamEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("start") }),
  z.strictObject({
    type: z.literal("delta"),
    contentIndex: z.number().int().min(0),
    text: z.string(),
  }),
  z.strictObject({ type: z.literal("saving") }),
  z.strictObject({
    type: z.literal("done"),
    translation: z.strictObject({
      documentId: documentIdSchema,
      pageNumber: pageNumberSchema,
      targetLanguage: targetLanguageSchema,
      markdown: z.string(),
      provider: z.string(),
      model: z.string(),
      translatedAt: z.number().int(),
    }),
    cacheHit: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("error"),
    error: z.strictObject({ code: z.string(), message: z.string() }),
    draft: translationContentSchema.optional(),
  }),
]);

export type TranslateStreamEvent = z.infer<typeof translateStreamEventSchema>;
