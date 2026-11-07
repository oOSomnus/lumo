import { TranslationStreamError, type TranslationStreamResult } from "./api";
import {
  MAX_TYPST_DIAGNOSTICS_CHARS,
  TYPST_PREVIOUS_ATTEMPT_HEADING,
  translationContentSchema,
  type TargetLanguage,
  type TranslationContent,
  type TranslationContext,
  type TranslationRecord,
  type TypstRepair,
  type TypstRepairProgress,
} from "../shared/contracts";
import type { EpubLayoutSnapshot } from "../shared/epub";
import { splitTypstLines, stripPlaceholderControls } from "../shared/typst";

export type TranslationTaskStage =
  | "queued"
  | "preparing"
  | "generating"
  | "repairing"
  | "validating"
  | "saving"
  | "saved"
  | "error"
  | "unsaved"
  | "cancelled";

export type TranslationContextSide = "previous" | "next";

/** One compile-repair round of the current run; a run goes on for as many rounds as the compiler needs. */
export interface TypstRepairRound {
  /** 1-based position within the run. */
  round: number;
  /** Compiler diagnostics of the candidate this round asks the model to fix. */
  diagnostics: string;
  /** Visible reply progress, in order: at most two model replies per round. */
  events: TypstRepairProgress[];
  status:
    | "requesting"
    | "validating"
    | "compile-failed"
    | "compile-passed"
    | "rejected"
    | "request-failed"
    | "cancelled";
  /** The changed line range once a complete repaired candidate arrived. */
  change?: { startLine: number; before: string; after: string };
  /** Diagnostics from recompiling the repaired candidate. */
  resultDiagnostics?: string;
  error?: TranslationTask["error"];
}

export interface TranslationTask {
  key: string;
  documentId: string;
  pageNumber: number;
  targetLanguage: TargetLanguage;
  unit?: string;
  force: boolean;
  priority: "user" | "batch";
  attemptId: number;
  draftRevision: number;
  stage: TranslationTaskStage;
  preview: string;
  draft?: TranslationContent;
  saved?: TranslationRecord;
  cacheHit?: boolean;
  error?: {
    code: string;
    detail?: string;
    params?: Record<string, string | number>;
    /** The stage that failed; in memory only. */
    stage?: TranslationTaskStage;
  };
  repairRounds?: TypstRepairRound[];
  /** Local only, never sent to the server: the EPUB range, its frozen layout and page label. */
  sourceCfi?: string;
  epubLayout?: EpubLayoutSnapshot;
  epubPage?: { page: number; total: number };
  /** Neighbouring excerpts the last generation could not read. */
  contextWarnings?: TranslationContextSide[];
  enqueuedAt: number;
  updatedAt: number;
}

export interface EnqueueTranslation {
  documentId: string;
  pageNumber: number;
  targetLanguage: TargetLanguage;
  unit?: string;
  force?: boolean;
  priority?: "user" | "batch";
  sourceCfi?: string;
  epubLayout?: EpubLayoutSnapshot;
  epubPage?: { page: number; total: number };
}

export type PreparedTranslationPage =
  | {
      format: "pdf";
      text: string;
      imageBase64: string;
      context?: TranslationContext;
      contextWarnings?: TranslationContextSide[];
    }
  | {
      format: "epub";
      xhtml: string;
      images: { path: string; imageBase64: string }[];
      context?: TranslationContext;
      contextWarnings?: TranslationContextSide[];
    };

export interface EditTranslation {
  documentId: string;
  pageNumber: number;
  targetLanguage: TargetLanguage;
  unit?: string;
  content: TranslationContent;
  saved?: TranslationRecord;
  sourceCfi?: string;
  epubLayout?: EpubLayoutSnapshot;
  epubPage?: { page: number; total: number };
}

export interface TranslationStreamHooks {
  onDelta: (contentIndex: number, text: string) => void;
  onRepair: (progress: TypstRepairProgress) => void;
}

