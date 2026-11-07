import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  compileTypst,
  TYPST_COMPILE_TIMEOUT_MS,
  type TypstAsset,
} from "./typst";

interface CompileMessage {
  type: "compile";
  id: number;
  source: string;
  assets: TypstAsset[];
}

// Stands in for the Worker: each test plays the messages the real worker sends.
class FakeWorker {
  static instances: FakeWorker[] = [];

  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  readonly posted: { message: CompileMessage; transfer: unknown[] }[] = [];
  terminated = 0;

  constructor(
    readonly url: URL,
    readonly options: WorkerOptions,
  ) {
    FakeWorker.instances.push(this);
  }

  postMessage(message: CompileMessage, transfer: unknown[]): void {
    this.posted.push({ message, transfer });
  }

  terminate(): void {
    this.terminated += 1;
  }

  emit(data: unknown): void {
    this.onmessage?.({ data });
  }

  crash(message = ""): void {
    this.onerror?.({ message });
  }

  lastMessage(): CompileMessage {
    const last = this.posted.at(-1);
    if (!last) throw new Error("nothing was posted to the Worker");
    return last.message;
  }
}

type Outcome = { ok: true; svg: string } | { ok: false; error: unknown };

// Attaches handlers at once, so a cancelled compile never looks unhandled.
function outcomeOf(compile: Promise<string>): Promise<Outcome> {
  return compile.then(
    (svg): Outcome => ({ ok: true, svg }),
    (error: unknown): Outcome => ({ ok: false, error }),
  );
}

async function rejectionOf(outcome: Promise<Outcome>): Promise<unknown> {
  const result = await outcome;
  if (result.ok) throw new Error(`expected a rejection, got ${result.svg}`);
  return result.error;
}

function latestWorker(): FakeWorker {
  const worker = FakeWorker.instances.at(-1);
  if (!worker) throw new Error("no Worker was created");
  return worker;
}

// Yields to microtasks only: the job is posted in a microtask after `ready`.
async function flush(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}
const signal = () => new AbortController().signal;

function defineGlobal(name: string, value: unknown): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
  return () => {
    if (original) Object.defineProperty(globalThis, name, original);
    else Reflect.deleteProperty(globalThis, name);
  };
}

