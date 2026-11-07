import { afterEach, describe, expect, test } from "bun:test";
import {
  MAX_TYPST_DIAGNOSTICS_CHARS,
  TYPST_PREVIOUS_ATTEMPT_HEADING,
  type TranslationContent,
  type TranslationRecord,
  type TypstRepair,
  type TypstRepairProgress,
} from "../shared/contracts";
import type { TranslationStreamResult } from "./api";
import {
  TranslationQueue,
  translationKey,
  waitForRepairRetry,
  type EnqueueTranslation,
  type PreparedTranslationPage,
  type TranslationExecutor,
  type TranslationQueueOptions,
  type TranslationTask,
} from "./translation-queue";

function content(typst: string): TranslationContent {
  return { typst, provider: "mock", model: "vision" };
}

function record(task: TranslationTask, typst = `# page ${task.pageNumber}`): TranslationRecord {
  return {
    documentId: task.documentId,
    pageNumber: task.pageNumber,
    targetLanguage: task.targetLanguage,
    unit: task.unit,
    ...content(typst),
    translatedAt: 1,
  };
}

type TranslateCall = {
  task: TranslationTask;
  hooks: {
    onDelta: (contentIndex: number, text: string) => void;
    onRepair: (progress: TypstRepairProgress) => void;
  };
  repair?: TypstRepair;
  resolve: (record: TranslationRecord, cacheHit?: boolean) => void;
  reject: (error: unknown) => void;
};

type ValidateCall = {
  task: TranslationTask;
  draft: TranslationContent;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type SaveCall = {
  task: TranslationTask;
  draft: TranslationContent;
  resolve: (record: TranslationRecord) => void;
  reject: (error: unknown) => void;
};

class ControlledExecutor implements TranslationExecutor {
  readonly translateCalls: TranslateCall[] = [];
  readonly validateDrafts: string[] = [];
  readonly pendingValidations: ValidateCall[] = [];
  readonly saveCalls: string[] = [];
  readonly saveDrafts: string[] = [];
  readonly pendingSaves: SaveCall[] = [];
  prepareCalls = 0;
  cacheHit = false;
  failPrepare: unknown | null = null;
  failTranslate: unknown | null = null;
  failValidate: unknown | null = null;
  failValidateFor: ((typst: string) => unknown) | null = null;
  failSave: unknown | null = null;
  deferValidate = false;
  deferSave = false;
  autoResolve = false;
  ignoreAbort = false;
  prepareWarnings: ("previous" | "next")[] = [];

  prepare = async (task: TranslationTask, _signal: AbortSignal) => {
    this.prepareCalls += 1;
    if (this.failPrepare) throw this.failPrepare;
    return {
      format: "pdf" as const,
      text: `page ${task.pageNumber}`,
      imageBase64: "/9j/AAAA",
      contextWarnings: this.prepareWarnings,
    };
  };

  translate = (
    task: TranslationTask,
    _prepared: PreparedTranslationPage,
    signal: AbortSignal,
    hooks: TranslateCall["hooks"],
  ) => this.#request(task, signal, hooks);

  repair = (
    task: TranslationTask,
    repair: TypstRepair,
    signal: AbortSignal,
    hooks: TranslateCall["hooks"],
  ) => this.#request(task, signal, hooks, repair);

  #request(
    task: TranslationTask,
    signal: AbortSignal,
    hooks: TranslateCall["hooks"],
    repair?: TypstRepair,
  ) {
    const { promise, resolve, reject } = Promise.withResolvers<TranslationStreamResult>();
    if (this.failTranslate) {
      reject(this.failTranslate);
      return promise;
    }
    const call: TranslateCall = {
      task,
      hooks,
      repair,
      resolve: (translation, cacheHit = this.cacheHit) =>
        resolve(
          cacheHit
            ? { cacheHit: true, translation }
            : { cacheHit: false, content: content(translation.typst) },
        ),
      reject,
    };
    this.translateCalls.push(call);
    if (this.autoResolve) call.resolve(record(task), this.cacheHit);
    if (!this.ignoreAbort) {
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("cancelled", "AbortError")),
        { once: true },
      );
    }
    return promise;
  }

  validate = (task: TranslationTask, draft: TranslationContent, _signal: AbortSignal) => {
    this.validateDrafts.push(draft.typst);
    const failure = this.failValidate ?? this.failValidateFor?.(draft.typst);
    if (failure) return Promise.reject(failure);
    if (!this.deferValidate) return Promise.resolve();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.pendingValidations.push({ task, draft, resolve, reject });
    return promise;
  };

  save = (task: TranslationTask, draft: TranslationContent, _signal: AbortSignal) => {
    this.saveCalls.push(task.key);
    this.saveDrafts.push(draft.typst);
    if (this.failSave) return Promise.reject(this.failSave);
    if (!this.deferSave) return Promise.resolve(record(task, draft.typst));
    const { promise, resolve, reject } = Promise.withResolvers<TranslationRecord>();
    this.pendingSaves.push({ task, draft, resolve, reject });
    return promise;
  };

  latest(): TranslateCall {
    const call = this.translateCalls.at(-1);
    if (!call) throw new Error("no translate call yet");
    return call;
  }

  resolveAll(): void {
    for (const call of this.translateCalls) call.resolve(record(call.task));
  }
}

function waitFor(queue: TranslationQueue, predicate: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (!predicate()) return;
      unsubscribe();
      resolve();
    };
    const unsubscribe = queue.subscribe(() => queueMicrotask(check));
    queueMicrotask(check);
  });
}

async function drain(queue: TranslationQueue, executor: ControlledExecutor): Promise<void> {
  executor.autoResolve = true;
  executor.resolveAll();
  await waitFor(queue, () =>
    queue.getTasks().every((task) => task.stage === "saved"),
  );
}

function enqueue(
  documentId: string,
  pageNumber: number,
  priority: "user" | "batch" = "batch",
  force = false,
): EnqueueTranslation {
  return { documentId, pageNumber, targetLanguage: "en", priority, force };
}

function compileError(message: string): { code: string; message: string } {
  return { code: "TYPST_COMPILE_FAILED", message };
}

/** A model-retry pause that ends at once, for tests that do not look at the pauses. */
const noPause = async (): Promise<void> => undefined;

/** Starts page a/1 and answers its first model call with `typst`. */
async function generate(
  executor: ControlledExecutor,
  typst: string,
  options: TranslationQueueOptions = {},
): Promise<string> {
  queue = new TranslationQueue(executor, { concurrency: 1, sleep: noPause, ...options });
  queue.enqueue(enqueue("a", 1));
  await waitFor(queue, () => executor.translateCalls.length === 1);
  executor.latest().resolve(record(executor.latest().task, typst));
  return translationKey("a", 1, "en");
}

/** Lets continuations of already-resolved promises run, without a wall-clock wait. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
}

/** Runs pending promise continuations until `done()` holds, and fails instead of hanging if it never does. */
async function untilSettled(done: () => boolean): Promise<void> {
  for (let tick = 0; tick < 1_000 && !done(); tick += 1) await Promise.resolve();
  expect(done()).toBe(true);
}

/** A stand-in for the real timer: each wait is recorded and ends when the test releases it or its signal aborts. */
function controlledSleep() {
  const waits: { ms: number; release: () => void }[] = [];
  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      waits.push({ ms, release: resolve });
    });
  return { waits, sleep };
}

let queue: TranslationQueue | null = null;

afterEach(() => {
  queue?.cancelAll();
  queue = null;
});