export interface TranslationExecutor {
  prepare(
    task: TranslationTask,
    signal: AbortSignal,
  ): Promise<PreparedTranslationPage>;
  translate(
    task: TranslationTask,
    prepared: PreparedTranslationPage,
    signal: AbortSignal,
    hooks: TranslationStreamHooks,
  ): Promise<TranslationStreamResult>;
  /** Asks for one repaired candidate from the source and its compiler diagnostics only. */
  repair(
    task: TranslationTask,
    repair: TypstRepair,
    signal: AbortSignal,
    hooks: TranslationStreamHooks,
  ): Promise<TranslationStreamResult>;
  /** Compiles the exact candidate that save will store; rejects with TYPST_COMPILE_FAILED diagnostics. */
  validate(
    task: TranslationTask,
    draft: TranslationContent,
    signal: AbortSignal,
  ): Promise<void>;
  save(
    task: TranslationTask,
    draft: TranslationContent,
    signal: AbortSignal,
  ): Promise<TranslationRecord>;
}

export interface QueueHalt {
  code: string;
  detail?: string;
  params?: Record<string, string | number>;
}

export function translationKey(
  documentId: string,
  pageNumber: number,
  targetLanguage: TargetLanguage,
  unit?: string,
): string {
  const base = `${documentId}/${pageNumber}/${targetLanguage}`;
  return unit ? `${base}/${unit}` : base;
}

const ACTIVE_STAGES: Partial<Record<TranslationTaskStage, true>> = {
  queued: true,
  preparing: true,
  generating: true,
  repairing: true,
  validating: true,
  saving: true,
};

/** True while the queue itself is working on the task. */
export function isActiveStage(stage: TranslationTaskStage): boolean {
  return ACTIVE_STAGES[stage] === true;
}

/** A complete candidate the queue keeps for the user: edited, failed or cancelled before it was saved. */
export function hasRetainedDraft<T extends Pick<TranslationTask, "stage" | "draft">>(
  task: T,
): task is T & { draft: TranslationContent } {
  return (
    task.draft !== undefined &&
    (task.stage === "unsaved" || task.stage === "cancelled")
  );
}

const HALTING_CODES: Record<string, true> = {
  STORAGE_BUSY: true,
  STORAGE_FULL: true,
  STORAGE_ERROR: true,
  LOCAL_ACCESS_REQUIRED: true,
  FORBIDDEN: true,
  DOCUMENT_NOT_FOUND: true,
  AI_NOT_CONFIGURED: true,
  AI_MODEL_UNSUPPORTED: true,
  AI_AUTH_FAILED: true,
  AI_CONFIG_INVALID: true,
};

const PREVIEW_FLUSH_MS = 100;

/** Repair rounds whose details stay on the task; older ones are dropped while the run goes on. */
const MAX_REPAIR_ROUND_DETAILS = 5;

/** Pause before asking again after consecutive replies that left the source as it was; the last delay repeats. */
const REPAIR_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

/** Resolves after `ms`, or rejects with the abort reason the moment `signal` aborts. */
export function waitForRepairRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}

function draftOf(error: unknown): TranslationContent | undefined {
  if (!error || typeof error !== "object" || !("draft" in error)) return undefined;
  const parsed = translationContentSchema.safeParse(error.draft);
  return parsed.success ? parsed.data : undefined;
}

function compileDiagnostics(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code !== "TYPST_COMPILE_FAILED" || typeof message !== "string") return undefined;
  const diagnostics = message.slice(0, MAX_TYPST_DIAGNOSTICS_CHARS);
  return diagnostics.trim() ? diagnostics : undefined;
}

function errorDetails(error: unknown): {
  code: string;
  detail?: string;
  params?: Record<string, string | number>;
} {
  if (error && typeof error === "object") {
    const candidate = error as {
      code?: unknown;
      message?: unknown;
      name?: unknown;
      params?: unknown;
    };
    if (candidate.name === "AbortError") {
      return { code: "ABORTED" };
    }
    const params =
      candidate.params && typeof candidate.params === "object"
        ? (candidate.params as Record<string, string | number>)
        : undefined;
    if (typeof candidate.code === "string") {
      return {
        code: candidate.code,
        ...(typeof candidate.message === "string" && candidate.message
          ? { detail: candidate.message }
          : {}),
        ...(params ? { params } : {}),
      };
    }
  }
  return {
    code: "TRANSLATION_FAILED",
    ...(error instanceof Error ? { detail: error.message } : {}),
  };
}

