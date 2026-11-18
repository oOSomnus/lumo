import { afterEach, describe, expect, test } from "bun:test";
import type { EpubLayoutSnapshot } from "../shared/epub";
import type {
  BookLike,
  ContentsLike,
  LocatedLike,
  RenditionLike,
  SectionLike,
} from "./epub-js";
import { EpubRenditions, EpubStyleTurn } from "./epub-rendition";

interface FakeHost {
  style: { cssText: string };
  removed: boolean;
  remove(): void;
}

class FakeRendition implements RenditionLike {
  displayImpl: (target?: string | number) => Promise<unknown> = async () =>
    undefined;
  nextImpl: () => Promise<unknown> = async () => undefined;
  prevImpl: () => Promise<unknown> = async () => undefined;
  contents: ContentsLike[] = [];
  location: LocatedLike | undefined;
  destroyed = 0;
  readonly displaying = {
    resolved: 0,
    resolve(): void {
      this.resolved += 1;
    },
  };
  readonly hooks = {
    content: { register: (_hook: (contents: ContentsLike) => void): void => {} },
  };
  private readonly listeners = new Map<
    string,
    Set<(...args: never[]) => void>
  >();

  display(target?: string | number): Promise<unknown> {
    return this.displayImpl(target);
  }

  next(): Promise<unknown> {
    return this.nextImpl();
  }

  prev(): Promise<unknown> {
    return this.prevImpl();
  }

  on(name: string, listener: (...args: never[]) => void): void {
    let listeners = this.listeners.get(name);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(name, listeners);
    }
    listeners.add(listener);
  }

  once(name: string, listener: (...args: never[]) => void): void {
    this.on(name, listener);
  }

  off(name: string, listener: (...args: never[]) => void): void {
    this.listeners.get(name)?.delete(listener);
  }

  emit(name: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(name) ?? [])]) {
      (listener as (...values: unknown[]) => void)(...args);
    }
  }

  currentLocation(): LocatedLike | undefined {
    return this.location;
  }

  getContents(): ContentsLike[] {
    return this.contents;
  }

  destroy(): void {
    this.destroyed += 1;
  }
}

class FakeBook {
  readonly renditions: FakeRendition[] = [];
  destroyed = 0;

  renderTo(_target: string | HTMLElement, _options: Record<string, unknown>): RenditionLike {
    const rendition = new FakeRendition();
    this.renditions.push(rendition);
    return rendition;
  }

  destroy(): void {
    this.destroyed += 1;
  }
}

function bookLike(fake: FakeBook): BookLike {
  return {
    spine: {
      length: 0,
      get: () => null,
      hooks: { serialize: { register: () => undefined } },
    },
    ready: Promise.resolve(),
    packaging: {},
    loaded: { navigation: Promise.resolve({ toc: [] }) },
    resolve: (path) => path,
    load: async () => undefined,
    renderTo: (target, options) => fake.renderTo(target, options),
    destroy: () => fake.destroy(),
  };
}

const layout = (width = 600, fontSize = 18): EpubLayoutSnapshot => ({
  width,
  height: 800,
  style: { fontSize, fontFamily: "serif", lineHeight: 1.6, theme: "light" },
});

const section = (output: string): SectionLike => ({
  index: 0,
  href: "chapter.xhtml",
  url: "chapter.xhtml",
  output,
  load: async () => undefined,
  unload: () => undefined,
});

async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

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

let restoreGlobals: Array<() => void> = [];
let queuedFrames: FrameRequestCallback[] = [];
let hosts: FakeHost[] = [];

function installDom(): void {
  const document = {
    createElement: (): FakeHost => {
      const host: FakeHost = {
        style: { cssText: "" },
        removed: false,
        remove: () => {
          host.removed = true;
        },
      };
      hosts.push(host);
      return host;
    },
    body: { append: (_host: FakeHost): void => undefined },
  };
  restoreGlobals = [
    defineGlobal("document", document),
    defineGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      queuedFrames.push(callback);
      return queuedFrames.length;
    }),
  ];
}

function flushFrame(): void {
  const frame = queuedFrames;
  queuedFrames = [];
  for (const callback of frame) callback(0);
}

function renditionsFor(): {
  fake: FakeBook;
  foreground: FakeRendition;
  renditions: EpubRenditions;
} {
  const fake = new FakeBook();
  const foreground = new FakeRendition();
  const renditions: EpubRenditions = new EpubRenditions(
    bookLike(fake),
    foreground,
    false,
    new EpubStyleTurn(() => renditions.css),
  );
  return { fake, foreground, renditions };
}

afterEach(() => {
  for (const restore of restoreGlobals) restore();
  restoreGlobals = [];
  queuedFrames = [];
  hosts = [];
});