describe("compileTypst Worker lifecycle", () => {
  let restoreGlobals: (() => void)[] = [];

  beforeAll(() => {
    restoreGlobals = [
      defineGlobal("Worker", FakeWorker),
      defineGlobal("location", { origin: "http://localhost" }),
    ];
  });

  afterAll(() => {
    for (const restore of restoreGlobals) restore();
  });

  beforeEach(() => {
    FakeWorker.instances = [];
  });

  afterEach(() => {
    // Retire a live instance so the next test starts with an idle module.
    const live = FakeWorker.instances.at(-1);
    if (live && live.terminated === 0) live.crash("test teardown");
  });

  test("cancels during initialization share one Worker and never reach it", async () => {
    const cancels = Array.from({ length: 8 }, () => {
      const controller = new AbortController();
      const outcome = outcomeOf(compileTypst("stale", [], controller.signal));
      controller.abort();
      return outcome;
    });
    const live = outcomeOf(compileTypst("live", [], signal()));

    expect(FakeWorker.instances).toHaveLength(1);
    const worker = latestWorker();
    expect(String(worker.url)).toBe("http://localhost/typst/worker.js");
    expect(worker.options).toEqual({ type: "module", name: "lumo-typst" });
    for (const outcome of cancels) {
      expect(await rejectionOf(outcome)).toMatchObject({ name: "AbortError" });
    }

    worker.emit({ type: "ready" });
    await flush();
    expect(worker.posted).toHaveLength(1);
    const job = worker.lastMessage();
    expect(job.source).toBe("live");
    worker.emit({ type: "compiled", id: job.id, svg: "<svg>live</svg>" });
    expect(await live).toEqual({ ok: true, svg: "<svg>live</svg>" });
    expect(worker.terminated).toBe(0);
  });

  test("aborting a posted compile terminates its Worker; late traffic from it is ignored", async () => {
    const controller = new AbortController();
    const first = outcomeOf(compileTypst("first", [], controller.signal));
    const old = latestWorker();
    old.emit({ type: "ready" });
    await flush();
    const firstJob = old.lastMessage();

    controller.abort();
    expect(old.terminated).toBe(1);
    expect(await rejectionOf(first)).toMatchObject({ name: "AbortError" });

    const second = outcomeOf(compileTypst("second", [], signal()));
    const fresh = latestWorker();
    expect(fresh).not.toBe(old);
    // Stale message aimed at the id the next job receives (ids are sequential).
    old.emit({ type: "compiled", id: firstJob.id + 1, svg: "<svg>stale</svg>" });
    old.crash("late crash");
    expect(fresh.terminated).toBe(0);

    fresh.emit({ type: "ready" });
    await flush();
    const secondJob = fresh.lastMessage();
    expect(secondJob.id).toBe(firstJob.id + 1);
    expect(secondJob.source).toBe("second");
    fresh.emit({ type: "compiled", id: secondJob.id, svg: "<svg>second</svg>" });
    expect(await second).toEqual({ ok: true, svg: "<svg>second</svg>" });
    expect(old.terminated).toBe(1);
  });

  test("an init failure rejects its waiter, terminates the dead Worker, and the next compile retries", async () => {
    const broken = outcomeOf(compileTypst("broken", [], signal()));
    const dead = latestWorker();
    dead.emit({ type: "init-error", message: "boom" });
    expect(dead.terminated).toBe(1);
    expect(await rejectionOf(broken)).toMatchObject({
      code: "TYPST_RUNTIME_UNAVAILABLE",
    });

    const retry = outcomeOf(compileTypst("retry", [], signal()));
    const fresh = latestWorker();
    expect(fresh).not.toBe(dead);
    fresh.emit({ type: "ready" });
    await flush();
    fresh.emit({
      type: "compiled",
      id: fresh.lastMessage().id,
      svg: "<svg>retry</svg>",
    });
    expect(await retry).toEqual({ ok: true, svg: "<svg>retry</svg>" });
    expect(dead.terminated).toBe(1);
  });

  test("a finished compile returns its SVG; the next reuses the Worker and sees only its own assets", async () => {
    const data = new Uint8Array([1, 2, 3]);
    const first = outcomeOf(
      compileTypst("first", [{ path: "a.png", data }], signal()),
    );
    const worker = latestWorker();
    worker.emit({ type: "ready" });
    await flush();
    const firstJob = worker.lastMessage();
    expect(firstJob.assets).toEqual([
      { path: "a.png", data: new Uint8Array([1, 2, 3]) },
    ]);
    // The Worker receives a copy, so the caller's bytes are neither moved nor detached.
    expect(worker.posted[0]?.transfer).not.toContain(data.buffer);
    expect(data.byteLength).toBe(3);
    worker.emit({ type: "compiled", id: firstJob.id, svg: "<svg>first</svg>" });
    expect(await first).toEqual({ ok: true, svg: "<svg>first</svg>" });

    const second = outcomeOf(compileTypst("second", [], signal()));
    await flush();
    expect(FakeWorker.instances).toHaveLength(1);
    const secondJob = worker.lastMessage();
    expect(secondJob.source).toBe("second");
    expect(secondJob.assets).toEqual([]);
    worker.emit({ type: "failed", id: secondJob.id, message: "bad source" });
    expect(await rejectionOf(second)).toMatchObject({
      code: "TYPST_COMPILE_FAILED",
    });
    expect(worker.terminated).toBe(0);
  });

  test("a crash while idle clears the Worker so the next compile starts a fresh one", async () => {
    const done = outcomeOf(compileTypst("done", [], signal()));
    const old = latestWorker();
    old.emit({ type: "ready" });
    await flush();
    old.emit({
      type: "compiled",
      id: old.lastMessage().id,
      svg: "<svg>done</svg>",
    });
    expect(await done).toEqual({ ok: true, svg: "<svg>done</svg>" });

    old.crash("crashed");
    expect(old.terminated).toBe(1);

    const next = outcomeOf(compileTypst("next", [], signal()));
    const fresh = latestWorker();
    expect(fresh).not.toBe(old);
    fresh.emit({ type: "ready" });
    await flush();
    fresh.emit({
      type: "compiled",
      id: fresh.lastMessage().id,
      svg: "<svg>next</svg>",
    });
    expect(await next).toEqual({ ok: true, svg: "<svg>next</svg>" });
  });

  test("a posted compile that never answers times out and terminates its Worker", async () => {
    const timers: { callback: () => void; ms: number }[] = [];
    const restoreTimers = [
      defineGlobal("setTimeout", (callback: () => void, ms: number) => {
        timers.push({ callback, ms });
        return timers.length;
      }),
      defineGlobal("clearTimeout", () => undefined),
    ];
    try {
      const hung = outcomeOf(compileTypst("hung", [], signal()));
      const worker = latestWorker();
      worker.emit({ type: "ready" });
      await flush();
      const timer = timers.find(
        (entry) => entry.ms === TYPST_COMPILE_TIMEOUT_MS,
      );
      if (!timer) throw new Error("compile timeout was not armed");
      timer.callback();
      expect(worker.terminated).toBe(1);
      expect(await rejectionOf(hung)).toMatchObject({
        code: "TYPST_COMPILE_TIMEOUT",
      });
    } finally {
      for (const restore of restoreTimers) restore();
    }
  });
});