/** The queue's own copy of a candidate: control characters stripped, the input never mutated. */
function candidateOf(content: TranslationContent): TranslationContent {
  const typst = stripPlaceholderControls(content.typst);
  return typst === content.typst ? content : { ...content, typst };
}

/**
 * The single line range that covers every difference. Separate edits share one
 * range, which may hold unchanged lines between them.
 */
function changedTypstLines(
  before: string,
  after: string,
): NonNullable<TypstRepairRound["change"]> {
  const oldLines = splitTypstLines(before);
  const newLines = splitTypstLines(after);
  const shared = Math.min(oldLines.length, newLines.length);
  let start = 0;
  while (start < shared && oldLines[start] === newLines[start]) start += 1;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldLines[oldEnd - 1] === newLines[newEnd - 1]
  ) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  // Only the line-break form differs, so every line is equal: show both sources whole.
  if (start === oldEnd && start === newEnd) return { startLine: 1, before, after };
  return {
    startLine: start + 1,
    before: oldLines.slice(start, oldEnd).join("\n"),
    after: newLines.slice(start, newEnd).join("\n"),
  };
}

// Fixed caps keep the section far below the diagnostics limit it shares.
const MAX_FEEDBACK_SNIPPET_CHARS = 600;
const MAX_FEEDBACK_REASON_CHARS = 400;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Compiler messages and positions without the quoted source lines, which change with every edit. */
function diagnosticHeads(diagnostics: string): string {
  return diagnostics
    .split("\n")
    .filter((line) => !/^\d+ \| /.test(line))
    .join("\n");
}

/**
 * The repair request has no field for the model's earlier reply, so what that
 * reply did goes at the end of the diagnostics, under its own heading. Both
 * stay within the diagnostics limit: the compiler text gives way, never the section.
 */
function withPreviousAttempt(
  diagnostics: string,
  previous: TypstRepairRound | undefined,
): string {
  if (!previous) return diagnostics;
  const body = previous.change
    ? [
        `Your previous reply was applied. The changed range starts at line ${previous.change.startLine} of the source you received.`,
        `Before:\n${clip(previous.change.before, MAX_FEEDBACK_SNIPPET_CHARS)}`,
        `After:\n${clip(previous.change.after, MAX_FEEDBACK_SNIPPET_CHARS)}`,
        "The updated source still fails to compile; the diagnostics above are the compiler's result for it.",
        ...(diagnosticHeads(previous.diagnostics) === diagnosticHeads(diagnostics)
          ? [
              "The compiler reports the same messages at the same lines and columns as before that reply, so the change did not fix them: look for another cause instead of repeating or extending it.",
            ]
          : []),
      ].join("\n")
    : `Your previous reply was refused (${clip(previous.error?.detail ?? "it changed nothing", MAX_FEEDBACK_REASON_CHARS)}), so the source is unchanged and the diagnostics above are the same. Reply again with a valid change: replacements whose oldText is copied exactly from the source and whose newText differs, or the complete corrected document.`;
  const section = `\n\n${TYPST_PREVIOUS_ATTEMPT_HEADING}\n${body}`;
  return diagnostics.slice(0, MAX_TYPST_DIAGNOSTICS_CHARS - section.length) + section;
}

