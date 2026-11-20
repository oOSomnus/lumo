export interface TypstAsset {
  path: string;
  data: Uint8Array;
}

export type TypstErrorCode =
  | "TYPST_COMPILE_FAILED"
  | "TYPST_COMPILE_TIMEOUT"
  | "TYPST_RUNTIME_UNAVAILABLE";

export class TypstError extends Error {
  constructor(
    readonly code: TypstErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TypstError";
  }
}

export const TYPST_COMPILE_TIMEOUT_MS = 15_000;

interface CompileJob {
  id: number;
  source: string;
  assets: TypstAsset[];
  posted: boolean; // sent to the Worker; aborting then terminates it
  resolve: (svg: string) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
  timer: ReturnType<typeof setTimeout> | null;
}

let nextId = 1;
// Current instance, registered at creation; workerReady is its shared initialization.
let worker: Worker | null = null;
let workerReady: Promise<Worker> | null = null;
let active: CompileJob | null = null;
const queue: CompileJob[] = [];

function abortError(): DOMException {
  return new DOMException("Typst compilation was cancelled", "AbortError");
}

function disposeJob(job: CompileJob): void {
  if (job.timer !== null) {
    clearTimeout(job.timer);
    job.timer = null;
  }
  job.signal.removeEventListener("abort", job.onAbort);
}

function rejectJob(job: CompileJob, error: unknown): void {
  disposeJob(job);
  job.reject(error);
}

function settleActive(svg: string): void {
  const job = active;
  if (!job) return;
  active = null;
  disposeJob(job);
  job.resolve(svg);
  pump();
}

function terminateWorker(): void {
  worker?.terminate();
  worker = null;
  workerReady = null;
}

function failActive(error: unknown, killWorker: boolean): void {
  const job = active;
  if (!job) return;
  active = null;
  disposeJob(job);
  if (killWorker) terminateWorker();
  job.reject(error);
  pump();
}

/**
 * Starts a Typst worker. `ready` settles with the runtime's initialization; a
 * failure to initialize, or a later crash, is reported once through `onFailure`.
 * Every other message goes to `onMessage`. The caller owns termination.
 */
export function spawnTypstWorker(
  name: string,
  handlers: {
    onMessage(message: { type: string; id?: number } & Record<string, unknown>): void;
    onFailure(error: TypstError): void;
  },
): { worker: Worker; ready: Promise<Worker> } {
  const created = new Worker(new URL("/typst/worker.js", location.origin), {
    type: "module",
    name,
  });
  const ready = Promise.withResolvers<Worker>();
  // A worker that fails before anyone awaits it must not surface as an unhandled rejection.
  ready.promise.catch(() => undefined);
  let initialized = false;
  let failed = false;
  const fail = (error: TypstError): void => {
    if (failed) return;
    failed = true;
    ready.reject(error);
    handlers.onFailure(error);
  };
  created.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data as
      | ({ type: string; id?: number; message?: string } & Record<string, unknown>)
      | null;
    if (!message || typeof message !== "object" || failed) return;
    if (message.type === "ready") {
      initialized = true;
      ready.resolve(created);
      return;
    }
    if (message.type === "init-error") {
      fail(
        new TypstError(
          "TYPST_RUNTIME_UNAVAILABLE",
          message.message ?? "the Typst runtime could not initialize",
        ),
      );
      return;
    }
    handlers.onMessage(message);
  };
  created.onerror = (event) => {
    fail(
      new TypstError(
        "TYPST_RUNTIME_UNAVAILABLE",
        initialized
          ? "the Typst runtime crashed"
          : event.message || "the Typst runtime failed to load",
      ),
    );
  };
  return { worker: created, ready: ready.promise };
}

function createWorker(): Promise<Worker> {
  const spawned = spawnTypstWorker("lumo-typst", {
    onMessage: (message) => {
      if (worker !== spawned.worker) return;
      if (!active || message.id !== active.id) return;
      if (message.type === "compiled" && typeof message.svg === "string") {
        settleActive(message.svg);
      } else if (message.type === "failed") {
        failActive(
          new TypstError(
            "TYPST_COMPILE_FAILED",
            typeof message.message === "string"
              ? message.message
              : "Typst compilation failed",
          ),
          false,
        );
      }
    },
    // Ends this instance and fails its waiting job, so the next job starts a fresh Worker.
    onFailure: (error) => {
      if (worker !== spawned.worker) return;
      terminateWorker();
      failActive(error, false);
    },
  });
  worker = spawned.worker;
  return spawned.ready;
}

function ensureWorker(): Promise<Worker> {
  if (!workerReady) workerReady = createWorker();
  return workerReady;
}

function pump(): void {
  if (active || queue.length === 0) return;
  const job = queue.shift()!;
  active = job;
  void (async () => {
    let created: Worker;
    try {
      created = await ensureWorker();
    } catch (error) {
      if (active === job) {
        failActive(
          error instanceof TypstError
            ? error
            : new TypstError(
                "TYPST_RUNTIME_UNAVAILABLE",
                "the Typst runtime could not initialize",
              ),
          true,
        );
      }
      return;
    }
    if (active !== job || job.signal.aborted) return;
    job.timer = setTimeout(() => {
      if (active !== job || worker !== created) return;
      failActive(
        new TypstError(
          "TYPST_COMPILE_TIMEOUT",
          `Typst compilation timed out after ${TYPST_COMPILE_TIMEOUT_MS / 1000} seconds`,
        ),
        true,
      );
    }, TYPST_COMPILE_TIMEOUT_MS);

    const assets = job.assets.map((asset) => ({
      path: asset.path,
      data: asset.data.slice(),
    }));
    job.posted = true;
    created.postMessage(
      { type: "compile", id: job.id, source: job.source, assets },
      assets.map((asset) => asset.data.buffer),
    );
  })();
}

/**
 * Compiles one self-contained Typst document to SVG. Calls are serialized, and
 * every document sees only the assets passed with it.
 */
export function compileTypst(
  source: string,
  assets: readonly TypstAsset[],
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) return Promise.reject(abortError());
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const job: CompileJob = {
    id: nextId++,
    source,
    assets: [...assets],
    posted: false,
    resolve,
    reject,
    signal,
    timer: null,
    onAbort: () => {
      if (active === job) {
        failActive(abortError(), job.posted);
        return;
      }
      const index = queue.indexOf(job);
      if (index >= 0) queue.splice(index, 1);
      rejectJob(job, abortError());
    },
  };
  signal.addEventListener("abort", job.onAbort, { once: true });
  queue.push(job);
  pump();
  return promise;
}