describe("EpubStyleTurn", () => {
  test("serializes with the active sheet, then the resting one", async () => {
    const styles = new EpubStyleTurn(() => "resting");
    const held = Promise.withResolvers<void>();
    const turn = styles.run("hidden", () => held.promise);
    await flushMicrotasks();

    const during = section("<html><head></head><body>x</body></html>");
    styles.serialize(during);
    expect(during.output).toContain("hidden");

    held.resolve();
    await turn;
    const after = section("<html><head></head><body>x</body></html>");
    styles.serialize(after);
    expect(after.output).toContain("resting");
    expect(after.output).not.toContain("hidden");
  });

  test("a held turn blocks the next one, and a rejected turn leaves the queue usable", async () => {
    const styles = new EpubStyleTurn(() => "");
    const order: string[] = [];
    const held = Promise.withResolvers<void>();
    const first = styles.run("one", async () => {
      order.push("one");
      await held.promise;
    });
    const second = styles.run("two", async () => {
      order.push("two");
    });
    await flushMicrotasks();
    expect(order).toEqual(["one"]);

    held.resolve();
    await first;
    await second;
    expect(order).toEqual(["one", "two"]);

    await expect(
      styles.run("bad", async () => {
        throw new Error("stylesheet failed");
      }),
    ).rejects.toThrow("stylesheet failed");
    expect(await styles.run("next", async () => 7)).toBe(7);
  });
});

describe("EpubRenditions", () => {
  test("display rejects when epub.js reports displayerror and releases its queue", async () => {
    const { foreground, renditions } = renditionsFor();
    foreground.displayImpl = () => new Promise(() => undefined);
    const pending = renditions.display(42);
    await flushMicrotasks();

    foreground.emit("displayerror", new Error("section missing"));
    await expect(pending).rejects.toThrow("section missing");
    expect(foreground.displaying.resolved).toBe(1);

    foreground.nextImpl = async () => "moved";
    expect(await renditions.next()).toBe("moved");
  });

  test("a batch closes its host only after the frame delay", async () => {
    installDom();
    const { fake, foreground, renditions } = renditionsFor();
    let done = false;
    const batch = renditions.withPages(layout(), async () => {
      done = true;
      return "pages";
    });
    await flushMicrotasks();
    expect(done).toBe(true);
    const hidden = fake.renditions[0]!;
    expect(hosts).toHaveLength(1);
    expect(hidden.destroyed).toBe(0);
    expect(hosts[0]?.removed).toBe(false);

    flushFrame();
    flushFrame();
    expect(await batch).toBe("pages");
    expect(hidden.destroyed).toBe(1);
    expect(hosts[0]?.removed).toBe(true);
    expect(foreground.destroyed).toBe(0);
  });

  test("a failed batch still closes its host after the frame delay", async () => {
    installDom();
    const { fake, renditions } = renditionsFor();
    const batch = renditions.withPages(layout(), async () => {
      throw new Error("paging broke");
    });
    const outcome = batch.catch((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    );
    await flushMicrotasks();
    expect(fake.renditions[0]?.destroyed).toBe(0);

    flushFrame();
    flushFrame();
    expect(await outcome).toBe("paging broke");
    expect(fake.renditions[0]?.destroyed).toBe(1);
    expect(hosts[0]?.removed).toBe(true);
  });

  test("a reference survives reuse and abort, and is replaced when the layout changes", async () => {
    installDom();
    const { fake, renditions } = renditionsFor();
    const signal = new AbortController().signal;
    expect(
      await renditions.withReference(layout(), signal, async () => "first"),
    ).toBe("first");
    const first = fake.renditions[0]!;
    await renditions.withReference(layout(), signal, async () => "again");
    expect(fake.renditions).toHaveLength(1);
    expect(first.destroyed).toBe(0);

    const stopped = new AbortController();
    stopped.abort(new DOMException("stop", "AbortError"));
    await expect(
      renditions.withReference(layout(), stopped.signal, async () => "never"),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(first.destroyed).toBe(0);

    const switching = renditions.withReference(layout(700), signal, async () => "moved");
    await flushMicrotasks();
    flushFrame();
    flushFrame();
    expect(await switching).toBe("moved");
    expect(first.destroyed).toBe(1);
    expect(hosts[0]?.removed).toBe(true);
    expect(fake.renditions).toHaveLength(2);
    expect(fake.renditions[1]?.destroyed).toBe(0);
  });

  test("a reference that fails without aborting is closed and not reused", async () => {
    installDom();
    const { fake, renditions } = renditionsFor();
    const signal = new AbortController().signal;
    await renditions.withReference(layout(), signal, async () => "built");
    const broken = fake.renditions[0]!;

    const failing = renditions.withReference(layout(), signal, async () => {
      throw new Error("reference failed");
    });
    const outcome = failing.catch((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    );
    await flushMicrotasks();
    flushFrame();
    flushFrame();
    expect(await outcome).toBe("reference failed");
    expect(broken.destroyed).toBe(1);

    await renditions.withReference(layout(), signal, async () => "rebuilt");
    expect(fake.renditions).toHaveLength(2);
  });

  test("close destroys the reference, foreground and book after the frame delay", async () => {
    installDom();
    const { fake, foreground, renditions } = renditionsFor();
    await renditions.withReference(
      layout(),
      new AbortController().signal,
      async () => "kept",
    );
    const hidden = fake.renditions[0]!;

    const closing = renditions.close();
    await flushMicrotasks();
    expect(hidden.destroyed).toBe(0);
    flushFrame();
    flushFrame();
    await closing;
    expect(hidden.destroyed).toBe(1);
    expect(foreground.destroyed).toBe(1);
    expect(fake.destroyed).toBe(1);
  });
});