export interface TranslationQueueOptions {
  concurrency?: number;
  now?: () => number;
  /** Waits between repair requests; replaceable so tests need not wait in real time. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export class TranslationQueue {
  readonly #executor: TranslationExecutor;
  readonly #concurrency: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #tasks = new Map<string, TranslationTask>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #previewBlocks = new Map<string, Map<number, string>>();
  readonly #listeners = new Set<() => void>();
  #previewTimer: ReturnType<typeof setTimeout> | null = null;
  #sortedKeys: string[] | null = null;
  #halt: QueueHalt | null = null;

  constructor(executor: TranslationExecutor, options: TranslationQueueOptions = {}) {
    this.#executor = executor;
    this.#concurrency = options.concurrency ?? 3;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? waitForRepairRetry;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  getTasks(): TranslationTask[] {
    if (!this.#sortedKeys) {
      this.#sortedKeys = [...this.#tasks.values()]
        .sort(
          (a, b) =>
            a.pageNumber - b.pageNumber ||
            a.targetLanguage.localeCompare(b.targetLanguage),
        )
        .map((task) => task.key);
    }
    const tasks: TranslationTask[] = [];
    for (const key of this.#sortedKeys) {
      const task = this.#tasks.get(key);
      if (task) tasks.push({ ...task });
    }
    return tasks;
  }

  getTask(key: string): TranslationTask | undefined {
    const task = this.#tasks.get(key);
    return task ? { ...task } : undefined;
  }

  get halt(): QueueHalt | null {
    return this.#halt;
  }

  get activeCount(): number {
    return this.#controllers.size;
  }

  resume(): void {
    this.#halt = null;
    this.#notifyNow();
    this.#pump();
  }

  enqueue(input: EnqueueTranslation): TranslationTask {
    const key = translationKey(
      input.documentId,
      input.pageNumber,
      input.targetLanguage,
      input.unit,
    );
    const existing = this.#tasks.get(key);
    if (existing) {
      if (
        existing.stage === "saved" &&
        input.force &&
        !this.#controllers.has(key)
      ) {
        return this.#startNewAttempt(existing, input);
      }
      // A retained draft is only given up by discard(); a new request never drops it.
      if (
        (existing.stage === "error" || existing.stage === "cancelled") &&
        !existing.draft
      ) {
        return this.#startNewAttempt(existing, input);
      }
      return { ...existing };
    }

    const task: TranslationTask = {
      key,
      documentId: input.documentId,
      pageNumber: input.pageNumber,
      targetLanguage: input.targetLanguage,
      unit: input.unit,
      force: input.force ?? false,
      priority: input.priority ?? "user",
      attemptId: 1,
      draftRevision: 0,
      stage: "queued",
      preview: "",
      enqueuedAt: this.#now(),
      updatedAt: this.#now(),
      sourceCfi: input.sourceCfi,
      epubLayout: input.epubLayout,
      epubPage: input.epubPage,
    };
    this.#tasks.set(key, task);
    this.#sortedKeys = null;
    this.#notifyNow();
    this.#pump();
    return { ...task };
  }

  promote(key: string): void {
    const task = this.#tasks.get(key);
    if (!task || task.stage !== "queued") return;
    task.priority = "user";
    task.updatedAt = this.#now();
    this.#notifyNow();
    this.#pump();
  }

  /**
   * Stores an edited source as an unsaved draft without starting AI work.
   * Queued, preparing, generating and repairing tasks reject edits; validating
   * and saving tasks accept them and keep the newer draft, and its stage, when
   * the in-flight work completes.
   */
  edit(input: EditTranslation): void {
    const key = translationKey(
      input.documentId,
      input.pageNumber,
      input.targetLanguage,
      input.unit,
    );
    const existing = this.#tasks.get(key);
    if (existing) {
      if (
        existing.stage === "queued" ||
        existing.stage === "preparing" ||
        existing.stage === "generating" ||
        existing.stage === "repairing"
      ) {
        return;
      }
      existing.draft = input.content;
      existing.draftRevision += 1;
      if (!existing.saved && input.saved) existing.saved = input.saved;
      existing.sourceCfi = input.sourceCfi ?? existing.sourceCfi;
      existing.epubLayout = input.epubLayout ?? existing.epubLayout;
      existing.epubPage = input.epubPage ?? existing.epubPage;
      if (existing.stage !== "validating" && existing.stage !== "saving") {
        existing.stage = "unsaved";
      }
      existing.error = undefined;
      existing.repairRounds = undefined;
      existing.preview = "";
      existing.updatedAt = this.#now();
      this.#previewBlocks.delete(key);
      this.#notifyNow();
      return;
    }

    const task: TranslationTask = {
      key,
      documentId: input.documentId,
      pageNumber: input.pageNumber,
      targetLanguage: input.targetLanguage,
      unit: input.unit,
      force: false,
      priority: "user",
      attemptId: 1,
      draftRevision: 1,
      stage: "unsaved",
      preview: "",
      draft: input.content,
      saved: input.saved,
      sourceCfi: input.sourceCfi,
      epubLayout: input.epubLayout,
      epubPage: input.epubPage,
      enqueuedAt: this.#now(),
      updatedAt: this.#now(),
    };
    this.#tasks.set(key, task);
    this.#sortedKeys = null;
    this.#notifyNow();
  }

