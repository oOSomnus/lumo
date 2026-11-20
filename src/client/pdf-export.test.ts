import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  buildExportMain,
  buildTranslationPdf,
  classifyExportPages,
  overridePageWidth,
  PdfExportError,
  TypstPdfCompileError,
  TypstPdfWorker,
  type ExportFile,
  type ExportOriginal,
  type PdfCompiler,
} from "./pdf-export";
import { TypstError } from "./typst";

const PREFIX =
  "#let lumo-page = (width: 210mm, height: auto, flipped: false); #set page(..lumo-page)\n";

const override = (source: string): string | null => overridePageWidth(source, "210mm");

describe("overridePageWidth", () => {
  test("appends the override to the page set rule and binds it on a first line", () => {
    expect(override("#set page(width: 180mm, height: auto, margin: 12mm)\n= Title\nBody")).toBe(
      `${PREFIX}#set page(width: 180mm, height: auto, margin: 12mm, ..lumo-page)\n= Title\nBody`,
    );
  });

  test("only binds the override when the source sets no page", () => {
    expect(override("= Title\nBody")).toBe(`${PREFIX}= Title\nBody`);
  });

  test("finds the closing parenthesis past strings, content blocks and comments", () => {
    expect(
      override('#set page(fill: rgb("#fff"), numbering: "(1)", header: [a ) "q" \\] b #text("]")[x]])'),
    ).toBe(
      `${PREFIX}#set page(fill: rgb("#fff"), numbering: "(1)", header: [a ) "q" \\] b #text("]")[x]], ..lumo-page)`,
    );
    expect(override("#set page(width: 1cm, // note )\n)")).toBe(
      `${PREFIX}#set page(width: 1cm, // note )\n..lumo-page)`,
    );
    expect(override("#set page(width: 1cm /* ) */)")).toBe(
      `${PREFIX}#set page(width: 1cm /* ) */, ..lumo-page)`,
    );
  });

  test("never adds a second comma", () => {
    expect(override("#set page(width: 1cm,)")).toBe(`${PREFIX}#set page(width: 1cm,..lumo-page)`);
    expect(override("#set page()")).toBe(`${PREFIX}#set page(..lumo-page)`);
  });

  test("overrides explicit pages, with or without arguments", () => {
    expect(override("#page(width: 1cm)[Body]")).toBe(`${PREFIX}#page(width: 1cm, ..lumo-page)[Body]`);
    expect(override("#page[Body]")).toBe(`${PREFIX}#page(..lumo-page)[Body]`);
    expect(override("#{ set page(width: 1cm); [x] }")).toBe(
      `${PREFIX}#{ set page(width: 1cm, ..lumo-page); [x] }`,
    );
    expect(override("#set page(width: 1cm) if true\nText")).toBe(
      `${PREFIX}#set page(width: 1cm, ..lumo-page) if true\nText`,
    );
  });

  test("leaves text, raw blocks, comments and other functions alone", () => {
    for (const body of [
      "See page(3) and page (4).",
      "Use `#set page(width: 1cm)` here.",
      "```typ\n#set page(width: 1cm)\n```",
      "\\#set page(width: 1cm)",
      "/* a /* b */ #set page(width: 1cm) */",
      "// #set page(width: 1cm)",
      "#my-page(width: 1cm) #x.page(width: 1cm) #page.with(width: 1cm)",
      "#let my-page(w) = w\n#set text(red)",
      '#context counter(page).display("1")',
    ]) {
      expect(override(body)).toBe(`${PREFIX}${body}`);
    }
  });

  test("reads past math whose brackets do not balance and links with double slashes", () => {
    expect(override("$[0, 1)$ #set page(width: 1cm)")).toBe(
      `${PREFIX}$[0, 1)$ #set page(width: 1cm, ..lumo-page)`,
    );
    expect(override("https://example.com/a//b #set page(width: 1cm)")).toBe(
      `${PREFIX}https://example.com/a//b #set page(width: 1cm, ..lumo-page)`,
    );
  });

  test("keeps code statements that span lines", () => {
    expect(
      override('#show heading: it => {\n  set text(red)\n  it\n}\n#set page(margin: 1cm)'),
    ).toBe(
      `${PREFIX}#show heading: it => {\n  set text(red)\n  it\n}\n#set page(margin: 1cm, ..lumo-page)`,
    );
  });

  test("gives up on a source it cannot scan", () => {
    expect(override("#set page(width: 1cm")).toBeNull();
    expect(override('#set page(numbering: "1)')).toBeNull();
    expect(override("#box[unterminated")).toBeNull();
  });
});

