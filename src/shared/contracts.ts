import { z } from "zod";
import {
  MAX_CONTEXT_IMAGE_BASE64_CHARS,
  MAX_PAGE_TEXT_CHARS,
  MAX_TRANSLATION_CONTEXT_CHARS,
} from "./limits";

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

export const documentFormatSchema = z.enum(["pdf", "epub"]);

export type DocumentFormat = z.infer<typeof documentFormatSchema>;

export const pageNumberSchema = z.number().int().safe().min(1);

export const documentNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !value.includes("\u0000"), "name must not contain NUL");

export const MAX_IMAGE_BASE64_CHARS = 6_000_000;
export const MAX_EPUB_CFI_CHARS = 4096;
export const MAX_TYPST_CHARS = 200_000;
export const MAX_TYPST_DIAGNOSTICS_CHARS = 16_000;
// Closes a repair request's diagnostics with what the previous reply did; the repair prompt names it.
export const TYPST_PREVIOUS_ATTEMPT_HEADING = "Previous repair attempt (not source):";
export const MAX_PROVIDER_CHARS = 1024;

function jpegBase64Schema(maxChars: number) {
  return z
    .string()
    .max(maxChars)
    .refine(
      (value) =>
        value.length % 4 === 0 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(value) &&
        value.startsWith("/9j/"),
      "imageBase64 must be base64-encoded JPEG data",
    );
}

export const translationUnitSchema = z
  .string()
  .max(128)
  .regex(/^[A-Za-z0-9_-]*$/, "unit must be letters, digits, underscores or dashes");

// An opaque EPUB range identifier; the iframe resolves it against the book.
export const epubCfiSchema = z
  .string()
  .max(MAX_EPUB_CFI_CHARS)
  .regex(/^epubcfi\(.+\)$/, "sourceCfi must be an EPUB CFI such as epubcfi(/6/4!/4/2,/1:0,/1:9)");

// `page-` or `sel-` plus the SHA-256 of the kind and sourceCfi (see shared/epub.ts).
export const epubUnitSchema = z
  .string()
  .regex(/^(?:page|sel)-[a-f0-9]{64}$/, "unit must be an EPUB page or selection identity");

const typstSourceSchema = z
  .string()
  .max(MAX_TYPST_CHARS)
  .refine((value) => value.trim().length > 0, "typst must not be empty");

const typstRepairSchema = z.strictObject({
  typst: typstSourceSchema,
  diagnostics: z.string().min(1).max(MAX_TYPST_DIAGNOSTICS_CHARS),
});

export type TypstRepair = z.infer<typeof typstRepairSchema>;

const translationReferenceSchema = z
  .strictObject({
    text: z.string().min(1).max(MAX_TRANSLATION_CONTEXT_CHARS).optional(),
    imageBase64: jpegBase64Schema(MAX_CONTEXT_IMAGE_BASE64_CHARS).optional(),
  })
  .refine(
    (value) => value.text !== undefined || value.imageBase64 !== undefined,
    "a reference needs text or an image",
  );

export type TranslationReference = z.infer<typeof translationReferenceSchema>;

// The end of the previous page and the start of the next one; an absent neighbour is omitted.
export const translationContextSchema = z.strictObject({
  previous: translationReferenceSchema.optional(),
  next: translationReferenceSchema.optional(),
});

export type TranslationContext = z.infer<typeof translationContextSchema>;

const translateIdentityFields = {
  documentId: documentIdSchema,
  pageNumber: pageNumberSchema,
  targetLanguage: targetLanguageSchema,
  force: z.boolean().default(false),
};

const pdfLocationFields = {
  ...translateIdentityFields,
  format: z.literal("pdf"),
  unit: translationUnitSchema.optional(),
};

// An EPUB unit is an on-screen range: sourceCfi is its position and unit its identity.
const epubLocationFields = {
  ...translateIdentityFields,
  format: z.literal("epub"),
  unit: epubUnitSchema,
  sourceCfi: epubCfiSchema,
};

const translatePdfPageInputSchema = z.strictObject({
  ...pdfLocationFields,
  text: z.string().max(MAX_PAGE_TEXT_CHARS),
  imageBase64: jpegBase64Schema(MAX_IMAGE_BASE64_CHARS),
  context: translationContextSchema.optional(),
});

export const EPUB_ASSET_PATH_PATTERN =
  /^assets\/[a-f0-9]{64}\.(png|jpg|gif|svg)$/;

const epubImageSchema = z.strictObject({
  path: z.string().regex(EPUB_ASSET_PATH_PATTERN, "invalid EPUB asset path"),
  imageBase64: jpegBase64Schema(MAX_IMAGE_BASE64_CHARS),
});

