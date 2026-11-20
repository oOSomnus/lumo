/// <reference lib="webworker" />
import {
  CompileFormatEnum,
  createTypstCompiler,
  type TypstCompiler,
} from "@myriaddreamin/typst.ts/compiler";
import {
  createTypstRenderer,
  type TypstRenderer,
} from "@myriaddreamin/typst.ts/renderer";
import {
  loadFonts,
  withAccessModel,
  withPackageRegistry,
} from "@myriaddreamin/typst.ts/dist/esm/options.init.mjs";
import type { FsAccessModel } from "@myriaddreamin/typst.ts/dist/esm/internal.types.mjs";
import { describeTypstDiagnostics } from "../shared/typst";

const MAIN_PATH = "/@memory/main.typ";
const ROOT = "/@memory";

const FONT_FILES = [
  "LibertinusSerif-Regular.otf",
  "LibertinusSerif-Bold.otf",
  "LibertinusSerif-Italic.otf",
  "LibertinusSerif-BoldItalic.otf",
  "NewCMMath-Regular.otf",
  "DejaVuSansMono.ttf",
  "NotoSerifCJK.ttc",
] as const;

const scope = self as unknown as DedicatedWorkerGlobalScope;

interface CompileRequest {
  type: "compile";
  id: number;
  source: string;
  assets: { path: string; data: Uint8Array }[];
}

interface PdfRequest {
  type: "pdf";
  id: number;
  /** The main document; `files` are the modules and images it reads, by path under the root. */
  main: string;
  files: { path: string; data: Uint8Array }[];
}

/** A failed PDF compile: the formatted diagnostics and the files they point into. */
class PdfCompileError extends Error {
  constructor(
    message: string,
    readonly paths: string[],
  ) {
    super(message);
  }
}

const files = new Map<string, Uint8Array>();
const accessModel: FsAccessModel = {
  getMTime: (path) => (files.has(path) ? new Date(0) : undefined),
  isFile: (path) => files.has(path) || path === MAIN_PATH || undefined,
  getRealPath: (path) => path,
  readAll: (path) => files.get(path),
};

let compiler: TypstCompiler | null = null;
let renderer: TypstRenderer | null = null;

async function loadFontBuffers(): Promise<Uint8Array[]> {
  return Promise.all(
    FONT_FILES.map(async (file) => {
      const response = await fetch(`/typst/fonts/${file}`, {
        credentials: "omit",
        cache: "force-cache",
      });
      if (!response.ok) {
        throw new Error(`font ${file} failed with HTTP ${response.status}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    }),
  );
}

async function initialize(): Promise<void> {
  const fonts = await loadFontBuffers();
  const nextCompiler = createTypstCompiler();
  await nextCompiler.init({
    getModule: () => "/typst/compiler.wasm",
    beforeBuild: [
      loadFonts(fonts, { assets: false }),
      withAccessModel(accessModel),
      withPackageRegistry({ resolve: () => undefined }),
    ],
  });
  const nextRenderer = createTypstRenderer();
  await nextRenderer.init({
    getModule: () => "/typst/renderer.wasm",
  });
  compiler = nextCompiler;
  renderer = nextRenderer;
}

function requireCompiler(): TypstCompiler {
  if (!compiler) throw new Error("Typst runtime is not initialized");
  return compiler;
}

function mapFiles(
  active: TypstCompiler,
  main: string,
  assets: readonly { path: string; data: Uint8Array }[],
): void {
  active.resetShadow();
  files.clear();
  active.mapShadow(MAIN_PATH, new TextEncoder().encode(main));
  for (const asset of assets) {
    const path = `${ROOT}/${asset.path}`;
    files.set(path, asset.data);
    active.mapShadow(path, asset.data);
  }
}

async function compile(request: CompileRequest): Promise<string> {
  const active = requireCompiler();
  if (!renderer) throw new Error("Typst runtime is not initialized");
  mapFiles(active, request.source, request.assets);

  const compiled = await active.compile({
    mainFilePath: MAIN_PATH,
    root: ROOT,
    inputs: {},
    diagnostics: "full",
  });
  if (!compiled.result) {
    throw new Error(describeTypstDiagnostics(request.source, compiled.diagnostics));
  }

  return renderer.renderSvg({
    format: "vector",
    artifactContent: compiled.result,
    data_selection: { body: true, defs: true, css: true, js: false },
  });
}

// Diagnostics name absolute paths; requests and replies use paths under the root.
function relativePath(path: unknown): string {
  const text = typeof path === "string" ? path : "";
  return text.startsWith(`${ROOT}/`) ? text.slice(ROOT.length + 1) : text;
}

async function compilePdf(request: PdfRequest): Promise<Uint8Array> {
  const active = requireCompiler();
  mapFiles(active, request.main, request.files);

  const compiled = await active.compile({
    mainFilePath: MAIN_PATH,
    root: ROOT,
    inputs: {},
    format: CompileFormatEnum.pdf,
    diagnostics: "full",
  });
  const result = compiled.result;
  // The reply transfers the buffer, so it must own exactly these bytes.
  if (result) {
    return result.byteOffset === 0 && result.byteLength === result.buffer.byteLength
      ? result
      : result.slice();
  }

  const diagnostics: unknown[] = Array.isArray(compiled.diagnostics)
    ? compiled.diagnostics
    : [];
  const decoder = new TextDecoder();
  const sources = new Map<string, string>([["main.typ", request.main]]);
  for (const file of request.files) {
    if (file.path.endsWith(".typ")) sources.set(file.path, decoder.decode(file.data));
  }
  const paths = [
    ...new Set(
      diagnostics.map((entry) =>
        relativePath((entry as { path?: unknown } | null)?.path),
      ),
    ),
  ].filter(Boolean);
  // Each diagnostic quotes the line of the file it points into.
  const message =
    diagnostics.length === 0
      ? describeTypstDiagnostics(request.main, diagnostics)
      : diagnostics
          .map((entry) => {
            const path = relativePath((entry as { path?: unknown } | null)?.path);
            return `${path || "?"}: ${describeTypstDiagnostics(sources.get(path) ?? "", [entry])}`;
          })
          .join("\n");
  throw new PdfCompileError(message, paths);
}

scope.onmessage = (event: MessageEvent<CompileRequest | PdfRequest>) => {
  const request = event.data;
  if (!request) return;
  if (request.type === "compile") {
    void (async () => {
      try {
        const svg = await compile(request);
        scope.postMessage({ type: "compiled", id: request.id, svg });
      } catch (error) {
        scope.postMessage({
          type: "failed",
          id: request.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return;
  }
  if (request.type === "pdf") {
    void (async () => {
      try {
        const data = await compilePdf(request);
        scope.postMessage({ type: "pdf-done", id: request.id, data }, [data.buffer]);
      } catch (error) {
        scope.postMessage({
          type: "pdf-failed",
          id: request.id,
          message: error instanceof Error ? error.message : String(error),
          paths: error instanceof PdfCompileError ? error.paths : [],
        });
      }
    })();
  }
};

void initialize().then(
  () => scope.postMessage({ type: "ready" }),
  (error: unknown) =>
    scope.postMessage({
      type: "init-error",
      message: error instanceof Error ? error.message : String(error),
    }),
);
