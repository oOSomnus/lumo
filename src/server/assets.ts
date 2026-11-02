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
  ".pfb": "application/octet-stream",
  ".bcmap": "application/octet-stream",
  ".icc": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
};

const REQUIRED_FILES = [
  "web/viewer.html",
  "web/viewer.mjs",
  "web/viewer.css",
  "build/pdf.mjs",
  "build/pdf.worker.mjs",
];

const REQUIRED_DIRECTORIES = [
  "web/cmaps",
  "web/standard_fonts",
  "web/wasm",
  "web/iccs",
  "web/images",
  "web/locale",
];

export function resolvePdfjsDirectory(): string {
  if (Bun.isStandaloneExecutable) {
    return join(import.meta.dir, "pdfjs");
  }
  return normalize(join(import.meta.dir, "..", "..", "vendor", "pdfjs"));
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

export interface PdfjsAssets {
  serve(url: URL): Response | null;
}

export function loadPdfjsAssets(): PdfjsAssets {
  const root = resolvePdfjsDirectory();

  for (const file of REQUIRED_FILES) {
    const fullPath = join(root, file);
    try {
      if (!statSync(fullPath).isFile()) {
        throw new Error(`${file} is not a file`);
      }
    } catch {
      throw new Error(
        `PDF.js asset ${file} is missing under ${root}; run "bun run prepare:pdfjs"`,
      );
    }
  }
  for (const directory of REQUIRED_DIRECTORIES) {
    const fullPath = join(root, directory);
    let entries: string[];
    try {
      entries = readdirSync(fullPath);
    } catch {
      throw new Error(
        `PDF.js asset directory ${directory} is missing under ${root}; run "bun run prepare:pdfjs"`,
      );
    }
    if (entries.length === 0) {
      throw new Error(`PDF.js asset directory ${directory} is empty under ${root}`);
    }
  }

  const files = listFiles(root);

  return {
    serve(url: URL): Response | null {
      const relative = url.pathname.slice("/pdfjs/".length);
      if (!relative) return null;
      let decoded: string;
      try {
        decoded = decodeURIComponent(relative);
      } catch {
        return new Response("bad request", { status: 400 });
      }
      const fullPath = files.get(decoded);
      if (!fullPath) return null;

      const type = MIME_TYPES[extname(decoded).toLowerCase()] ??
        "application/octet-stream";
      const response = new Response(Bun.file(fullPath), {
        headers: {
          "Content-Type": type,
          "X-Content-Type-Options": "nosniff",
          "Cross-Origin-Resource-Policy": "same-origin",
          "Cache-Control": "public, max-age=3600",
        },
      });
      return response;
    },
  };
}