const translateEpubPageInputSchema = z
  .strictObject({
    ...epubLocationFields,
    xhtml: z.string().max(MAX_PAGE_TEXT_CHARS),
    images: z.array(epubImageSchema).max(256),
    context: translationContextSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const paths = new Set<string>();
    let total = 0;
    for (const [index, image] of value.images.entries()) {
      total += image.imageBase64.length;
      if (total > MAX_IMAGE_BASE64_CHARS) {
        ctx.addIssue({
          code: "custom",
          path: ["images", index],
          message: "image previews exceed the 6000000 character limit",
        });
        return;
      }
      if (paths.has(image.path)) {
        ctx.addIssue({
          code: "custom",
          path: ["images", index, "path"],
          message: "image paths must be unique",
        });
      }
      paths.add(image.path);
    }
  });

// A repair carries only the failing source and its diagnostics, never the original page.
const translatePdfRepairInputSchema = z.strictObject({
  ...pdfLocationFields,
  repair: typstRepairSchema,
});

const translateEpubRepairInputSchema = z.strictObject({
  ...epubLocationFields,
  repair: typstRepairSchema,
});

export const translatePageInputSchema = z.union([
  translatePdfPageInputSchema,
  translateEpubPageInputSchema,
  translatePdfRepairInputSchema,
  translateEpubRepairInputSchema,
]);

export type TranslatePageInput = z.infer<typeof translatePageInputSchema>;
export type TranslateRepairInput = Extract<TranslatePageInput, { repair: TypstRepair }>;
export type TranslateGenerationInput = Exclude<TranslatePageInput, TranslateRepairInput>;

export const translationContentSchema = z.strictObject({
  typst: typstSourceSchema,
  provider: z.string().min(1).max(MAX_PROVIDER_CHARS),
  model: z.string().min(1).max(MAX_PROVIDER_CHARS),
});

export type TranslationContent = z.infer<typeof translationContentSchema>;

// What the client saves: the generated content plus, for an EPUB unit, where it came from.
export const translationSaveInputSchema = translationContentSchema.extend({
  sourceCfi: epubCfiSchema.optional(),
});

export type TranslationSaveInput = z.infer<typeof translationSaveInputSchema>;

export const MAX_OUTLINE_ENTRIES = 10_000;
export const MAX_OUTLINE_HEADINGS_PER_PAGE = 128;
export const MAX_OUTLINE_PREVIOUS_HEADINGS = 32;
export const MAX_OUTLINE_TITLE_CHARS = 500;
export const MAX_OUTLINE_LEVEL = 10_000;

const outlineTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_OUTLINE_TITLE_CHARS)
  .refine((value) => !value.includes("\u0000"), "title must not contain NUL");

const outlineLevelSchema = z
  .number()
  .int()
  .safe()
  .min(1)
  .max(MAX_OUTLINE_LEVEL);

export const outlineHeadingSchema = z.strictObject({
  title: outlineTitleSchema,
  level: outlineLevelSchema,
});

export type OutlineHeading = z.infer<typeof outlineHeadingSchema>;

export const outlineEntrySchema = outlineHeadingSchema.extend({
  pageNumber: pageNumberSchema,
});

export type OutlineEntry = z.infer<typeof outlineEntrySchema>;

export const outlineEntriesSchema = z
  .array(outlineEntrySchema)
  .min(1)
  .max(MAX_OUTLINE_ENTRIES)
  .superRefine((entries, ctx) => {
    const first = entries[0];
    if (first && first.level !== 1) {
      ctx.addIssue({
        code: "custom",
        path: [0, "level"],
        message: "the first outline entry must start at level 1",
      });
    }
    for (let index = 1; index < entries.length; index += 1) {
      const previous = entries[index - 1]!;
      const entry = entries[index]!;
      if (entry.level > previous.level + 1) {
        ctx.addIssue({
          code: "custom",
          path: [index, "level"],
          message: "outline levels must not skip more than one level",
        });
      }
      if (entry.pageNumber < previous.pageNumber) {
        ctx.addIssue({
          code: "custom",
          path: [index, "pageNumber"],
          message: "outline page numbers must not decrease",
        });
      }
    }
  });

const outlinePageContentSchema = translatePdfPageInputSchema.pick({
  text: true,
  imageBase64: true,
});

export const outlinePageInputSchema = outlinePageContentSchema
  .extend({
    documentId: documentIdSchema,
    pageNumber: pageNumberSchema,
    previousHeadings: z
      .array(outlineEntrySchema)
      .max(MAX_OUTLINE_PREVIOUS_HEADINGS),
  })
  .refine(
    (value) =>
      value.previousHeadings.every(
        (heading) => heading.pageNumber <= value.pageNumber,
      ),
    "previous headings must not be after the current page",
  );

export type OutlinePageInput = z.infer<typeof outlinePageInputSchema>;

export const outlinePageResultSchema = z.strictObject({
  headings: z.array(outlineHeadingSchema).max(MAX_OUTLINE_HEADINGS_PER_PAGE),
});

export type OutlinePageResult = z.infer<typeof outlinePageResultSchema>;

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

