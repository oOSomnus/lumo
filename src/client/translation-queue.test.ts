import { afterEach, describe, expect, test } from "bun:test";
import type { TranslationContent, TranslationRecord } from "../shared/contracts";
import {
  TranslationQueue,
  translationKey,
  type EnqueueTranslation,
  type TranslationExecutor,
  type TranslationTask,
} from "./translation-queue";

function content(markdown: string): TranslationContent {
  return { markdown, provider: "mock", model: "vision" };
}

function record(task: TranslationTask, markdown = `# page ${task.pageNumber}`): TranslationRecord {
  return {
    documentId: task.documentId,
    pageNumber: task.pageNumber,
    targetLanguage: task.targetLanguage,
    ...content(markdown),
    translatedAt: 1,
  };
}

type TranslateCall = {
  task: TranslationTask;
  hooks: {
    onDelta: (contentIndex: number, text: string) => void;
    onSaving: () => void;
  };
  resolve: (record: TranslationRecord, cacheHit?: boolean) => void;
  reject: (error: unknown) => void;
};

class ControlledExecutor implements TranslationExecutor {
  readonly translateCalls: TranslateCall[] = [];
  readonly saveCalls: string[] = [];
  cacheHit = false;
  failTranslate: unknown | null = null;
  autoResolve = false;
  ignoreAbort = false;

  prepare = async (task: TranslationTask, _signal: AbortSignal) => ({
    text: `page ${task.pageNumber}`,
    imageBase64: "/9j/AAAA",
  });

  translate = (
    task: TranslationTask,
    _prepared: { text: string; imageBase64: string },
    signal: AbortSignal,
    hooks: {
      onDelta: (contentIndex: number, text: string) => void;
      onSaving: () => void;
    },
  ) =>
    new Promise<{ translation: TranslationRecord; cacheHit: boolean }>((resolve, reject) => {
      if (this.failTranslate) {
        reject(this.failTranslate);
        return;
      }
      const call: TranslateCall = {
        task,
        hooks,
        resolve: (translation, cacheHit = this.cacheHit) =>
          resolve({ translation, cacheHit }),
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
    });

  save = async (task: TranslationTask, _draft: TranslationContent, _signal: AbortSignal) => {
    this.saveCalls.push(task.key);
    return record(task);
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
    expect(queue.getTask(key)?.attemptId).toBe(2);
    expect(queue.getTask(key)?.stage).not.toBe("saved");
    expect(queue.getTask(key)?.saved).toBeUndefined();

    executor.translateCalls[1]!.resolve(record(executor.translateCalls[1]!.task, "# fresh"));
    await waitFor(queue, () => queue!.getTask(key)?.stage === "saved");
    expect(queue.getTask(key)?.saved?.markdown).toBe("# fresh");
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

    expect(queue.getTask(key)?.draft?.markdown).toBe("# draft");
    expect(queue.halt?.code).toBe("STORAGE_BUSY");

    executor.failTranslate = null;
    queue.retry(key);
    await waitFor(queue, () => queue!.getTask(key)?.stage === "saved");
    expect(executor.saveCalls).toEqual([key]);
    expect(queue.getTask(key)?.saved?.markdown).toBe("# page 1");
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