  cancel(key: string): void {
    const task = this.#tasks.get(key);
    if (!task) return;
    const controller = this.#controllers.get(key);
    if (controller) {
      // The request in flight is no longer this task's: a later edit or retry must not adopt its reply.
      task.attemptId += 1;
      task.stage = "cancelled";
      task.preview = "";
      this.#updateOpenRound(task, (round) => ({ ...round, status: "cancelled" }));
      this.#previewBlocks.delete(key);
      task.updatedAt = this.#now();
      this.#notifyNow();
      controller.abort(new DOMException("cancelled", "AbortError"));
    } else if (task.stage === "queued") {
      task.stage = "cancelled";
      task.preview = "";
      this.#previewBlocks.delete(key);
      task.updatedAt = this.#now();
      this.#notifyNow();
      this.#pump();
    }
  }

  cancelAll(): void {
    for (const key of this.#tasks.keys()) this.cancel(key);
  }

  cancelDocument(documentId: string): void {
    for (const [key, task] of [...this.#tasks]) {
      if (task.documentId !== documentId) continue;
      this.#controllers.get(key)?.abort(new DOMException("cancelled", "AbortError"));
      this.#tasks.delete(key);
      this.#previewBlocks.delete(key);
      this.#sortedKeys = null;
    }
    this.#notifyNow();
    this.#pump();
  }

  /** Retries a failed page from scratch, or validates and saves a retained draft without calling the model. */
  retry(key: string): void {
    const task = this.#tasks.get(key);
    if (!task) return;
    this.#halt = null;
    if (hasRetainedDraft(task)) {
      this.#retrySave(task);
      return;
    }
    if (task.stage === "error" || task.stage === "cancelled") {
      this.#startNewAttempt(task, {
        documentId: task.documentId,
        pageNumber: task.pageNumber,
        targetLanguage: task.targetLanguage,
        unit: task.unit,
        force: task.force,
        priority: "user",
        sourceCfi: task.sourceCfi,
        epubLayout: task.epubLayout,
        epubPage: task.epubPage,
      });
    }
  }

  /**
   * Starts a repair run on a retained draft: it is compiled first and, only
   * while the compiler rejects it, the model is asked for another repair, round
   * after round until the source compiles or the task is cancelled. The page is
   * never translated again.
   */
  repair(key: string): void {
    const task = this.#tasks.get(key);
    if (!task || !hasRetainedDraft(task) || this.#controllers.has(key)) return;
    this.#halt = null;
    task.attemptId += 1;
    task.priority = "user";
    task.stage = "queued";
    task.preview = "";
    task.error = undefined;
    task.repairRounds = undefined;
    task.enqueuedAt = this.#now();
    task.updatedAt = this.#now();
    this.#previewBlocks.delete(key);
    this.#notifyNow();
    this.#pump();
  }

  /** Explicitly gives up a retained draft; the previously saved translation stays. */
  discard(key: string): void {
    const found = this.#tasks.get(key);
    if (!found || !hasRetainedDraft(found)) return;
    // The guard narrows draft to defined; widen again to clear it.
    const task: TranslationTask = found;
    task.stage = "cancelled";
    task.draft = undefined;
    task.error = undefined;
    task.repairRounds = undefined;
    task.preview = "";
    this.#previewBlocks.delete(key);
    task.updatedAt = this.#now();
    this.#notifyNow();
  }

  releaseSavedText(key: string): void {
    const task = this.#tasks.get(key);
    if (!task?.saved || task.saved.typst === "") return;
    task.saved = { ...task.saved, typst: "" };
    this.#notifyNow();
  }

  #startNewAttempt(
    task: TranslationTask,
    input: EnqueueTranslation,
  ): TranslationTask {
    task.attemptId += 1;
    task.force = input.force ?? false;
    task.priority = input.priority ?? "user";
    task.stage = "queued";
    task.preview = "";
    task.draft = undefined;
    task.error = undefined;
    task.repairRounds = undefined;
    task.contextWarnings = undefined;
    task.sourceCfi = input.sourceCfi;
    task.epubLayout = input.epubLayout;
    task.epubPage = input.epubPage;
    task.cacheHit = undefined;
    task.enqueuedAt = this.#now();
    task.updatedAt = this.#now();
    this.#previewBlocks.delete(task.key);
    this.#notifyNow();
    this.#pump();
    return { ...task };
  }

