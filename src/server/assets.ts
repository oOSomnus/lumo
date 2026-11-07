import { readdirSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".ftl": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".ttc": "font/collection",
  ".pfb": "application/octet-stream",
  ".bcmap": "application/octet-stream",
  ".icc": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
};

export interface StaticAssets {
  serve(url: URL): Response | null;
}

function resolveVendorDirectory(name: string): string {
  if (Bun.isStandaloneExecutable) {
    return join(import.meta.dir, name);
  }
  return normalize(join(import.meta.dir, "..", "..", "vendor", name));
}

function listFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const relative = fullPath.slice(root.length + 1).split(sep).join("/");
        files.set(relative, fullPath);
      }
    }
  };
  walk(root);
  return files;
}

function loadStaticAssets(options: {
  root: string;
  prefix: string;
  requiredFiles: string[];
  requiredDirectories: string[];
  label: string;
  prepareCommand: string;
}): StaticAssets {
  for (const file of options.requiredFiles) {
    const fullPath = join(options.root, file);
    try {
      if (!statSync(fullPath).isFile()) {
        throw new Error(`${file} is not a file`);
      }
    } catch {
      throw new Error(
        `${options.label} asset ${file} is missing under ${options.root}; run "bun run prepare:${options.prepareCommand}"`,
      );
    }
  }
  for (const directory of options.requiredDirectories) {
    const fullPath = join(options.root, directory);
    let entries: string[];
    try {
      entries = readdirSync(fullPath);
    } catch {
      throw new Error(
        `${options.label} asset directory ${directory} is missing under ${options.root}; run "bun run prepare:${options.prepareCommand}"`,
      );
    }
    if (entries.length === 0) {
      throw new Error(
        `${options.label} asset directory ${directory} is empty under ${options.root}`,
      );
    }
  }

  const files = listFiles(options.root);

  return {
    serve(url: URL): Response | null {
      const relative = url.pathname.slice(options.prefix.length);
      if (!relative) return null;
      let decoded: string;
      try {
        decoded = decodeURIComponent(relative);
      } catch {
        return new Response("bad request", { status: 400 });
      }
      const fullPath = files.get(decoded);
      if (!fullPath) return null;

      const type =
        MIME_TYPES[extname(decoded).toLowerCase()] ?? "application/octet-stream";
      return new Response(Bun.file(fullPath), {
        headers: {
          "Content-Type": type,
          "X-Content-Type-Options": "nosniff",
          "Cross-Origin-Resource-Policy": "same-origin",
          "Cache-Control": "public, max-age=3600",
        },
      });
    },
  };
}

export function resolvePdfjsDirectory(): string {
  return resolveVendorDirectory("pdfjs");
}

export function loadPdfjsAssets(): StaticAssets {
  return loadStaticAssets({
    root: resolvePdfjsDirectory(),
    prefix: "/pdfjs/",
    requiredFiles: [
      "web/viewer.html",
      "web/viewer.mjs",
      "web/viewer.css",
      "build/pdf.mjs",
      "build/pdf.worker.mjs",
    ],
    requiredDirectories: [
      "web/cmaps",
      "web/standard_fonts",
      "web/wasm",
      "web/iccs",
      "web/images",
      "web/locale",
    ],
    label: "PDF.js",
    prepareCommand: "pdfjs",
  });
}

export function resolveTypstDirectory(): string {
  return resolveVendorDirectory("typst");
}

export function loadTypstAssets(): StaticAssets {
  return loadStaticAssets({
    root: resolveTypstDirectory(),
    prefix: "/typst/",
    requiredFiles: [
      "worker.js",
      "jszip.min.js",
      "epub.min.js",
      "epub-viewer.html",
      "epub-viewer.js",
      "compiler.wasm",
      "renderer.wasm",
      "fonts/LibertinusSerif-Regular.otf",
      "fonts/NewCMMath-Regular.otf",
      "fonts/DejaVuSansMono.ttf",
      "fonts/NotoSerifCJK.ttc",
    ],
    requiredDirectories: ["fonts", "licenses"],
    label: "Typst",
    prepareCommand: "typst",
  });
}