describe("buildExportMain", () => {
  const size = { width: 612, height: 792 };

  test("includes each translation on a new page and drops pages without one", () => {
    expect(
      buildExportMain({
        title: 'Book "1" \\ two',
        layout: "translation",
        original: "vector",
        entries: [
          { pageNumber: 2, translation: { kind: "include", path: "t/2.typ" } },
          { pageNumber: 3, translation: null },
          { pageNumber: 4, translation: { kind: "embedded", path: "t/4.pdf", pages: 2 } },
        ],
      }),
    ).toBe(
      [
        '#set document(title: "Book \\"1\\" \\\\ two")',
        "#pagebreak(weak: true)",
        '#include "t/2.typ"',
        '#page(width: auto, height: auto, margin: 0pt, image("t/4.pdf", page: 1))',
        '#page(width: auto, height: auto, margin: 0pt, image("t/4.pdf", page: 2))',
        "",
      ].join("\n"),
    );
  });

  test("puts each original before its translation and keeps originals without one", () => {
    const entries = [
      { pageNumber: 1, size, translation: { kind: "include" as const, path: "t/1.typ" } },
      { pageNumber: 2, size: { width: 300.12345, height: 400 }, translation: null },
    ];
    expect(
      buildExportMain({ title: "B", layout: "interleaved", original: "vector", entries }),
    ).toBe(
      [
        '#set document(title: "B")',
        '#page(width: 612pt, height: 792pt, margin: 0pt, image("original.pdf", page: 1, width: 100%, height: 100%, fit: "contain"))',
        "#pagebreak(weak: true)",
        '#include "t/1.typ"',
        '#page(width: 300.123pt, height: 400pt, margin: 0pt, image("original.pdf", page: 2, width: 100%, height: 100%, fit: "contain"))',
        "",
      ].join("\n"),
    );
    expect(
      buildExportMain({ title: "B", layout: "interleaved", original: "raster", entries }),
    ).toContain('image("o/2.jpg", width: 100%, height: 100%, fit: "contain")');
  });
});

describe("classifyExportPages", () => {
  test("sorts pages by what the export needs first", () => {
    const status = classifyExportPages(
      [1, 2, 3, 4, 5, 6, 7],
      new Set([1, 6]),
      [
        { pageNumber: 2, stage: "queued" },
        { pageNumber: 3, stage: "generating" },
        { pageNumber: 4, stage: "error" },
        { pageNumber: 5, stage: "cancelled", draft: { typst: "x", provider: "p", model: "m" } },
        { pageNumber: 6, stage: "generating" },
        { pageNumber: 7, stage: "cancelled" },
      ],
    );
    expect(status).toEqual({
      saved: [1, 6],
      inProgress: [2, 3],
      failed: [4],
      drafts: [5],
      untranslated: [7],
    });
  });
});

interface CompileCall {
  main: string;
  files: ExportFile[];
}