export const pdfReaderViewSchema = z.strictObject({
  format: z.literal("pdf"),
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

export type PdfReaderView = z.infer<typeof pdfReaderViewSchema>;

export const EPUB_FONT_SIZE_MIN = 12;
export const EPUB_FONT_SIZE_MAX = 36;
export const EPUB_FONT_SIZE_STEP = 2;
export const EPUB_FONT_FAMILIES = ["serif", "sans-serif"] as const;
export const EPUB_LINE_HEIGHTS = [1.4, 1.6, 1.8, 2] as const;
export const EPUB_THEMES = ["light", "sepia", "dark"] as const;

export const epubReaderViewSchema = z.strictObject({
  format: z.literal("epub"),
  cfi: z.string().min(1).max(MAX_EPUB_CFI_CHARS).nullable(),
  fontSize: z.number().int().min(EPUB_FONT_SIZE_MIN).max(EPUB_FONT_SIZE_MAX),
  fontFamily: z.enum(EPUB_FONT_FAMILIES),
  lineHeight: z.union([
    z.literal(1.4),
    z.literal(1.6),
    z.literal(1.8),
    z.literal(2),
  ]),
  theme: z.enum(EPUB_THEMES),
});

export type EpubReaderView = z.infer<typeof epubReaderViewSchema>;

export const readerViewSchema = z.discriminatedUnion("format", [
  pdfReaderViewSchema,
  epubReaderViewSchema,
]);

export type ReaderView = z.infer<typeof readerViewSchema>;

export const DEFAULT_PDF_READER_VIEW: PdfReaderView = {
  format: "pdf",
  scaleValue: "page-fit",
  rotation: 0,
  scrollMode: 3,
  spreadMode: 0,
};

export const DEFAULT_EPUB_READER_VIEW: EpubReaderView = {
  format: "epub",
  cfi: null,
  fontSize: 18,
  fontFamily: "serif",
  lineHeight: 1.6,
  theme: "light",
};

export interface DocumentRecord {
  id: string;
  name: string;
  size: number;
  pageCount: number;
  currentPage: number;
  createdAt: number;
  lastOpenedAt: number;
  format: DocumentFormat;
}

export interface ReaderSettings {
  lastDocumentId: string | null;
  targetLanguage: TargetLanguage;
}

export interface TranslationRecord {
  documentId: string;
  pageNumber: number;
  targetLanguage: TargetLanguage;
  unit?: string;
  /** The EPUB range this unit was translated from; absent for PDF pages. */
  sourceCfi?: string;
  typst: string;
  provider: string;
  model: string;
  translatedAt: number;
}

/** Where a translation lives, without its Typst source. `unit` is "" for a PDF page. */
export interface TranslationLocationSummary {
  pageNumber: number;
  unit: string;
  sourceCfi?: string;
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
  pageCount: z.coerce.number().int().safe().min(1).optional(),
  format: documentFormatSchema,
});

export type DocumentUploadQuery = z.infer<typeof DOCUMENT_UPLOAD_QUERY_SCHEMA>;

export const translationRecordSchema = z.strictObject({
  documentId: documentIdSchema,
  pageNumber: pageNumberSchema,
  targetLanguage: targetLanguageSchema,
  unit: translationUnitSchema.optional(),
  sourceCfi: epubCfiSchema.optional(),
  typst: z.string().max(MAX_TYPST_CHARS),
  provider: z.string(),
  model: z.string(),
  translatedAt: z.number().int(),
});

export const typstRepairChangeSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("edits"),
    count: z.number().int().safe().min(1),
  }),
  z.strictObject({ mode: z.literal("rewrite") }),
]);

export type TypstRepairChange = z.infer<typeof typstRepairChangeSchema>;

// A compile round may take up to two model replies; this is the reply's ordinal.
const typstRepairReplyAttemptSchema = z.union([z.literal(1), z.literal(2)]);

export const typstRepairProgressSchema = z.discriminatedUnion("phase", [
  z.strictObject({
    phase: z.literal("requesting"),
    replyAttempt: typstRepairReplyAttemptSchema,
  }),
  z.strictObject({
    phase: z.literal("rejected"),
    replyAttempt: typstRepairReplyAttemptSchema,
    error: z.strictObject({
      code: z.literal("INVALID_AI_OUTPUT"),
      message: z.string().min(1).max(MAX_TYPST_DIAGNOSTICS_CHARS),
    }),
  }),
  z.strictObject({
    phase: z.literal("applied"),
    replyAttempt: typstRepairReplyAttemptSchema,
    change: typstRepairChangeSchema,
  }),
]);

export type TypstRepairProgress = z.infer<typeof typstRepairProgressSchema>;

export const translateStreamEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("start") }),
  z.strictObject({
    type: z.literal("delta"),
    contentIndex: z.number().int().min(0),
    text: z.string(),
  }),
  z.strictObject({
    type: z.literal("repair"),
    progress: typstRepairProgressSchema,
  }),
  z.strictObject({
    type: z.literal("generated"),
    content: translationContentSchema,
  }),
  z.strictObject({
    type: z.literal("cached"),
    translation: translationRecordSchema,
  }),
  z.strictObject({
    type: z.literal("error"),
    error: z.strictObject({ code: z.string(), message: z.string() }),
    draft: translationContentSchema.optional(),
  }),
]);

export type TranslateStreamEvent = z.infer<typeof translateStreamEventSchema>;
