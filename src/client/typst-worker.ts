/// <reference lib="webworker" />
import {
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

async function compile(request: CompileRequest): Promise<string> {
  if (!compiler || !renderer) {
    throw new Error("Typst runtime is not initialized");
  }

  compiler.resetShadow();
  files.clear();
  compiler.mapShadow(MAIN_PATH, new TextEncoder().encode(request.source));
  for (const asset of request.assets) {
    const path = `${ROOT}/${asset.path}`;
    files.set(path, asset.data);
    compiler.mapShadow(path, asset.data);
  }

  const compiled = await compiler.compile({
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

scope.onmessage = (event: MessageEvent<CompileRequest>) => {
  const request = event.data;
  if (!request || request.type !== "compile") return;
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
};

void initialize().then(
  () => scope.postMessage({ type: "ready" }),
  (error: unknown) =>
    scope.postMessage({
      type: "init-error",
      message: error instanceof Error ? error.message : String(error),
    }),
);