  #notifyNow(): void {
    if (this.#previewTimer !== null) {
      clearTimeout(this.#previewTimer);
      this.#previewTimer = null;
    }
    this.#flushPreviews();
    this.#notify();
  }

  #flushPreviews(): void {
    for (const [key, blocks] of this.#previewBlocks) {
      const task = this.#tasks.get(key);
      if (!task) {
        this.#previewBlocks.delete(key);
        continue;
      }
      let text = "";
      for (const index of [...blocks.keys()].sort((a, b) => a - b)) {
        text += blocks.get(index);
      }
      task.preview = text;
    }
  }

  #schedulePreview(): void {
    if (this.#previewTimer !== null) return;
    this.#previewTimer = setTimeout(() => {
      this.#previewTimer = null;
      this.#flushPreviews();
      this.#notify();
    }, PREVIEW_FLUSH_MS);
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  #pump(): void {
    if (this.#halt) return;
    while (this.#controllers.size < this.#concurrency) {
      const next = this.#nextQueued();
      if (!next) return;
      this.#run(next);
    }
  }

  #nextQueued(): TranslationTask | null {
    let next: TranslationTask | null = null;
    for (const task of this.#tasks.values()) {
      if (task.stage !== "queued" || this.#controllers.has(task.key)) continue;
      if (next === null || this.#runsBefore(task, next)) next = task;
    }
    return next;
  }

  #runsBefore(a: TranslationTask, b: TranslationTask): boolean {
    const priority =
      (a.priority === "user" ? 0 : 1) - (b.priority === "user" ? 0 : 1);
    return (
      priority < 0 ||
      (priority === 0 &&
        (a.enqueuedAt < b.enqueuedAt ||
          (a.enqueuedAt === b.enqueuedAt && a.pageNumber < b.pageNumber)))
    );
  }

  #run(task: TranslationTask): void {
    const attemptId = task.attemptId;
    const controller = new AbortController();
    this.#controllers.set(task.key, controller);
    // An explicit repair starts from the retained candidate; it never translates the page again.
    const retained = task.draft;
    task.stage = retained ? "validating" : "preparing";
    task.updatedAt = this.#now();
    this.#notifyNow();

    void this.#guard(task, controller, attemptId, async () => {
      if (retained) {
        await this.#validateAndSave(
          task,
          retained,
          controller,
          attemptId,
          true,
        );
        return;
      }
      const prepared = await this.#executor.prepare(task, controller.signal);
      if (!this.#isCurrent(task, attemptId)) return;
      task.contextWarnings = prepared.contextWarnings?.length
        ? prepared.contextWarnings
        : undefined;
      task.stage = "generating";
      task.updatedAt = this.#now();
      this.#notifyNow();

      const result = await this.#executor.translate(
        task,
        prepared,
        controller.signal,
        this.#hooks(task, attemptId),
      );

      if (!this.#isCurrent(task, attemptId)) return;
      if (result.cacheHit) {
        task.stage = "saved";
        task.saved = result.translation;
        task.cacheHit = true;
        task.preview = "";
        task.draft = undefined;
        task.error = undefined;
        this.#previewBlocks.delete(task.key);
        return;
      }
      await this.#validateAndSave(
        task,
        result.content,
        controller,
        attemptId,
        true,
      );
    });
  }

  /** Validates and saves a retained draft without calling the model. */
  #retrySave(task: TranslationTask): void {
    if (!task.draft) return;
    task.attemptId += 1;
    const attemptId = task.attemptId;
    const draft = task.draft;
    const controller = new AbortController();
    this.#controllers.set(task.key, controller);
    task.stage = "validating";
    task.preview = "";
    task.error = undefined;
    this.#previewBlocks.delete(task.key);
    task.updatedAt = this.#now();
    this.#notifyNow();

    void this.#guard(task, controller, attemptId, () =>
      this.#validateAndSave(task, draft, controller, attemptId, false),
    );
  }

  /** Runs one queue operation and settles the task, the controller slot and the queue afterwards. */
  async #guard(
    task: TranslationTask,
    controller: AbortController,
    attemptId: number,
    work: () => Promise<void>,
  ): Promise<void> {
    try {
      await work();
    } catch (error) {
      if (!this.#isCurrent(task, attemptId)) return;
      if (controller.signal.aborted) {
        task.stage = "cancelled";
        task.preview = "";
        this.#previewBlocks.delete(task.key);
      } else {
        // The stage still names the step that failed; the code below overwrites it.
        const details = { ...errorDetails(error), stage: task.stage };
        const draft = draftOf(error) ?? task.draft;
        task.error = details;
        this.#updateOpenRound(task, (round) =>
          round.status === "requesting"
            ? { ...round, status: "request-failed", error: details }
            : round,
        );
        if (draft) {
          task.stage = "unsaved";
          task.draft = draft;
          task.draftRevision += 1;
          task.preview = "";
        } else {
          task.stage = "error";
          task.preview = "";
        }
        if (details.code in HALTING_CODES) {
          this.#halt = details;
        }
        this.#previewBlocks.delete(task.key);
      }
    } finally {
      if (this.#controllers.get(task.key) === controller) {
        this.#controllers.delete(task.key);
      }
      task.updatedAt = this.#now();
      this.#notifyNow();
      this.#pump();
    }
  }

  /**
   * Compiles the candidate and, only while the local compiler rejects it and
   * `repair` is set, asks the model for a repaired candidate and compiles that
   * one, round after round until it compiles or the task is cancelled. Whatever
   * passes is saved: the same stripped copy that was compiled. A reply the
   * server could not use leaves the source as it is and the next round says why.
   * Later edits stay in task.draft and win over every older result.
   */
  async #validateAndSave(
    task: TranslationTask,
    initial: TranslationContent,
    controller: AbortController,
    attemptId: number,
    repair: boolean,
  ): Promise<void> {
    let draft = candidateOf(initial);
    if (draft !== task.draft) {
      task.draft = draft;
      task.draftRevision += 1;
    }

    // The compiler's diagnostics of the draft while it fails; the next round asks the model to fix them.
    let rejected: string | undefined;
    // Consecutive repair replies that left the source as it was; a changed source starts the count over.
    let stalled = 0;

    for (;;) {
      if (rejected !== undefined) {
        const diagnostics = rejected;
        if (stalled > 0) {
          const delay = REPAIR_RETRY_DELAYS_MS[Math.min(stalled, REPAIR_RETRY_DELAYS_MS.length) - 1]!;
          await this.#sleep(delay, controller.signal);
          if (!this.#isCurrent(task, attemptId)) return;
        }
        const previous = task.repairRounds?.at(-1);
        const roundNumber = (previous?.round ?? 0) + 1;
        const opened: TypstRepairRound = {
          round: roundNumber,
          diagnostics,
          events: [],
          status: "requesting",
        };
        task.repairRounds = [...(task.repairRounds ?? []), opened].slice(-MAX_REPAIR_ROUND_DETAILS);
        task.stage = "repairing";
        task.updatedAt = this.#now();
        this.#notifyNow();
        let repaired: TranslationStreamResult;
        try {
          repaired = await this.#executor.repair(
            task,
            {
              typst: draft.typst,
              diagnostics: withPreviousAttempt(diagnostics, previous),
            },
            controller.signal,
            this.#hooks(task, attemptId, roundNumber),
          );
        } catch (failure) {
          if (!this.#isCurrent(task, attemptId)) return;
          const details = errorDetails(failure);
          if (details.code !== "INVALID_AI_OUTPUT") throw failure;
          this.#updateOpenRound(
            task,
            (open) => ({
              ...open,
              status: "rejected",
              error: { ...details, stage: "repairing" },
            }),
            roundNumber,
          );
          stalled += 1;
          continue;
        }
        if (!this.#isCurrent(task, attemptId)) return;
        if (repaired.cacheHit) {
          throw new TranslationStreamError(
            "INVALID_RESPONSE",
            "repair request returned a cached translation",
          );
        }
        const next = candidateOf(repaired.content);
        if (next.typst === draft.typst) {
          // Same source and diagnostics: nothing to compile, the next round says it changed nothing.
          this.#updateOpenRound(
            task,
            (open) => ({
              ...open,
              status: "compile-failed",
              resultDiagnostics: diagnostics,
            }),
            roundNumber,
          );
          stalled += 1;
          continue;
        }
        this.#updateOpenRound(
          task,
          (open) => ({
            ...open,
            status: "validating",
            change: changedTypstLines(draft.typst, next.typst),
          }),
          roundNumber,
        );
        task.draft = next;
        task.draftRevision += 1;
        draft = next;
        rejected = undefined;
        stalled = 0;
        continue;
      }
      const revision = task.draftRevision;
      task.stage = "validating";
      task.preview = "";
      task.updatedAt = this.#now();
      this.#previewBlocks.delete(task.key);
      this.#notifyNow();

      try {
        await this.#executor.validate(task, draft, controller.signal);
      } catch (error) {
        if (!this.#isCurrent(task, attemptId)) return;
        if (task.draft !== draft || task.draftRevision !== revision) {
          this.#keepNewerDraft(task);
          return;
        }
        const diagnostics = compileDiagnostics(error);
        this.#updateOpenRound(task, (round) =>
          diagnostics
            ? { ...round, status: "compile-failed", resultDiagnostics: diagnostics }
            : {
                ...round,
                status: "compile-failed",
                error: { ...errorDetails(error), stage: "validating" },
              },
        );
        // Only a candidate that the local compiler rejects earns another model call.
        if (!diagnostics || !repair) throw error;
        rejected = diagnostics;
        continue;
      }

      if (!this.#isCurrent(task, attemptId)) return;
      if (task.draft !== draft || task.draftRevision !== revision) {
        this.#keepNewerDraft(task);
        return;
      }
      this.#updateOpenRound(task, (round) => ({ ...round, status: "compile-passed" }));
      task.stage = "saving";
      task.updatedAt = this.#now();
      this.#notifyNow();

      const record = await this.#executor.save(task, draft, controller.signal);
      if (!this.#isCurrent(task, attemptId)) return;
      task.saved = record;
      task.cacheHit = false;
      if (task.draftRevision === revision && task.draft === draft) {
        task.stage = "saved";
        task.draft = undefined;
        task.error = undefined;
      } else {
        task.stage = "unsaved";
      }
      task.preview = "";
      this.#previewBlocks.delete(task.key);
      return;
    }
  }

  /** An edit arrived while an older candidate was compiling: keep the edit, unvalidated and unsaved. */
  #keepNewerDraft(task: TranslationTask): void {
    task.stage = "unsaved";
    task.preview = "";
    this.#previewBlocks.delete(task.key);
  }

  #hooks(task: TranslationTask, attemptId: number, round?: number) {
    return {
      onDelta: (contentIndex: number, text: string) => {
        if (!this.#isCurrent(task, attemptId)) return;
        let blocks = this.#previewBlocks.get(task.key);
        if (!blocks) {
          blocks = new Map();
          this.#previewBlocks.set(task.key, blocks);
        }
        blocks.set(contentIndex, (blocks.get(contentIndex) ?? "") + text);
        task.updatedAt = this.#now();
        this.#schedulePreview();
      },
      onRepair: (progress: TypstRepairProgress) => {
        if (round === undefined || !this.#isCurrent(task, attemptId)) return;
        const changed = this.#updateOpenRound(
          task,
          (open) =>
            open.status === "requesting"
              ? { ...open, events: [...open.events, progress] }
              : open,
          round,
        );
        if (!changed) return;
        task.updatedAt = this.#now();
        this.#notifyNow();
      },
    };
  }

  /** Replaces the newest repair round while it is still open; records stay immutable for snapshots. */
  #updateOpenRound(
    task: TranslationTask,
    update: (round: TypstRepairRound) => TypstRepairRound,
    round?: number,
  ): boolean {
    const rounds = task.repairRounds;
    const last = rounds?.at(-1);
    if (!rounds || !last) return false;
    if (last.status !== "requesting" && last.status !== "validating") return false;
    if (round !== undefined && last.round !== round) return false;
    task.repairRounds = [...rounds.slice(0, -1), update(last)];
    return true;
  }

  #isCurrent(task: TranslationTask, attemptId: number): boolean {
    return (
      this.#tasks.get(task.key) === task &&
      task.attemptId === attemptId &&
      task.stage !== "cancelled"
    );
  }
}