function fakeCompiler(
  respond: (call: CompileCall, index: number) => Uint8Array | Error,
): PdfCompiler & { calls: CompileCall[] } {
  const calls: CompileCall[] = [];
  return {
    calls,
    async compile(main, files) {
      const call = { main, files: [...files] };
      calls.push(call);
      const result = respond(call, calls.length - 1);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function fakeOriginal(): ExportOriginal & { rendered: number[] } {
  const rendered: number[] = [];
  return {
    rendered,
    bytes: new Uint8Array([37, 80, 68, 70]),
    async pageSize(page) {
      return { width: 600 + page, height: 800 };
    },
    async renderJpeg(page) {
      rendered.push(page);
      return new Uint8Array([page]);
    },
    async countPages(pdf) {
      return pdf.length;
    },
  };
}

const PDF = new Uint8Array([1]);
const text = (file: ExportFile | undefined): string => new TextDecoder().decode(file?.data);
const signal = () => new AbortController().signal;

describe("buildTranslationPdf", () => {
  test("typesets the saved translations at the chosen width in one document", async () => {
    const compiler = fakeCompiler(() => PDF);
    const result = await buildTranslationPdf(
      {
        title: "Book",
        layout: "translation",
        width: "letter",
        pages: [3, 1, 2],
        sources: new Map([
          [1, "#set page(width: 180mm)\nOne"],
          [3, "Three"],
        ]),
      },
      { compiler, original: fakeOriginal() },
      signal(),
    );
    expect(result).toEqual({ pdf: PDF, keptSavedWidth: [] });
    expect(compiler.calls).toHaveLength(1);
    const [call] = compiler.calls;
    expect(call!.main).toContain('#include "t/1.typ"\n#pagebreak(weak: true)\n#include "t/3.typ"');
    expect(call!.files.map((file) => file.path)).toEqual(["t/1.typ", "t/3.typ"]);
    expect(text(call!.files[0])).toContain("#set page(width: 180mm, ..lumo-page)\nOne");
    expect(text(call!.files[0])).toStartWith("#let lumo-page = (width: 8.5in,");
  });

  test("keeps saved sources untouched for the saved width, and uses original widths in points", async () => {
    const saved = fakeCompiler(() => PDF);
    await buildTranslationPdf(
      { title: "B", layout: "translation", width: "saved", pages: [1], sources: new Map([[1, "One"]]) },
      { compiler: saved, original: fakeOriginal() },
      signal(),
    );
    expect(text(saved.calls[0]!.files[0])).toBe("One");

    const matched = fakeCompiler(() => PDF);
    await buildTranslationPdf(
      { title: "B", layout: "translation", width: "original", pages: [2], sources: new Map([[2, "Two"]]) },
      { compiler: matched, original: fakeOriginal() },
      signal(),
    );
    expect(text(matched.calls[0]!.files[0])).toStartWith("#let lumo-page = (width: 602pt,");
  });

  test("refuses a selection without any saved translation", async () => {
    const promise = buildTranslationPdf(
      { title: "B", layout: "interleaved", width: "a4", pages: [1], sources: new Map() },
      { compiler: fakeCompiler(() => PDF), original: fakeOriginal() },
      signal(),
    );
    await expect(promise).rejects.toBeInstanceOf(PdfExportError);
  });

  test("embeds originals as vector pages after Typst reads them", async () => {
    const original = fakeOriginal();
    const compiler = fakeCompiler(() => PDF);
    await buildTranslationPdf(
      {
        title: "B",
        layout: "interleaved",
        width: "a4",
        pages: [1, 2],
        sources: new Map([[2, "Two"]]),
      },
      { compiler, original },
      signal(),
    );
    expect(compiler.calls.map((call) => call.main)).toHaveLength(2);
    expect(compiler.calls[0]!.main).toBe('#image("original.pdf", page: 1)');
    const main = compiler.calls[1]!.main;
    expect(main).toContain('#page(width: 601pt, height: 800pt, margin: 0pt, image("original.pdf", page: 1,');
    expect(main.indexOf('page: 2, width')).toBeLessThan(main.indexOf('#include "t/2.typ"'));
    expect(compiler.calls[1]!.files.at(-1)).toEqual({ path: "original.pdf", data: original.bytes });
    expect(original.rendered).toEqual([]);
  });

  test("renders originals Typst cannot read", async () => {
    const original = fakeOriginal();
    const progress: unknown[] = [];
    const compiler = fakeCompiler((_call, index) =>
      index === 0 ? new TypstPdfCompileError("encrypted", ["main.typ"]) : PDF,
    );
    await buildTranslationPdf(
      { title: "B", layout: "interleaved", width: "a4", pages: [1, 2], sources: new Map([[1, "One"]]) },
      { compiler, original },
      signal(),
      (value) => progress.push(value),
    );
    expect(original.rendered).toEqual([1, 2]);
    const final = compiler.calls.at(-1)!;
    expect(final.main).toContain('image("o/1.jpg"');
    expect(final.files.map((file) => file.path)).toEqual(["t/1.typ", "o/1.jpg", "o/2.jpg"]);
    expect(progress).toContainEqual({ phase: "originals", done: 2, total: 2 });
  });

  test("falls back to rendered originals when the combined document fails outside the translations", async () => {
    const original = fakeOriginal();
    const compiler = fakeCompiler((_call, index) =>
      index === 1 ? new TypstPdfCompileError("bad page", ["main.typ"]) : PDF,
    );
    await buildTranslationPdf(
      { title: "B", layout: "interleaved", width: "a4", pages: [1], sources: new Map([[1, "One"]]) },
      { compiler, original },
      signal(),
    );
    expect(original.rendered).toEqual([1]);
    expect(compiler.calls).toHaveLength(3);
  });

  test("compiles a translation that breaks the document on its own", async () => {
    const compiler = fakeCompiler((call, index) => {
      if (index === 0) return new TypstPdfCompileError("conflict", ["t/2.typ", "main.typ"]);
      if (call.main.startsWith("#let lumo-page")) return new Uint8Array([9, 9]);
      return PDF;
    });
    const result = await buildTranslationPdf(
      {
        title: "B",
        layout: "translation",
        width: "a4",
        pages: [1, 2],
        sources: new Map([
          [1, "One"],
          [2, "Two"],
        ]),
      },
      { compiler, original: fakeOriginal() },
      signal(),
    );
    expect(result.keptSavedWidth).toEqual([]);
    const final = compiler.calls.at(-1)!;
    expect(final.main).toContain('#include "t/1.typ"');
    expect(final.main).toContain('image("t/2.pdf", page: 1)');
    expect(final.main).toContain('image("t/2.pdf", page: 2)');
    expect(final.files.find((file) => file.path === "t/2.pdf")?.data).toEqual(new Uint8Array([9, 9]));
  });

  test("keeps the saved width of a translation the width override breaks", async () => {
    const compiler = fakeCompiler((call, index) => {
      if (index === 0) return new TypstPdfCompileError("conflict", ["t/1.typ"]);
      if (call.main.startsWith("#let lumo-page")) return new TypstPdfCompileError("width", ["main.typ"]);
      return PDF;
    });
    const result = await buildTranslationPdf(
      { title: "B", layout: "translation", width: "a4", pages: [1], sources: new Map([[1, "One"]]) },
      { compiler, original: fakeOriginal() },
      signal(),
    );
    expect(result.keptSavedWidth).toEqual([1]);
    expect(compiler.calls.map((call) => call.main)).toContain("One");
  });

  test("reports pages it could not scan as kept at their saved width", async () => {
    const compiler = fakeCompiler(() => PDF);
    const result = await buildTranslationPdf(
      { title: "B", layout: "translation", width: "a4", pages: [1], sources: new Map([[1, "#box[open"]]) },
      { compiler, original: fakeOriginal() },
      signal(),
    );
    expect(result.keptSavedWidth).toEqual([1]);
    expect(text(compiler.calls[0]!.files[0])).toBe("#box[open");
  });

  test("passes on failures it cannot attribute and runtime errors", async () => {
    const unattributed = buildTranslationPdf(
      { title: "B", layout: "translation", width: "a4", pages: [1], sources: new Map([[1, "One"]]) },
      { compiler: fakeCompiler(() => new TypstPdfCompileError("main", ["main.typ"])), original: fakeOriginal() },
      signal(),
    );
    await expect(unattributed).rejects.toBeInstanceOf(TypstPdfCompileError);

    const runtime = buildTranslationPdf(
      { title: "B", layout: "interleaved", width: "a4", pages: [1], sources: new Map([[1, "One"]]) },
      {
        compiler: fakeCompiler(() => new TypstError("TYPST_RUNTIME_UNAVAILABLE", "gone")),
        original: fakeOriginal(),
      },
      signal(),
    );
    await expect(runtime).rejects.toMatchObject({ code: "TYPST_RUNTIME_UNAVAILABLE" });
  });
});

// Stands in for the Worker: each test plays the messages the real worker sends.
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  readonly posted: { message: { id: number; main: string; files: ExportFile[] }; transfer: unknown[] }[] = [];
  terminated = 0;

  constructor(
    readonly url: URL,
    readonly options: WorkerOptions,
  ) {
    FakeWorker.instances.push(this);
  }

  postMessage(message: { id: number; main: string; files: ExportFile[] }, transfer: unknown[]): void {
    this.posted.push({ message, transfer });
  }

  terminate(): void {
    this.terminated += 1;
  }

  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("TypstPdfWorker", () => {
  const originalWorker = globalThis.Worker;
  const originalLocation = globalThis.location;

  beforeAll(() => {
    (globalThis as { Worker: unknown }).Worker = FakeWorker;
    (globalThis as { location: unknown }).location = { origin: "http://localhost" };
  });

  afterAll(() => {
    (globalThis as { Worker: unknown }).Worker = originalWorker;
    (globalThis as { location: unknown }).location = originalLocation;
  });

  beforeEach(() => {
    FakeWorker.instances = [];
  });

  test("posts copies of the files once the runtime is ready and returns the PDF", async () => {
    const compiler = new TypstPdfWorker();
    const data = new Uint8Array([1, 2, 3]);
    const result = compiler.compile("main", [{ path: "original.pdf", data }], signal());
    const worker = FakeWorker.instances[0]!;
    expect(worker.options).toEqual({ type: "module", name: "lumo-typst-pdf" });
    expect(worker.posted).toHaveLength(0);
    worker.emit({ type: "ready" });
    await flush();
    const { message, transfer } = worker.posted[0]!;
    expect(message.main).toBe("main");
    expect(message.files[0]!.data).toEqual(data);
    expect(message.files[0]!.data).not.toBe(data);
    expect(transfer).toEqual([message.files[0]!.data.buffer]);
    worker.emit({ type: "pdf-done", id: message.id, data: PDF });
    expect(await result).toBe(PDF);
    compiler.close();
    expect(worker.terminated).toBe(1);
  });

  test("reports the files a failed compile points into", async () => {
    const compiler = new TypstPdfWorker();
    const result = compiler.compile("main", [], signal());
    const worker = FakeWorker.instances[0]!;
    worker.emit({ type: "ready" });
    await flush();
    worker.emit({ type: "pdf-failed", id: worker.posted[0]!.message.id, message: "bad", paths: ["t/2.typ"] });
    const error = await result.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(TypstPdfCompileError);
    expect(error).toMatchObject({ code: "TYPST_COMPILE_FAILED", message: "bad", paths: ["t/2.typ"] });
  });

  test("cancelling terminates the worker", async () => {
    const compiler = new TypstPdfWorker();
    const controller = new AbortController();
    const result = compiler.compile("main", [], controller.signal);
    const worker = FakeWorker.instances[0]!;
    worker.emit({ type: "ready" });
    await flush();
    controller.abort();
    expect(await result.catch((value: unknown) => value)).toMatchObject({ name: "AbortError" });
    expect(worker.terminated).toBe(1);
  });

  test("fails when the runtime cannot start", async () => {
    const compiler = new TypstPdfWorker();
    const result = compiler.compile("main", [], signal());
    FakeWorker.instances[0]!.emit({ type: "init-error", message: "no wasm" });
    expect(await result.catch((value: unknown) => value)).toMatchObject({
      code: "TYPST_RUNTIME_UNAVAILABLE",
      message: "no wasm",
    });
    expect(FakeWorker.instances[0]!.terminated).toBe(1);
  });
});