describe("TranslationQueue", () => {
  test("runs user work before older queued batch pages", async () => {
    const executor = new ControlledExecutor();
    queue = new TranslationQueue(executor, { concurrency: 1 });
    queue.enqueue(enqueue("a", 1));
    queue.enqueue(enqueue("a", 2));
    await waitFor(queue, () => executor.translateCalls.length === 1);
    queue.enqueue(enqueue("a", 3));
    queue.enqueue(enqueue("a", 4, "user"));

    executor.latest().resolve(record(executor.latest().task));
    await waitFor(queue, () => executor.translateCalls.length === 2);
    expect(executor.translateCalls[1]!.task.pageNumber).toBe(4);

    await drain(queue, executor);
    expect(queue.getTasks().map((task) => task.pageNumber)).toEqual([1, 2, 3, 4]);
  });

  test("never exceeds the configured concurrency", async () => {
    const executor = new ControlledExecutor();
    queue = new TranslationQueue(executor, { concurrency: 2 });
    for (let page = 1; page <= 4; page++) queue.enqueue(enqueue("a", page));

    await waitFor(queue, () => executor.translateCalls.length === 2);
    expect(queue.activeCount).toBe(2);
    await Promise.resolve();
    expect(executor.translateCalls.length).toBe(2);

    executor.latest().resolve(record(executor.latest().task));
    await waitFor(queue, () => executor.translateCalls.length === 3);
    expect(queue.activeCount).toBe(2);
    await drain(queue, executor);
  });

  test("reuses a saved translation unless force is set", async () => {
    const executor = new ControlledExecutor();
    executor.cacheHit = true;
    queue = new TranslationQueue(executor, { concurrency: 1 });
    queue.enqueue(enqueue("a", 1));
    await waitFor(queue, () => executor.translateCalls.length === 1);
    executor.latest().resolve(record(executor.latest().task), true);
    await waitFor(queue, () => queue!.getTask(translationKey("a", 1, "en"))?.stage === "saved");
    expect(queue.getTask(translationKey("a", 1, "en"))?.cacheHit).toBe(true);

    queue.enqueue(enqueue("a", 1));
    await Promise.resolve();
    expect(executor.translateCalls).toHaveLength(1);

    queue.enqueue(enqueue("a", 1, "user", true));
    await waitFor(queue, () => executor.translateCalls.length === 2);
    await drain(queue, executor);
    expect(executor.translateCalls).toHaveLength(2);
  });

  test("enqueuing a page that is already in flight, forced or not, starts nothing and keeps its attempt", async () => {
    const executor = new ControlledExecutor();
    executor.deferValidate = true;
    executor.deferSave = true;
    queue = new TranslationQueue(executor, { concurrency: 1 });
    const key = translationKey("a", 1, "en");
    queue.enqueue(enqueue("a", 1));
    await waitFor(queue, () => executor.translateCalls.length === 1);

    const stages: string[] = [];
    const again = () => {
      queue!.enqueue(enqueue("a", 1, "user", true));
      queue!.enqueue(enqueue("a", 1));
      stages.push(queue!.getTask(key)!.stage);
    };
    again();
    executor.latest().resolve(record(executor.latest().task, "= one"));
    await waitFor(queue, () => executor.pendingValidations.length === 1);
    again();
    executor.pendingValidations[0]!.resolve();
    await waitFor(queue, () => executor.pendingSaves.length === 1);
    again();
    executor.pendingSaves[0]!.resolve(record(queue.getTask(key)!, "= one"));
    await waitFor(queue, () => queue!.getTask(key)?.stage === "saved");

    expect(stages).toEqual(["generating", "validating", "saving"]);
    expect(executor.translateCalls).toHaveLength(1);
    expect(executor.prepareCalls).toBe(1);
    expect(executor.saveDrafts).toEqual(["= one"]);
    expect(queue.getTasks()).toHaveLength(1);
    expect(queue.getTask(key)?.attemptId).toBe(1);
  });

  test("cancellation aborts the active request and frees a slot", async () => {
    const executor = new ControlledExecutor();
    queue = new TranslationQueue(executor, { concurrency: 1 });
    const key = translationKey("a", 1, "en");
    queue.enqueue(enqueue("a", 1));
    await waitFor(queue, () => executor.translateCalls.length === 1);

    queue.cancel(key);
    await waitFor(queue, () => queue!.getTask(key)?.stage === "cancelled");
    expect(queue.activeCount).toBe(0);
  });

  test("ignores a late response from an attempt the user replaced", async () => {
    const executor = new ControlledExecutor();
    executor.ignoreAbort = true;
    queue = new TranslationQueue(executor, { concurrency: 1 });
    const key = translationKey("a", 1, "en");
    queue.enqueue(enqueue("a", 1));
    await waitFor(queue, () => executor.translateCalls.length === 1);

    const oldCall = executor.translateCalls[0]!;
    queue.cancel(key);
    await waitFor(queue, () => queue!.getTask(key)?.stage === "cancelled");
    queue.retry(key);
    oldCall.resolve(record(oldCall.task, "# stale"));
    await waitFor(queue, () => executor.translateCalls.length === 2);
    expect(queue.getTask(key)?.stage).not.toBe("saved");
    expect(queue.getTask(key)?.saved).toBeUndefined();

    executor.translateCalls[1]!.resolve(record(executor.translateCalls[1]!.task, "# fresh"));
    await waitFor(queue, () => queue!.getTask(key)?.stage === "saved");
    expect(queue.getTask(key)?.saved?.typst).toBe("# fresh");
  });

  test("keeps a draft on a storage failure and retries only the save", async () => {
    const executor = new ControlledExecutor();
    queue = new TranslationQueue(executor, { concurrency: 1 });
    executor.failTranslate = {
      code: "STORAGE_BUSY",
      message: "database is locked",
      draft: content("# draft"),
    };
    const key = translationKey("a", 1, "en");
    queue.enqueue(enqueue("a", 1));
    await waitFor(queue, () => queue!.getTask(key)?.stage === "unsaved");

    expect(queue.getTask(key)?.draft?.typst).toBe("# draft");
    expect(queue.halt?.code).toBe("STORAGE_BUSY");

    executor.failTranslate = null;
    queue.retry(key);
    await waitFor(queue, () => queue!.getTask(key)?.stage === "saved");
    expect(executor.saveCalls).toEqual([key]);
    expect(queue.getTask(key)?.saved?.typst).toBe("# draft");
    expect(queue.halt).toBeNull();
  });

  test("retrying a failed page starts a new attempt", async () => {
    const executor = new ControlledExecutor();
    queue = new TranslationQueue(executor, { concurrency: 1 });
    executor.failTranslate = { code: "AI_REQUEST_FAILED", message: "provider failed" };
    const key = translationKey("a", 1, "en");
    queue.enqueue(enqueue("a", 1));
    await waitFor(queue, () => queue!.getTask(key)?.stage === "error");

    executor.failTranslate = null;
    executor.autoResolve = true;
    queue.retry(key);
    await waitFor(queue, () => queue!.getTask(key)?.stage === "saved");
    expect(queue.getTask(key)?.attemptId).toBe(2);
  });

  test("halts queued work after a storage failure until resumed", async () => {
    const executor = new ControlledExecutor();
    queue = new TranslationQueue(executor, { concurrency: 1 });
    executor.failTranslate = {
      code: "STORAGE_FULL",
      message: "disk full",
      draft: content("# draft"),
    };
    queue.enqueue(enqueue("a", 1));
    queue.enqueue(enqueue("a", 2));
    await waitFor(queue, () => queue!.getTask(translationKey("a", 1, "en"))?.stage === "unsaved");
    expect(queue.getTask(translationKey("a", 2, "en"))?.stage).toBe("queued");
    expect(executor.translateCalls).toHaveLength(0);
    expect(queue.halt?.code).toBe("STORAGE_FULL");

    executor.failTranslate = null;
    queue.resume();
    await waitFor(queue, () => executor.translateCalls.length === 1);
    executor.resolveAll();
    await waitFor(queue, () => queue!.getTask(translationKey("a", 2, "en"))?.stage === "saved");
  });

  test("discarding a draft clears it without saving", async () => {
    const executor = new ControlledExecutor();
    queue = new TranslationQueue(executor, { concurrency: 1 });
    executor.failTranslate = {
      code: "STORAGE_BUSY",
      message: "database is locked",
      draft: content("# draft"),
    };
    const key = translationKey("a", 1, "en");
    queue.enqueue(enqueue("a", 1));
    await waitFor(queue, () => queue!.getTask(key)?.stage === "unsaved");

    queue.discard(key);
    expect(queue.getTask(key)).toMatchObject({ stage: "cancelled", draft: undefined, preview: "" });
    expect(executor.saveCalls).toEqual([]);
  });

  test("drops only the deleted document's tasks", async () => {
    const executor = new ControlledExecutor();
    queue = new TranslationQueue(executor, { concurrency: 2 });
    queue.enqueue(enqueue("a", 1));
    queue.enqueue(enqueue("b", 1));
    await waitFor(queue, () => executor.translateCalls.length === 2);

    queue.cancelDocument("a");
    await waitFor(queue, () => queue!.getTask(translationKey("a", 1, "en")) === undefined);
    expect(queue.getTask(translationKey("b", 1, "en"))?.stage).toBe("generating");

    executor.autoResolve = true;
    executor.resolveAll();
    await waitFor(queue, () => queue!.getTask(translationKey("b", 1, "en"))?.stage === "saved");
  });

  test("promotes a queued batch task when its page becomes active", async () => {
    const executor = new ControlledExecutor();
    queue = new TranslationQueue(executor, { concurrency: 1 });
    queue.enqueue(enqueue("a", 1));
    queue.enqueue(enqueue("a", 2));
    queue.enqueue(enqueue("a", 3));
    await waitFor(queue, () => executor.translateCalls.length === 1);
    queue.promote(translationKey("a", 3, "en"));

    executor.latest().resolve(record(executor.latest().task));
    await waitFor(queue, () => executor.translateCalls.length === 2);
    expect(executor.translateCalls[1]!.task.pageNumber).toBe(3);
    executor.autoResolve = true;
    executor.resolveAll();
  });
  test("publishes content-ordered previews without losing the tail", async () => {
    const executor = new ControlledExecutor();
    queue = new TranslationQueue(executor, { concurrency: 1 });
    const key = translationKey("a", 1, "en");
    queue.enqueue(enqueue("a", 1));
    await waitFor(queue, () => executor.translateCalls.length === 1);

    const { hooks } = executor.latest();
    hooks.onDelta(1, "B");
    hooks.onDelta(0, "A");
    hooks.onDelta(1, "C");
    hooks.onDelta(2, "!");
    await waitFor(queue, () => queue!.getTask(key)?.preview === "ABC!");
    expect(queue.getTask(key)?.stage).toBe("generating");

    executor.latest().resolve(record(executor.latest().task));
    await waitFor(queue, () => queue!.getTask(key)?.stage === "saved");
  });

  test("never publishes a pending preview after terminal completion", async () => {
    const executor = new ControlledExecutor();
    queue = new TranslationQueue(executor, { concurrency: 1 });
    const key = translationKey("a", 1, "en");
    queue.enqueue(enqueue("a", 1));
    await waitFor(queue, () => executor.translateCalls.length === 1);

    executor.latest().hooks.onDelta(0, "stale");
    executor.latest().resolve(record(executor.latest().task));
    await waitFor(queue, () => queue!.getTask(key)?.stage === "saved");
    expect(queue.getTask(key)?.preview).toBe("");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(queue.getTask(key)?.preview).toBe("");
  });

  test("does not leak an old attempt preview into a retry", async () => {
    const executor = new ControlledExecutor();
    executor.ignoreAbort = true;
    queue = new TranslationQueue(executor, { concurrency: 1 });
    const key = translationKey("a", 1, "en");
    queue.enqueue(enqueue("a", 1));
    await waitFor(queue, () => executor.translateCalls.length === 1);
    const oldCall = executor.latest();
    oldCall.hooks.onDelta(0, "old");

    queue.cancel(key);
    await waitFor(queue, () => queue!.getTask(key)?.stage === "cancelled");
    expect(queue.getTask(key)?.preview).toBe("");
    queue.retry(key);
    oldCall.hooks.onDelta(0, "stale");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(queue.getTask(key)?.preview).toBe("");

    oldCall.resolve(record(oldCall.task));
    await waitFor(queue, () => executor.translateCalls.length === 2);
    expect(queue.getTask(key)?.preview).toBe("");

    executor.latest().hooks.onDelta(0, "fresh");
    await waitFor(queue, () => queue!.getTask(key)?.preview === "fresh");
    executor.latest().resolve(record(executor.latest().task));
    await waitFor(queue, () => queue!.getTask(key)?.stage === "saved");
  });

  test("keeps the generated draft when compiling fails and retries without regenerating", async () => {
    const executor = new ControlledExecutor();
    queue = new TranslationQueue(executor, { concurrency: 1 });
    const key = translationKey("a", 1, "en");
    executor.autoResolve = true;
    queue.enqueue(enqueue("a", 1));
    await waitFor(queue, () => queue!.getTask(key)?.stage === "saved");

    executor.autoResolve = false;
    executor.failValidate = {
      code: "TYPST_COMPILE_TIMEOUT",
      message: "timed out",
    };
    queue.enqueue(enqueue("a", 1, "user", true));
    await waitFor(queue, () => executor.translateCalls.length === 2);
    executor.translateCalls[1]!.resolve(record(executor.translateCalls[1]!.task, "= new"));
    await waitFor(queue, () => queue!.getTask(key)?.stage === "unsaved");

    expect(queue.getTask(key)?.draft?.typst).toBe("= new");
    expect(queue.getTask(key)?.saved?.typst).toBe("# page 1");
    expect(queue.getTask(key)?.error).toMatchObject({
      code: "TYPST_COMPILE_TIMEOUT",
      stage: "validating",
    });
    expect(executor.saveDrafts).toEqual(["# page 1"]);

    executor.failValidate = null;
    queue.retry(key);
    await waitFor(queue, () => queue!.getTask(key)?.stage === "saved");
    expect(executor.translateCalls).toHaveLength(2);
    expect(executor.saveDrafts.at(-1)).toBe("= new");
    expect(queue.getTask(key)?.saved?.typst).toBe("= new");
  });

  test("validates and saves the same control-free copy and leaves the edited input untouched", async () => {
    const executor = new ControlledExecutor();
    queue = new TranslationQueue(executor, { concurrency: 1 });
    const key = translationKey("a", 1, "en");
    const typed = content("= a\u0000b\u0007");
    queue.edit({ documentId: "a", pageNumber: 1, targetLanguage: "en", content: typed });

    queue.retry(key);
    await waitFor(queue, () => queue!.getTask(key)?.stage === "saved");

    expect(executor.validateDrafts).toEqual(["= ab"]);
    expect(executor.saveDrafts).toEqual(["= ab"]);
    expect(queue.getTask(key)?.saved?.typst).toBe("= ab");
    expect(typed.typst).toBe("= a\u0000b\u0007");
  });

  describe("Typst repair", () => {
    const requesting = (replyAttempt: 1 | 2): TypstRepairProgress => ({
      phase: "requesting",
      replyAttempt,
    });
    const applied = (replyAttempt: 1 | 2, count = 1): TypstRepairProgress => ({
      phase: "applied",
      replyAttempt,
      change: { mode: "edits", count },
    });

    test("repairs a compile failure with its diagnostics and saves only the repaired source", async () => {
      const executor = new ControlledExecutor();
      executor.failValidateFor = (typst) =>
        typst === "= broken" ? compileError("unclosed delimiter") : null;
      const key = await generate(executor, "= broken");

      await waitFor(queue!, () => executor.translateCalls.length === 2);
      expect(queue!.getTask(key)).toMatchObject({
        stage: "repairing",
        draft: { typst: "= broken" },
        preview: "",
      });
      expect(queue!.getTask(key)?.repairRounds).toEqual([
        { round: 1, diagnostics: "unclosed delimiter", events: [], status: "requesting" },
      ]);
      expect(executor.translateCalls[1]!.repair).toEqual({
        typst: "= broken",
        diagnostics: "unclosed delimiter",
      });
      expect(executor.validateDrafts).toEqual(["= broken"]);
      expect(executor.saveDrafts).toEqual([]);

      const { hooks } = executor.latest();
      hooks.onRepair(requesting(1));
      hooks.onRepair(applied(1, 2));
      executor.latest().resolve(record(executor.latest().task, "= fixed"));
      await waitFor(queue!, () => queue!.getTask(key)?.stage === "saved");

      expect(executor.validateDrafts).toEqual(["= broken", "= fixed"]);
      expect(executor.saveDrafts).toEqual(["= fixed"]);
      expect(queue!.getTask(key)).toMatchObject({
        saved: { typst: "= fixed" },
        draft: undefined,
        error: undefined,
      });
      expect(queue!.getTask(key)?.repairRounds).toEqual([
        {
          round: 1,
          diagnostics: "unclosed delimiter",
          events: [requesting(1), applied(1, 2)],
          status: "compile-passed",
          change: { startLine: 1, before: "= broken", after: "= fixed" },
        },
      ]);
    });

    test("feeds each round the latest candidate and its diagnostics, and resets the preview", async () => {
      const executor = new ControlledExecutor();
      executor.failValidateFor = (typst) =>
        typst === "= v3" ? null : compileError(`bad ${typst}`);
      const key = await generate(executor, "= v1");

      await waitFor(queue!, () => executor.translateCalls.length === 2);
      executor.latest().hooks.onDelta(0, "= v2");
      await waitFor(queue!, () => queue!.getTask(key)?.preview === "= v2");
      executor.latest().resolve(record(executor.latest().task, "= v2"));

      await waitFor(queue!, () => executor.translateCalls.length === 3);
      expect(queue!.getTask(key)).toMatchObject({ stage: "repairing", preview: "" });
      executor.latest().hooks.onDelta(0, "= v");
      await waitFor(queue!, () => queue!.getTask(key)?.preview === "= v");
      executor.latest().resolve(record(executor.latest().task, "= v3"));
      await waitFor(queue!, () => queue!.getTask(key)?.stage === "saved");

      const [, first, second] = executor.translateCalls.map((call) => call.repair);
      expect(first).toEqual({ typst: "= v1", diagnostics: "bad = v1" });
      expect(second?.typst).toBe("= v2");
      // The newest diagnostics stay first and intact; what the previous reply did follows them.
      expect(second?.diagnostics.startsWith("bad = v2\n\n")).toBe(true);
      const section = second!.diagnostics.slice(
        second!.diagnostics.indexOf(TYPST_PREVIOUS_ATTEMPT_HEADING),
      );
      expect(section).toContain("= v1");
      expect(section).toContain("= v2");
      expect(queue!.getTask(key)?.saved?.typst).toBe("= v3");
      expect(queue!.getTask(key)?.repairRounds).toMatchObject([
        {
          round: 1,
          diagnostics: "bad = v1",
          status: "compile-failed",
          resultDiagnostics: "bad = v2",
          change: { before: "= v1", after: "= v2" },
        },
        {
          round: 2,
          diagnostics: "bad = v2",
          status: "compile-passed",
          change: { before: "= v2", after: "= v3" },
        },
      ]);
    });

    test("a run stopped by a failed request keeps the last candidate; retry only revalidates, repair continues from it", async () => {
      const executor = new ControlledExecutor();
      queue = new TranslationQueue(executor, { concurrency: 1 });
      const key = translationKey("a", 1, "en");
      executor.autoResolve = true;
      queue.enqueue(enqueue("a", 1));
      await waitFor(queue, () => queue!.getTask(key)?.stage === "saved");

      executor.autoResolve = false;
      executor.failValidateFor = (typst) => compileError(`bad ${typst}`);
      queue.enqueue(enqueue("a", 1, "user", true));
      for (const [typst, calls] of [["= v1", 2], ["= v2", 3], ["= v3", 4]] as const) {
        await waitFor(queue, () => executor.translateCalls.length === calls);
        executor.latest().resolve(record(executor.latest().task, typst));
      }
      await waitFor(queue, () => executor.translateCalls.length === 5);
      executor.latest().reject({ code: "AI_REQUEST_FAILED", message: "provider failed" });
      await waitFor(queue, () => queue!.getTask(key)?.stage === "unsaved");

      expect(executor.validateDrafts.slice(1)).toEqual(["= v1", "= v2", "= v3"]);
      expect(executor.saveDrafts).toEqual(["# page 1"]);
      const stopped = queue.getTask(key)!;
      expect(stopped).toMatchObject({
        draft: { typst: "= v3" },
        saved: { typst: "# page 1" },
        error: { code: "AI_REQUEST_FAILED", detail: "provider failed", stage: "repairing" },
      });
      expect(stopped.repairRounds).toMatchObject([
        { round: 1, status: "compile-failed", resultDiagnostics: "bad = v2" },
        { round: 2, status: "compile-failed", resultDiagnostics: "bad = v3" },
        { round: 3, status: "request-failed" },
      ]);

      queue.retry(key);
      await waitFor(
        queue,
        () => executor.validateDrafts.length === 5 && queue!.getTask(key)?.stage === "unsaved",
      );
      expect(executor.translateCalls).toHaveLength(5);
      expect(queue.getTask(key)?.repairRounds).toEqual(stopped.repairRounds);

      queue.repair(key);
      await waitFor(queue, () => executor.translateCalls.length === 6);
      expect(executor.latest().repair).toEqual({ typst: "= v3", diagnostics: "bad = v3" });
      expect(executor.prepareCalls).toBe(2);
      expect(queue.getTask(key)?.repairRounds).toEqual([
        { round: 1, diagnostics: "bad = v3", events: [], status: "requesting" },
      ]);
    });

    test("keeps repairing for as many rounds as the compiler needs, retaining the details of the last five", async () => {
      const executor = new ControlledExecutor();
      executor.failValidateFor = (typst) =>
        typst === "= fixed" ? null : compileError(`bad ${typst}`);
      const key = await generate(executor, "= v1");

      for (let call = 2; call <= 9; call += 1) {
        await waitFor(queue!, () => executor.translateCalls.length === call);
        executor.latest().resolve(record(executor.latest().task, call === 9 ? "= fixed" : `= v${call}`));
      }
      await waitFor(queue!, () => queue!.getTask(key)?.stage === "saved");

      expect(executor.translateCalls).toHaveLength(9);
      expect(executor.prepareCalls).toBe(1);
      expect(executor.saveDrafts).toEqual(["= fixed"]);
      expect(queue!.getTask(key)?.repairRounds?.map((round) => [round.round, round.status])).toEqual([
        [4, "compile-failed"],
        [5, "compile-failed"],
        [6, "compile-failed"],
        [7, "compile-failed"],
        [8, "compile-passed"],
      ]);
    });

    describe("pauses before asking again when a reply gave the model nothing new to work with", () => {
      const refused = { code: "INVALID_AI_OUTPUT", message: "Typst repair makes no change" };

      async function stuck() {
        const executor = new ControlledExecutor();
        executor.failValidateFor = (typst) =>
          typst === "= fixed" ? null : compileError(`bad ${typst}`);
        const { waits, sleep } = controlledSleep();
        const key = await generate(executor, "= v1", { sleep });
        await waitFor(queue!, () => executor.translateCalls.length === 2);
        return { executor, waits, key };
      }

      test("grow from one second to thirty and stay there", async () => {
        const { executor, waits, key } = await stuck();

        for (let reply = 1; reply <= 7; reply += 1) {
          await waitFor(queue!, () => executor.translateCalls.length === reply + 1);
          executor.latest().reject(refused);
          await untilSettled(() => waits.length === reply);
          expect(executor.translateCalls).toHaveLength(reply + 1);
          waits[reply - 1]!.release();
        }
        await waitFor(queue!, () => executor.translateCalls.length === 9);
        executor.latest().resolve(record(executor.latest().task, "= fixed"));
        await waitFor(queue!, () => queue!.getTask(key)?.stage === "saved");

        expect(waits.map((wait) => wait.ms)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
      });

      test("start over once a reply changes the source", async () => {
        const { executor, waits, key } = await stuck();
        executor.latest().reject(refused);
        await untilSettled(() => waits.length === 1);
        waits[0]!.release();

        await waitFor(queue!, () => executor.translateCalls.length === 3);
        executor.latest().resolve(record(executor.latest().task, "= v2"));
        // A changed source is progress: the next request goes out at once.
        await waitFor(queue!, () => executor.translateCalls.length === 4);
        expect(waits).toHaveLength(1);

        executor.latest().reject(refused);
        await untilSettled(() => waits.length === 2);
        waits[1]!.release();
        await waitFor(queue!, () => executor.translateCalls.length === 5);
        executor.latest().resolve(record(executor.latest().task, "= fixed"));
        await waitFor(queue!, () => queue!.getTask(key)?.stage === "saved");

        expect(waits.map((wait) => wait.ms)).toEqual([1_000, 1_000]);
      });

      test("count a reply that changes nothing like a refused one", async () => {
        const { executor, waits, key } = await stuck();
        executor.latest().resolve(record(executor.latest().task, "= v1"));
        await untilSettled(() => waits.length === 1);
        waits[0]!.release();

        await waitFor(queue!, () => executor.translateCalls.length === 3);
        executor.latest().reject(refused);
        await untilSettled(() => waits.length === 2);
        waits[1]!.release();
        await waitFor(queue!, () => executor.translateCalls.length === 4);
        executor.latest().resolve(record(executor.latest().task, "= fixed"));
        await waitFor(queue!, () => queue!.getTask(key)?.stage === "saved");

        expect(waits.map((wait) => wait.ms)).toEqual([1_000, 2_000]);
        expect(executor.validateDrafts).toEqual(["= v1", "= fixed"]);
      });

      test("end when the user stops the run, with no further request and the draft kept", async () => {
        const { executor, waits, key } = await stuck();
        executor.latest().reject(refused);
        await untilSettled(() => waits.length === 1);

        queue!.cancel(key);
        await waitFor(queue!, () => queue!.activeCount === 0);
        waits[0]!.release();
        await settle();

        expect(executor.translateCalls).toHaveLength(2);
        expect(queue!.getTask(key)).toMatchObject({ stage: "cancelled", draft: { typst: "= v1" } });
      });
    });

    describe("waitForRepairRetry", () => {
      test("resolves after the delay", async () => {
        await waitForRepairRetry(1, new AbortController().signal);
      });

      test("rejects with the abort reason at once instead of waiting out the delay", async () => {
        const controller = new AbortController();
        const waiting = waitForRepairRetry(60_000, controller.signal);
        controller.abort(new DOMException("cancelled", "AbortError"));
        await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
        await expect(waitForRepairRetry(60_000, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
      });
    });

    test("a reply the server refuses ends the round, not the run, and the next request says why", async () => {
      const executor = new ControlledExecutor();
      executor.failValidateFor = (typst) =>
        typst === "= fixed" ? null : compileError("error: unclosed delimiter (line 1, column 3)\n1 | = v1");
      const key = await generate(executor, "= v1");

      await waitFor(queue!, () => executor.translateCalls.length === 2);
      executor.latest().reject({ code: "INVALID_AI_OUTPUT", message: "Typst repair makes no change" });
      await waitFor(queue!, () => executor.translateCalls.length === 3);
      executor.latest().reject({ code: "INVALID_AI_OUTPUT", message: "Typst repair oldText was not found" });
      await waitFor(queue!, () => executor.translateCalls.length === 4);
      executor.latest().resolve(record(executor.latest().task, "= fixed"));
      await waitFor(queue!, () => queue!.getTask(key)?.stage === "saved");

      expect(executor.translateCalls.map((call) => call.repair?.typst)).toEqual([
        undefined,
        "= v1",
        "= v1",
        "= v1",
      ]);
      // Only the newest refusal is carried, and refusals never recompile the unchanged candidate.
      expect(executor.translateCalls[2]!.repair?.diagnostics).toContain("Typst repair makes no change");
      expect(executor.translateCalls[3]!.repair?.diagnostics).toContain("oldText was not found");
      expect(executor.translateCalls[3]!.repair?.diagnostics).not.toContain("makes no change");
      expect(executor.validateDrafts).toEqual(["= v1", "= fixed"]);
      expect(executor.prepareCalls).toBe(1);
      expect(executor.saveDrafts).toEqual(["= fixed"]);
      expect(queue!.getTask(key)?.repairRounds).toMatchObject([
        { round: 1, status: "rejected", error: { code: "INVALID_AI_OUTPUT", detail: "Typst repair makes no change" } },
        { round: 2, status: "rejected", error: { code: "INVALID_AI_OUTPUT", detail: "Typst repair oldText was not found" } },
        { round: 3, status: "compile-passed" },
      ]);
    });

    test("tells the model when its change left the compiler messages as they were", async () => {
      const executor = new ControlledExecutor();
      // The quoted source line changes with every edit; the message, line and column do not.
      executor.failValidateFor = (typst) =>
        typst === "= fixed"
          ? null
          : typst === "= v3"
            ? compileError("error: unclosed delimiter (line 2, column 9)\n2 | = v3")
            : compileError(`error: unclosed delimiter (line 1, column 3)\n1 | ${typst}`);
      const key = await generate(executor, "= v1");

      for (const [typst, calls] of [["= v2", 2], ["= v3", 3], ["= fixed", 4]] as const) {
        await waitFor(queue!, () => executor.translateCalls.length === calls);
        executor.latest().resolve(record(executor.latest().task, typst));
      }
      await waitFor(queue!, () => queue!.getTask(key)?.stage === "saved");

      const sent = executor.translateCalls.map((call) => call.repair?.diagnostics ?? "");
      expect(sent[1]).not.toContain(TYPST_PREVIOUS_ATTEMPT_HEADING);
      expect(sent[2]).toContain("did not fix");
      expect(sent[3]).toContain(TYPST_PREVIOUS_ATTEMPT_HEADING);
      expect(sent[3]).not.toContain("did not fix");
    });

    test("the previous-attempt section never pushes a request past the diagnostics limit", async () => {
      const executor = new ControlledExecutor();
      executor.failValidateFor = (typst) =>
        typst === "= fixed" ? null : compileError("x".repeat(MAX_TYPST_DIAGNOSTICS_CHARS + 500));
      const key = await generate(executor, "= v1");

      for (const [typst, calls] of [["= v2", 2], ["= fixed", 3]] as const) {
        await waitFor(queue!, () => executor.translateCalls.length === calls);
        executor.latest().resolve(record(executor.latest().task, typst));
      }
      await waitFor(queue!, () => queue!.getTask(key)?.stage === "saved");

      const [, first, second] = executor.translateCalls.map((call) => call.repair?.diagnostics);
      expect(first).toBe("x".repeat(MAX_TYPST_DIAGNOSTICS_CHARS));
      expect(second!.length).toBeLessThanOrEqual(MAX_TYPST_DIAGNOSTICS_CHARS);
      expect(second!.startsWith("x".repeat(1_000))).toBe(true);
      expect(second).toContain(TYPST_PREVIOUS_ATTEMPT_HEADING);
    });

    test("stopping a long repair keeps the last applied draft and the saved translation, and starts no queued page", async () => {
      const executor = new ControlledExecutor();
      executor.ignoreAbort = true;
      queue = new TranslationQueue(executor, { concurrency: 1 });
      const key = translationKey("a", 1, "en");
      executor.autoResolve = true;
      queue.enqueue(enqueue("a", 1));
      await waitFor(queue, () => queue!.getTask(key)?.stage === "saved");

      executor.autoResolve = false;
      executor.failValidateFor = (typst) => compileError(`bad ${typst}`);
      queue.enqueue(enqueue("a", 1, "user", true));
      queue.enqueue(enqueue("a", 2));
      for (const [typst, calls] of [["= v1", 2], ["= v2", 3], ["= v3", 4]] as const) {
        await waitFor(queue, () => executor.translateCalls.length === calls);
        executor.latest().resolve(record(executor.latest().task, typst));
      }
      await waitFor(queue, () => executor.translateCalls.length === 5);
      const pending = executor.latest();

      queue.cancelAll();
      await waitFor(queue, () => queue!.getTask(key)?.stage === "cancelled");
      pending.hooks.onRepair(applied(1));
      pending.resolve(record(pending.task, "= late"));
      await settle();

      expect(queue.getTask(key)).toMatchObject({
        stage: "cancelled",
        draft: { typst: "= v3" },
        saved: { typst: "# page 1" },
      });
      expect(queue.getTask(key)?.repairRounds?.map((round) => round.status)).toEqual([
        "compile-failed",
        "compile-failed",
        "cancelled",
      ]);
      expect(queue.getTask(translationKey("a", 2, "en"))?.stage).toBe("cancelled");
      expect(executor.translateCalls).toHaveLength(5);
      expect(executor.validateDrafts.at(-1)).toBe("= v3");
      expect(executor.saveDrafts).toEqual(["# page 1"]);
    });

    for (const code of ["AI_AUTH_FAILED", "AI_REQUEST_FAILED", "AI_TIMEOUT"]) {
      test(`${code} in a later round stops the run with the draft kept`, async () => {
        const executor = new ControlledExecutor();
        executor.failValidateFor = () => compileError("bad");
        const key = await generate(executor, "= v1");

        await waitFor(queue!, () => executor.translateCalls.length === 2);
        executor.latest().resolve(record(executor.latest().task, "= v2"));
        await waitFor(queue!, () => executor.translateCalls.length === 3);
        executor.latest().reject({ code, message: "provider failed" });
        await waitFor(queue!, () => queue!.getTask(key)?.stage === "unsaved");

        expect(executor.translateCalls).toHaveLength(3);
        expect(queue!.getTask(key)).toMatchObject({
          draft: { typst: "= v2" },
          error: { code, stage: "repairing" },
        });
        expect(queue!.getTask(key)?.repairRounds?.map((round) => round.status)).toEqual([
          "compile-failed",
          "request-failed",
        ]);
        expect(queue!.halt?.code).toBe(code === "AI_AUTH_FAILED" ? code : undefined);
      });
    }

    test("keeps the last complete candidate when the repair request fails", async () => {
      const executor = new ControlledExecutor();
      executor.failValidateFor = () => compileError("unclosed delimiter");
      const key = await generate(executor, "= v1");

      await waitFor(queue!, () => executor.translateCalls.length === 2);
      executor.latest().hooks.onDelta(0, "= partial");
      executor.latest().hooks.onRepair(requesting(1));
      executor.latest().reject({ code: "AI_REQUEST_FAILED", message: "provider failed" });
      await waitFor(queue!, () => queue!.getTask(key)?.stage === "unsaved");

      expect(queue!.getTask(key)).toMatchObject({
        draft: { typst: "= v1" },
        preview: "",
        error: { code: "AI_REQUEST_FAILED", stage: "repairing" },
      });
      expect(queue!.getTask(key)?.repairRounds).toEqual([
        {
          round: 1,
          diagnostics: "unclosed delimiter",
          events: [requesting(1)],
          status: "request-failed",
          error: { code: "AI_REQUEST_FAILED", detail: "provider failed", stage: "repairing" },
        },
      ]);
    });

    for (const [label, failure, error, stage] of [
      ["a compile timeout", "validate", { code: "TYPST_COMPILE_TIMEOUT", message: "timed out" }, "validating"],
      ["an unavailable runtime", "validate", { code: "TYPST_RUNTIME_UNAVAILABLE", message: "no worker" }, "validating"],
      ["a compile failure without diagnostics", "validate", compileError("  "), "validating"],
      ["a storage failure", "save", { code: "STORAGE_BUSY", message: "database is locked" }, "saving"],
    ] as const) {
      test(`does not call the model again after ${label}`, async () => {
        const executor = new ControlledExecutor();
        if (failure === "validate") executor.failValidate = error;
        else executor.failSave = error;
        const key = await generate(executor, "= v1");

        await waitFor(queue!, () => queue!.getTask(key)?.stage === "unsaved");
        expect(executor.translateCalls).toHaveLength(1);
        expect(queue!.getTask(key)).toMatchObject({
          draft: { typst: "= v1" },
          error: { code: error.code, stage },
        });
        expect(queue!.getTask(key)?.repairRounds).toBeUndefined();
      });
    }

    test("rejects a cached response to a repair request", async () => {
      const executor = new ControlledExecutor();
      executor.failValidateFor = () => compileError("unclosed delimiter");
      const key = await generate(executor, "= v1");

      await waitFor(queue!, () => executor.translateCalls.length === 2);
      executor.latest().resolve(record(executor.latest().task, "= cached"), true);
      await waitFor(queue!, () => queue!.getTask(key)?.stage === "unsaved");

      expect(queue!.getTask(key)).toMatchObject({
        draft: { typst: "= v1" },
        error: { code: "INVALID_RESPONSE", stage: "repairing" },
      });
      expect(queue!.getTask(key)?.repairRounds).toMatchObject([{ status: "request-failed" }]);
      expect(queue!.getTask(key)?.saved).toBeUndefined();
    });

    test("ignores a repair that answers after cancellation or document removal", async () => {
      const executor = new ControlledExecutor();
      executor.ignoreAbort = true;
      executor.failValidateFor = (typst) => (typst === "= v1" ? compileError("bad") : null);
      const key = await generate(executor, "= v1");
      await waitFor(queue!, () => executor.translateCalls.length === 2);
      const cancelled = executor.latest();

      queue!.cancel(key);
      await waitFor(queue!, () => queue!.getTask(key)?.stage === "cancelled");
      cancelled.hooks.onRepair(applied(1));
      cancelled.resolve(record(cancelled.task, "= late"));
      await settle();
      expect(executor.validateDrafts).toEqual(["= v1"]);
      expect(executor.saveDrafts).toEqual([]);
      expect(queue!.getTask(key)).toMatchObject({
        stage: "cancelled",
        draft: { typst: "= v1" },
      });
      expect(queue!.getTask(key)?.saved).toBeUndefined();
      expect(queue!.getTask(key)?.repairRounds).toEqual([
        { round: 1, diagnostics: "bad", events: [], status: "cancelled" },
      ]);

      queue!.retry(key);
      await waitFor(queue!, () => queue!.getTask(key)?.stage === "unsaved");
      queue!.cancelDocument("a");
      expect(queue!.getTask(key)).toBeUndefined();
      expect(executor.translateCalls).toHaveLength(2);
    });

    test("an explicit repair continues a cancelled draft with a fresh record", async () => {
      const executor = new ControlledExecutor();
      executor.failValidateFor = (typst) => (typst === "= v1" ? compileError("bad") : null);
      const key = await generate(executor, "= v1");
      await waitFor(queue!, () => executor.translateCalls.length === 2);

      queue!.cancel(key);
      await waitFor(queue!, () => queue!.getTask(key)?.stage === "cancelled");
      await settle();
      expect(queue!.getTask(key)).toMatchObject({ draft: { typst: "= v1" } });
      expect(queue!.getTask(key)?.repairRounds).toMatchObject([{ round: 1, status: "cancelled" }]);

      queue!.repair(key);
      await waitFor(queue!, () => executor.translateCalls.length === 3);
      expect(executor.latest().repair).toEqual({ typst: "= v1", diagnostics: "bad" });
      expect(queue!.getTask(key)?.repairRounds).toEqual([
        { round: 1, diagnostics: "bad", events: [], status: "requesting" },
      ]);

      executor.latest().resolve(record(executor.latest().task, "= fixed"));
      await waitFor(queue!, () => queue!.getTask(key)?.stage === "saved");
      expect(queue!.getTask(key)?.saved?.typst).toBe("= fixed");
    });

    test("rejects edits while repairing", async () => {
      const executor = new ControlledExecutor();
      executor.failValidateFor = () => compileError("unclosed delimiter");
      const key = await generate(executor, "= v1");
      await waitFor(queue!, () => executor.translateCalls.length === 2);

      queue!.edit({
        documentId: "a",
        pageNumber: 1,
        targetLanguage: "en",
        content: content("= edited"),
      });
      expect(queue!.getTask(key)).toMatchObject({
        stage: "repairing",
        draft: { typst: "= v1" },
      });
    });

    test("accepts an edit while validating and keeps the active stage", async () => {
      const executor = new ControlledExecutor();
      executor.deferValidate = true;
      const key = await generate(executor, "= first");
      await waitFor(queue!, () => executor.pendingValidations.length === 1);

      queue!.edit({
        documentId: "a",
        pageNumber: 1,
        targetLanguage: "en",
        content: content("= edited"),
      });
      expect(queue!.getTask(key)).toMatchObject({
        stage: "validating",
        draft: { typst: "= edited" },
      });
    });

    test("does not repair over an edit made while the candidate compiles", async () => {
      const executor = new ControlledExecutor();
      executor.deferValidate = true;
      const key = await generate(executor, "= first");
      await waitFor(queue!, () => executor.pendingValidations.length === 1);

      queue!.edit({
        documentId: "a",
        pageNumber: 1,
        targetLanguage: "en",
        content: content("= edited"),
      });
      executor.pendingValidations[0]!.reject(compileError("unclosed delimiter"));
      await waitFor(queue!, () => queue!.getTask(key)?.stage === "unsaved");

      expect(executor.translateCalls).toHaveLength(1);
      expect(executor.saveDrafts).toEqual([]);
      expect(queue!.getTask(key)).toMatchObject({ draft: { typst: "= edited" } });
      // The diagnostics describe the old source, not the edit.
      expect(queue!.getTask(key)?.error).toBeUndefined();
      expect(queue!.getTask(key)?.repairRounds).toBeUndefined();
    });

    test("does not save a candidate that passed validation after an edit replaced it", async () => {
      const executor = new ControlledExecutor();
      executor.deferValidate = true;
      const key = await generate(executor, "= first");
      await waitFor(queue!, () => executor.pendingValidations.length === 1);

      queue!.edit({
        documentId: "a",
        pageNumber: 1,
        targetLanguage: "en",
        content: content("= edited"),
      });
      executor.pendingValidations[0]!.resolve();
      await waitFor(queue!, () => queue!.getTask(key)?.stage === "unsaved");

      expect(executor.saveDrafts).toEqual([]);
      expect(queue!.getTask(key)).toMatchObject({ draft: { typst: "= edited" } });
      expect(queue!.getTask(key)?.saved).toBeUndefined();
    });

    test("keeps the corrected draft when the repaired source cannot be stored", async () => {
      const executor = new ControlledExecutor();
      executor.failValidateFor = (typst) =>
        typst === "= v1" ? compileError("unclosed delimiter") : null;
      executor.failSave = { code: "STORAGE_BUSY", message: "database is locked" };
      const key = await generate(executor, "= v1");

      await waitFor(queue!, () => executor.translateCalls.length === 2);
      executor.latest().resolve(record(executor.latest().task, "= fixed"));
      await waitFor(queue!, () => queue!.getTask(key)?.stage === "unsaved");

      expect(executor.translateCalls).toHaveLength(2);
      expect(queue!.getTask(key)).toMatchObject({
        draft: { typst: "= fixed" },
        error: { code: "STORAGE_BUSY", stage: "saving" },
      });
      // The source compiled; only the write failed.
      expect(queue!.getTask(key)?.repairRounds).toMatchObject([{ status: "compile-passed" }]);
      expect(queue!.halt?.code).toBe("STORAGE_BUSY");
    });

    test("names the failing step: generating, preparing and repairing", async () => {
      const generating = new ControlledExecutor();
      generating.failTranslate = { code: "AI_REQUEST_FAILED", message: "provider failed" };
      queue = new TranslationQueue(generating, { concurrency: 1 });
      const key = translationKey("a", 1, "en");
      queue.enqueue(enqueue("a", 1));
      await waitFor(queue, () => queue!.getTask(key)?.stage === "error");
      expect(queue.getTask(key)?.error).toMatchObject({ code: "AI_REQUEST_FAILED", stage: "generating" });
      queue.repair(key);
      await settle();
      expect(queue.getTask(key)?.stage).toBe("error");

      const preparing = new ControlledExecutor();
      preparing.failPrepare = { code: "PDF_NOT_READY", message: "PDF is not open" };
      queue = new TranslationQueue(preparing, { concurrency: 1 });
      queue.enqueue(enqueue("a", 1));
      await waitFor(queue, () => queue!.getTask(key)?.stage === "error");
      expect(queue.getTask(key)?.error).toMatchObject({ code: "PDF_NOT_READY", stage: "preparing" });

      const repairing = new ControlledExecutor();
      repairing.failValidateFor = (typst) => (typst === "= manual (" ? compileError("unclosed") : null);
      queue = new TranslationQueue(repairing, { concurrency: 1 });
      queue.edit({ documentId: "a", pageNumber: 1, targetLanguage: "en", content: content("= manual (") });
      repairing.failTranslate = { code: "AI_REQUEST_FAILED", message: "provider failed" };
      queue.repair(key);
      await waitFor(queue, () => queue!.getTask(key)?.stage === "unsaved");
      expect(queue.getTask(key)).toMatchObject({
        draft: { typst: "= manual (" },
        error: { code: "AI_REQUEST_FAILED", stage: "repairing" },
      });
      expect(queue.getTask(key)?.repairRounds).toMatchObject([
        { round: 1, diagnostics: "unclosed", status: "request-failed" },
      ]);
    });

    test("repairing a draft that already compiles only validates and saves it", async () => {
      const executor = new ControlledExecutor();
      queue = new TranslationQueue(executor, { concurrency: 1 });
      const key = translationKey("a", 1, "en");
      queue.edit({ documentId: "a", pageNumber: 1, targetLanguage: "en", content: content("= manual") });

      queue.repair(key);
      await waitFor(queue, () => queue!.getTask(key)?.stage === "saved");

      expect(executor.validateDrafts).toEqual(["= manual"]);
      expect(executor.saveDrafts).toEqual(["= manual"]);
      expect(executor.prepareCalls).toBe(0);
      expect(executor.translateCalls).toHaveLength(0);
      expect(queue.getTask(key)?.repairRounds).toBeUndefined();
    });

    test("repairs a manual draft the compiler rejects without translating the page again", async () => {
      const executor = new ControlledExecutor();
      executor.failValidateFor = (typst) => (typst === "= manual (" ? compileError("unclosed") : null);
      queue = new TranslationQueue(executor, { concurrency: 1 });
      const key = translationKey("a", 1, "en");
      queue.edit({ documentId: "a", pageNumber: 1, targetLanguage: "en", content: content("= manual (") });

      queue.repair(key);
      await waitFor(queue, () => executor.translateCalls.length === 1);
      expect(executor.latest().repair).toEqual({ typst: "= manual (", diagnostics: "unclosed" });
      expect(executor.prepareCalls).toBe(0);

      executor.latest().resolve(record(executor.latest().task, "= manual"));
      await waitFor(queue, () => queue!.getTask(key)?.stage === "saved");
      expect(executor.saveDrafts).toEqual(["= manual"]);
      expect(executor.translateCalls).toHaveLength(1);
    });

    test("an explicit repair queues behind the concurrency limit and cannot start twice", async () => {
      const executor = new ControlledExecutor();
      executor.failValidateFor = (typst) => (typst === "= bad" ? compileError("bad") : null);
      queue = new TranslationQueue(executor, { concurrency: 1 });
      const draftKey = translationKey("a", 1, "en");
      queue.edit({ documentId: "a", pageNumber: 1, targetLanguage: "en", content: content("= bad") });
      queue.enqueue(enqueue("a", 2, "user"));
      await waitFor(queue, () => executor.translateCalls.length === 1);

      queue.repair(draftKey);
      queue.repair(draftKey);
      expect(queue.getTask(draftKey)?.stage).toBe("queued");
      expect(executor.validateDrafts).toEqual([]);
      expect(queue.activeCount).toBe(1);

      executor.latest().resolve(record(executor.latest().task));
      await waitFor(queue, () => executor.translateCalls.length === 2);
      expect(executor.latest().repair).toEqual({ typst: "= bad", diagnostics: "bad" });
      await settle();
      expect(executor.translateCalls).toHaveLength(2);
      expect(queue.getTask(translationKey("a", 2, "en"))?.stage).toBe("saved");
    });

    test("repair ignores tasks without a retained draft", async () => {
      const executor = new ControlledExecutor();
      executor.autoResolve = true;
      queue = new TranslationQueue(executor, { concurrency: 1 });
      const key = translationKey("a", 1, "en");
      queue.enqueue(enqueue("a", 1));
      await waitFor(queue, () => queue!.getTask(key)?.stage === "saved");

      queue.repair(key);
      queue.repair(translationKey("a", 9, "en"));
      await settle();
      expect(queue.getTask(key)?.stage).toBe("saved");
      expect(executor.validateDrafts).toEqual(["# page 1"]);
    });

    test("keeps repair records and the EPUB location with the page, language and unit that produced them", async () => {
      const executor = new ControlledExecutor();
      executor.failValidateFor = (typst) =>
        typst.startsWith("= bad") ? compileError(`bad ${typst}`) : null;
      queue = new TranslationQueue(executor, { concurrency: 3 });
      const english = queue.enqueue({ documentId: "a", pageNumber: 1, targetLanguage: "en", priority: "user" }).key;
      const spanish = queue.enqueue({ documentId: "a", pageNumber: 1, targetLanguage: "es", priority: "user" }).key;
      const unit = queue.enqueue({
        documentId: "a",
        pageNumber: 1,
        targetLanguage: "en",
        unit: "sel-1",
        priority: "user",
        sourceCfi: "epubcfi(/6/4!/4/2)",
        epubLayout: {
          width: 600,
          height: 800,
          style: { fontSize: 18, fontFamily: "serif", lineHeight: 1.6, theme: "light" },
        },
        epubPage: { page: 2, total: 9 },
      }).key;
      await waitFor(queue, () => executor.translateCalls.length === 3);
      for (const call of executor.translateCalls.slice(0, 3)) {
        call.resolve(record(call.task, `= bad ${call.task.key}`));
      }
      await waitFor(queue, () => executor.translateCalls.length === 6);
      for (const call of executor.translateCalls.slice(3)) {
        call.resolve(record(call.task, `= fixed ${call.task.key}`));
      }
      await waitFor(queue, () =>
        [english, spanish, unit].every((key) => queue!.getTask(key)?.stage === "saved"),
      );

      for (const key of [english, spanish, unit]) {
        expect(queue.getTask(key)?.repairRounds).toMatchObject([
          {
            round: 1,
            diagnostics: `bad = bad ${key}`,
            status: "compile-passed",
            change: { after: `= fixed ${key}` },
          },
        ]);
      }
      expect(queue.getTask(unit)).toMatchObject({
        sourceCfi: "epubcfi(/6/4!/4/2)",
        epubLayout: { width: 600, height: 800 },
        epubPage: { page: 2, total: 9 },
      });
    });

    test("a manual edit clears the repair history and its error", async () => {
      const executor = new ControlledExecutor();
      executor.failValidateFor = () => compileError("bad");
      const key = await generate(executor, "= v1");
      for (const [typst, calls] of [["= v2", 2], ["= v3", 3]] as const) {
        await waitFor(queue!, () => executor.translateCalls.length === calls);
        executor.latest().resolve(record(executor.latest().task, typst));
      }
      await waitFor(queue!, () => executor.translateCalls.length === 4);
      executor.latest().reject({ code: "AI_REQUEST_FAILED", message: "provider failed" });
      await waitFor(queue!, () => queue!.getTask(key)?.stage === "unsaved");
      expect(queue!.getTask(key)?.repairRounds).toHaveLength(3);

      queue!.edit({ documentId: "a", pageNumber: 1, targetLanguage: "en", content: content("= mine") });
      expect(queue!.getTask(key)).toMatchObject({ stage: "unsaved", draft: { typst: "= mine" } });
      expect(queue!.getTask(key)?.repairRounds).toBeUndefined();
      expect(queue!.getTask(key)?.error).toBeUndefined();
    });

    test("never drops a cancelled draft until the user discards it", async () => {
      const executor = new ControlledExecutor();
      executor.deferSave = true;
      const key = await generate(executor, "= candidate");
      await waitFor(queue!, () => executor.pendingSaves.length === 1);

      queue!.cancel(key);
      await waitFor(queue!, () => queue!.getTask(key)?.stage === "cancelled");
      executor.pendingSaves[0]!.resolve(record(queue!.getTask(key)!, "= late"));
      await settle();

      const again = queue!.enqueue(enqueue("a", 1, "user"));
      expect(again).toMatchObject({ stage: "cancelled", draft: { typst: "= candidate" } });
      expect(executor.translateCalls).toHaveLength(1);

      queue!.discard(key);
      expect(queue!.getTask(key)).toMatchObject({ stage: "cancelled", draft: undefined, error: undefined });
      expect(queue!.getTask(key)?.repairRounds).toBeUndefined();
      expect(queue!.getTask(key)?.saved).toBeUndefined();

      queue!.enqueue(enqueue("a", 1, "user"));
      await waitFor(queue!, () => executor.translateCalls.length === 2);
      expect(queue!.getTask(key)?.stage).toBe("generating");
    });

    for (const outcome of ["resolves", "rejects"] as const) {
      test(`a repair request that ${outcome} after the user cancelled it and typed a new draft changes nothing`, async () => {
        const executor = new ControlledExecutor();
        executor.ignoreAbort = true; // the request is still on the wire when the user cancels
        executor.failValidateFor = (typst) => (typst === "= v1" ? compileError("bad") : null);
        const key = await generate(executor, "= v1");
        await waitFor(queue!, () => executor.translateCalls.length === 2);
        const repairing = executor.latest();
        expect(repairing.repair).toBeDefined();

        queue!.cancel(key);
        queue!.edit({ documentId: "a", pageNumber: 1, targetLanguage: "en", content: content("= mine") });
        if (outcome === "resolves") repairing.resolve(record(repairing.task, "= late repair"));
        else repairing.reject(new DOMException("cancelled", "AbortError"));
        await settle();

        expect(queue!.getTask(key)).toMatchObject({ stage: "unsaved", draft: { typst: "= mine" } });
        expect(executor.validateDrafts).toEqual(["= v1"]);
        expect(executor.saveCalls).toEqual([]);
      });
    }

    describe("the changed lines of a round", () => {
      async function changeBetween(before: string, after: string) {
        const executor = new ControlledExecutor();
        executor.failValidateFor = (typst) => (typst === before ? compileError("bad") : null);
        const key = await generate(executor, before);
        await waitFor(queue!, () => executor.translateCalls.length === 2);
        executor.latest().resolve(record(executor.latest().task, after));
        await waitFor(queue!, () => queue!.getTask(key)?.stage === "saved");
        return queue!.getTask(key)?.repairRounds?.[0]?.change;
      }

      for (const [label, before, after, expected] of [
        ["one changed line between equal lines", "A\nB\nC", "A\nb\nC", { startLine: 2, before: "B", after: "b" }],
        [
          "separate edits share one range with the lines between them",
          "1\n2\n3\n4\n5",
          "1\nX\n3\nY\n5",
          { startLine: 2, before: "2\n3\n4", after: "X\n3\nY" },
        ],
        ["an inserted line", "a\nc", "a\nb\nc", { startLine: 2, before: "", after: "b" }],
        ["a deleted line", "a\nb\nc", "a\nc", { startLine: 2, before: "b", after: "" }],
        ["an appended line", "a", "a\nb", { startLine: 2, before: "", after: "b" }],
        ["the first line", "x\ny", "z\ny", { startLine: 1, before: "x", after: "z" }],
        [
          "Chinese text with an emoji",
          "标题\n金额 $5 😀\n结尾",
          "标题\n金额 \\$5 😀\n结尾",
          { startLine: 2, before: "金额 $5 😀", after: "金额 \\$5 😀" },
        ],
        [
          "a change of line-break form only",
          "a\r\nb",
          "a\nb",
          { startLine: 1, before: "a\r\nb", after: "a\nb" },
        ],
      ] as const) {
        test(label, async () => {
          expect(await changeBetween(before, after)).toEqual(expected);
        });
      }
    });

    test("neighbouring-context warnings stay with the draft through automatic and manual repair", async () => {
      const executor = new ControlledExecutor();
      executor.prepareWarnings = ["previous"];
      executor.failValidateFor = (typst) => (typst === "= v1" ? compileError("bad") : null);
      const key = await generate(executor, "= v1");
      await waitFor(queue!, () => executor.translateCalls.length === 2);
      expect(queue!.getTask(key)?.contextWarnings).toEqual(["previous"]);

      queue!.cancel(key);
      await waitFor(queue!, () => queue!.getTask(key)?.stage === "cancelled");
      // The cancelled run releases its controller only after it unwinds; repair waits for that.
      await settle();
      queue!.repair(key);
      await waitFor(queue!, () => executor.translateCalls.length === 3);
      expect(queue!.getTask(key)?.contextWarnings).toEqual(["previous"]);
    });
  });

  test("keeps a newer edit when an in-flight save succeeds", async () => {
    const executor = new ControlledExecutor();
    executor.deferSave = true;
    queue = new TranslationQueue(executor, { concurrency: 1 });
    const key = translationKey("a", 1, "en");
    queue.enqueue(enqueue("a", 1));
    await waitFor(queue, () => executor.translateCalls.length === 1);
    executor.translateCalls[0]!.resolve(record(executor.translateCalls[0]!.task, "= first"));
    await waitFor(queue, () => executor.pendingSaves.length === 1);
    expect(queue.getTask(key)?.stage).toBe("saving");

    queue.edit({
      documentId: "a",
      pageNumber: 1,
      targetLanguage: "en",
      content: content("= edited"),
    });
    expect(queue.getTask(key)?.draft?.typst).toBe("= edited");
    executor.pendingSaves[0]!.resolve(record(queue.getTask(key)!, "= first"));
    await waitFor(queue, () => queue!.getTask(key)?.stage === "unsaved");

    expect(queue.getTask(key)?.draft?.typst).toBe("= edited");
    expect(queue.getTask(key)?.saved?.typst).toBe("= first");
  });

  test("discarding a new edit leaves the previous saved translation visible", async () => {
    const executor = new ControlledExecutor();
    queue = new TranslationQueue(executor, { concurrency: 1 });
    const key = translationKey("a", 1, "en");
    executor.autoResolve = true;
    queue.enqueue(enqueue("a", 1));
    await waitFor(queue, () => queue!.getTask(key)?.stage === "saved");
    const previous = queue.getTask(key)!.saved!;

    queue.edit({
      documentId: "a",
      pageNumber: 1,
      targetLanguage: "en",
      content: content("= edited"),
      saved: previous,
    });
    expect(queue.getTask(key)).toMatchObject({
      stage: "unsaved",
      draft: { typst: "= edited" },
      saved: { typst: "# page 1" },
    });
    queue.discard(key);
    expect(queue.getTask(key)).toMatchObject({
      stage: "cancelled",
      draft: undefined,
      saved: { typst: "# page 1" },
    });
  });

  test("ignores a save that finishes after cancellation", async () => {
    const executor = new ControlledExecutor();
    executor.deferSave = true;
    queue = new TranslationQueue(executor, { concurrency: 1 });
    const key = translationKey("a", 1, "en");
    queue.enqueue(enqueue("a", 1));
    await waitFor(queue, () => executor.translateCalls.length === 1);
    executor.translateCalls[0]!.resolve(record(executor.translateCalls[0]!.task));
    await waitFor(queue, () => executor.pendingSaves.length === 1);

    queue.cancel(key);
    await waitFor(queue, () => queue!.getTask(key)?.stage === "cancelled");
    executor.pendingSaves[0]!.resolve(record(queue.getTask(key)!, "= late"));
    await Promise.resolve();
    await Promise.resolve();
    expect(queue.getTask(key)).toMatchObject({
      stage: "cancelled",
      draft: { typst: "# page 1" },
    });
    expect(queue.getTask(key)?.saved).toBeUndefined();
  });

  test("keys whole-section and selection translations separately", async () => {
    const executor = new ControlledExecutor();
    executor.autoResolve = true;
    queue = new TranslationQueue(executor, { concurrency: 1 });
    const section = queue.enqueue(enqueue("a", 1));
    const selection = queue.enqueue({
      ...enqueue("a", 1),
      unit: "sel-a1",
    });

    expect(section.key).not.toBe(selection.key);
    await waitFor(
      queue,
      () =>
        queue!.getTask(section.key)?.stage === "saved" &&
        queue!.getTask(selection.key)?.stage === "saved",
    );
    expect(executor.translateCalls).toHaveLength(2);
    expect(queue.getTasks().filter((task) => task.pageNumber === 1)).toHaveLength(2);
  });

  test("dispatches equal-priority ties by page and insertion order", async () => {
    const executor = new ControlledExecutor();
    queue = new TranslationQueue(executor, {
      concurrency: 1,
      now: () => 1000,
    });
    queue.enqueue(enqueue("b", 1));
    queue.enqueue(enqueue("a", 1));
    queue.enqueue(enqueue("a", 2));
    await waitFor(queue, () => executor.translateCalls.length === 1);
    expect(executor.translateCalls[0]!.task.documentId).toBe("b");

    executor.translateCalls[0]!.resolve(record(executor.translateCalls[0]!.task));
    await waitFor(queue, () => executor.translateCalls.length === 2);
    expect(executor.translateCalls[1]!.task.documentId).toBe("a");
    expect(executor.translateCalls[1]!.task.pageNumber).toBe(1);

    executor.translateCalls[1]!.resolve(record(executor.translateCalls[1]!.task));
    await waitFor(queue, () => executor.translateCalls.length === 3);
    expect(executor.translateCalls[2]!.task.pageNumber).toBe(2);
    executor.resolveAll();
    await waitFor(queue, () =>
      queue!.getTasks().every((task) => task.stage === "saved"),
    );
  });

  test("keeps task display order after retry and document removal", async () => {
    const executor = new ControlledExecutor();
    queue = new TranslationQueue(executor, { concurrency: 1 });
    queue.enqueue(enqueue("a", 3));
    queue.enqueue(enqueue("a", 1));
    queue.enqueue(enqueue("a", 2));
    expect(queue.getTasks().map((task) => task.pageNumber)).toEqual([1, 2, 3]);

    await waitFor(queue, () => executor.translateCalls.length === 1);
    queue.cancelDocument("a");
    expect(queue.getTasks()).toEqual([]);
  });
});
