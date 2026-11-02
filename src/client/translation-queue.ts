import {
  translationContentSchema,
  type TargetLanguage,
  type TranslationContent,
  type TranslationRecord,
} from "../shared/contracts";

export type TranslationTaskStage =
  | "queued"
  | "preparing"
  | "generating"
  | "saving"
  | "saved"
  | "error"
  | "unsaved"
  | "cancelled";

export interface TranslationTask {
  key: string;
  documentId: string;
  pageNumber: number;
  targetLanguage: TargetLanguage;
  force: boolean;
  priority: "user" | "batch";
  attemptId: number;
  stage: TranslationTaskStage;
  preview: string;
  draft?: TranslationContent;
  saved?: TranslationRecord;
  cacheHit?: boolean;
  error?: {
    code: string;
    detail?: string;
    params?: Record<string, string | number>;
  };
  enqueuedAt: number;
  updatedAt: number;
}

export interface EnqueueTranslation {
  documentId: string;
  pageNumber: number;
  targetLanguage: TargetLanguage;
  force?: boolean;
  priority?: "user" | "batch";
}

export interface TranslationExecutor {
  prepare(
    task: TranslationTask,
    signal: AbortSignal,
  ): Promise<{ text: string; imageBase64: string }>;
  translate(
    task: TranslationTask,
    prepared: { text: string; imageBase64: string },
    signal: AbortSignal,
    hooks: {
      onDelta: (contentIndex: number, text: string) => void;
      onSaving: () => void;
    },
  ): Promise<{ translation: TranslationRecord; cacheHit: boolean }>;
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
): string {
  return `${documentId}/${pageNumber}/${targetLanguage}`;
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

function draftOf(error: unknown): TranslationContent | undefined {
  if (!error || typeof error !== "object" || !("draft" in error)) return undefined;
  const parsed = translationContentSchema.safeParse(error.draft);
  return parsed.success ? parsed.data : undefined;
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

export class TranslationQueue {
  readonly #executor: TranslationExecutor;
  readonly #concurrency: number;
  readonly #now: () => number;
  readonly #tasks = new Map<string, TranslationTask>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #previewBlocks = new Map<string, Map<number, string>>();
  readonly #listeners = new Set<() => void>();
  #previewTimer: ReturnType<typeof setTimeout> | null = null;
  #sortedKeys: string[] | null = null;
  #halt: QueueHalt | null = null;

  constructor(
    executor: TranslationExecutor,
    options: { concurrency?: number; now?: () => number } = {},
  ) {
    this.#executor = executor;
    this.#concurrency = options.concurrency ?? 3;
    this.#now = options.now ?? Date.now;
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
      if (existing.stage === "error" || existing.stage === "cancelled") {
        return this.#startNewAttempt(existing, input);
      }
      return { ...existing };
    }

    const task: TranslationTask = {
      key,
      documentId: input.documentId,
      pageNumber: input.pageNumber,
      targetLanguage: input.targetLanguage,
      force: input.force ?? false,
      priority: input.priority ?? "user",
      attemptId: 1,
      stage: "queued",
      preview: "",
      enqueuedAt: this.#now(),
      updatedAt: this.#now(),
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

  cancel(key: string): void {
    const task = this.#tasks.get(key);
    if (!task) return;
    const controller = this.#controllers.get(key);
    if (controller) {
      task.stage = "cancelled";
      task.preview = "";
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

  /** Retries a failed/cancelled AI task, or retries only the save of an unsaved draft. */
  retry(key: string): void {
    const task = this.#tasks.get(key);
    if (!task) return;
    this.#halt = null;
    if (task.stage === "unsaved" && task.draft) {
      this.#retrySave(task);
      return;
    }
    if (task.stage === "error" || task.stage === "cancelled") {
      if (task.draft) {
        this.#retrySave(task);
        return;
      }
      this.#startNewAttempt(task, {
        documentId: task.documentId,
        pageNumber: task.pageNumber,
        targetLanguage: task.targetLanguage,
        force: task.force,
        priority: "user",
      });
    }
  }

  /** Explicitly give up a draft that could not be saved. */
  discard(key: string): void {
    const task = this.#tasks.get(key);
    if (!task || task.stage !== "unsaved") return;
    task.stage = "cancelled";
    task.draft = undefined;
    task.preview = "";
    this.#previewBlocks.delete(key);
    task.updatedAt = this.#now();
    this.#notifyNow();
  }

  releaseSavedText(key: string): void {
    const task = this.#tasks.get(key);
    if (!task?.saved || task.saved.markdown === "") return;
    task.saved = { ...task.saved, markdown: "" };
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
    task.saved = undefined;
    task.error = undefined;
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
    task.stage = "preparing";
    task.updatedAt = this.#now();
    this.#notifyNow();

    void (async () => {
      try {
        const prepared = await this.#executor.prepare(task, controller.signal);
        if (!this.#isCurrent(task, attemptId)) return;
        task.stage = "generating";
        task.updatedAt = this.#now();
        this.#notifyNow();

        const result = await this.#executor.translate(
          task,
          prepared,
          controller.signal,
          {
          onDelta: (contentIndex, text) => {
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
          onSaving: () => {
            if (!this.#isCurrent(task, attemptId)) return;
            task.stage = "saving";
            task.updatedAt = this.#now();
            this.#notifyNow();
          },
          },
        );

        if (!this.#isCurrent(task, attemptId)) return;
        task.stage = "saved";
        task.saved = result.translation;
        task.cacheHit = result.cacheHit;
        task.preview = "";
        task.draft = undefined;
        task.error = undefined;
        this.#previewBlocks.delete(task.key);
      } catch (error) {
        if (!this.#isCurrent(task, attemptId)) return;
        if (controller.signal.aborted) {
          task.stage = "cancelled";
          task.preview = "";
          this.#previewBlocks.delete(task.key);
        } else {
          const details = errorDetails(error);
          const draft = draftOf(error);
          task.error = details;
          if (draft) {
            task.stage = "unsaved";
            task.draft = draft;
            task.preview = "";
          } else {
            task.stage = "error";
            task.preview = "";
          }
          if (details.code in HALTING_CODES) {
            this.#halt = details;
          }
        }
        this.#previewBlocks.delete(task.key);
      } finally {
        if (this.#controllers.get(task.key) === controller) {
          this.#controllers.delete(task.key);
        }
        task.updatedAt = this.#now();
        this.#notifyNow();
        this.#pump();
      }
    })();
  }

  #retrySave(task: TranslationTask): void {
    if (!task.draft) return;
    const attemptId = task.attemptId;
    const draft = task.draft;
    const controller = new AbortController();
    this.#controllers.set(task.key, controller);
    task.stage = "saving";
    task.preview = "";
    task.error = undefined;
    this.#previewBlocks.delete(task.key);
    task.updatedAt = this.#now();
    this.#notifyNow();

    void (async () => {
      try {
        const record = await this.#executor.save(task, draft, controller.signal);
        if (!this.#isCurrent(task, attemptId)) return;
        task.stage = "saved";
        task.saved = record;
        task.preview = "";
        task.draft = undefined;
        task.error = undefined;
      } catch (error) {
        if (!this.#isCurrent(task, attemptId)) return;
        const details = errorDetails(error);
        task.error = details;
        task.stage = "unsaved";
        if (details.code in HALTING_CODES) {
          this.#halt = details;
        }
      } finally {
        if (this.#controllers.get(task.key) === controller) {
          this.#controllers.delete(task.key);
        }
        task.updatedAt = this.#now();
        this.#notifyNow();
        this.#pump();
      }
    })();
  }

  #isCurrent(task: TranslationTask, attemptId: number): boolean {
    return (
      this.#tasks.get(task.key) === task &&
      task.attemptId === attemptId &&
      task.stage !== "cancelled"
    );
  }
}
