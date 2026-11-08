import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import JSZip from "jszip";

const VERSION = "0.7.0";
const ASSET_TAG = "v0.13.1";
const NOTO_TAG = "Serif2.003";

const TYPST_ASSETS_BASE = `https://raw.githubusercontent.com/typst/typst-assets/${ASSET_TAG}/files/fonts`;
const NOTO_URL = `https://github.com/notofonts/noto-cjk/releases/download/${NOTO_TAG}/01_NotoSerifCJK.ttc.zip`;
const NOTO_ZIP_SHA256 =
  "5009285197f068fe9a58f2cf8d6d312f4bf185887305751aae2608db4e02e48f";
const NOTO_MEMBER = "NotoSerifCJK.ttc";
const NOTO_TTC_SHA256 =
  "8d1c98899967d431422c21a7a4309cb8b14bae4610ed8ececdb782b9133cb209";

const FONTS: { name: string; sha256: string }[] = [
  {
    name: "LibertinusSerif-Regular.otf",
    sha256: "fcf06307a77367394fcb0ccb241e59eea70dba3d732be309647611224679c733",
  },
  {
    name: "LibertinusSerif-Bold.otf",
    sha256: "0264914210ed51b3231ebc92ce529e9f2e166ba9eebf0cd4a579558690a27b64",
  },
  {
    name: "LibertinusSerif-Italic.otf",
    sha256: "9a393d63d6e05f620d3dc0190dfd35a8ede58c0808cf0fc9de7fcb9c723e4c24",
  },
  {
    name: "LibertinusSerif-BoldItalic.otf",
    sha256: "47a665259f09f554f5d133d7718cdad43ff462c6a6b2328f38023465e62d57ce",
  },
  {
    name: "NewCMMath-Regular.otf",
    sha256: "bfd2f9b22caacd41b8b29cfe3f6d72f976f221a65362e07eda35cbae863721b7",
  },
  {
    name: "DejaVuSansMono.ttf",
    sha256: "b4a6c3e4faab8773f4ff761d56451646409f29abedd68f05d38c2df667d3c582",
  },
];

const LICENSE_FILES: { name: string; source: string; fromNodeModules?: boolean }[] = [
  {
    name: "typst-assets-LICENSE",
    source: `https://raw.githubusercontent.com/typst/typst-assets/${ASSET_TAG}/LICENSE`,
  },
  {
    name: "typst-assets-NOTICE",
    source: `https://raw.githubusercontent.com/typst/typst-assets/${ASSET_TAG}/NOTICE`,
  },
  {
    name: "noto-cjk-LICENSE",
    source: `https://raw.githubusercontent.com/notofonts/noto-cjk/${NOTO_TAG}/Serif/LICENSE`,
  },
  {
    name: "typst-ts-LICENSE",
    source: "node_modules/@myriaddreamin/typst.ts/LICENSE",
    fromNodeModules: true,
  },
  {
    name: "jszip-LICENSE",
    source: "node_modules/jszip/LICENSE.markdown",
    fromNodeModules: true,
  },
  {
    name: "dompurify-LICENSE",
    source: "node_modules/dompurify/LICENSE",
    fromNodeModules: true,
  },
  {
    name: "dompurify-LICENSE-MPL",
    source: "node_modules/dompurify/LICENSE-MPL",
    fromNodeModules: true,
  },
  {
    name: "epubjs-LICENSE",
    source: "node_modules/epubjs/license",
    fromNodeModules: true,
  },
];

const root = resolve(import.meta.dir, "..");
const target = join(root, "vendor", "typst");
const EPUB_FILES = [
  "jszip.min.js",
  "epub.min.js",
  "epub-viewer.html",
  "epub-viewer.js",
];
const markerPath = join(target, ".lumo-typst.json");

function cacheIsValid(): boolean {
  if (!existsSync(markerPath) || !existsSync(join(target, "worker.js"))) {
    return false;
  }
  for (const name of EPUB_FILES) {
    if (!existsSync(join(target, name))) return false;
  }
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      version?: string;
      fonts?: string[];
    };
    if (marker.version !== VERSION) return false;
    for (const name of markeredFonts()) {
      const file = join(target, "fonts", name);
      if (!existsSync(file) || !statSync(file).isFile()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function markeredFonts(): string[] {
  return [...FONTS.map((font) => font.name), NOTO_MEMBER];
}

async function download(url: string, description: string): Promise<Uint8Array> {
  console.log(`Downloading ${description}...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${description} download failed with HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function prepareFonts(): Promise<void> {
  const fontsDirectory = join(target, "fonts");
  mkdirSync(fontsDirectory, { recursive: true });

  for (const font of FONTS) {
    const destination = join(fontsDirectory, font.name);
    if (existsSync(destination) && sha256(readFileSync(destination)) === font.sha256) {
      continue;
    }
    const bytes = await download(`${TYPST_ASSETS_BASE}/${font.name}`, font.name);
    const digest = sha256(bytes);
    if (digest !== font.sha256) {
      throw new Error(
        `${font.name} checksum mismatch: expected ${font.sha256}, got ${digest}`,
      );
    }
    writeFileSync(destination, bytes);
  }

  const notoDestination = join(fontsDirectory, NOTO_MEMBER);
  if (
    existsSync(notoDestination) &&
    sha256(readFileSync(notoDestination)) === NOTO_TTC_SHA256
  ) {
    return;
  }

  const zip = await download(NOTO_URL, "Noto Serif CJK");
  const digest = sha256(zip);
  if (digest !== NOTO_ZIP_SHA256) {
    throw new Error(
      `Noto Serif CJK checksum mismatch: expected ${NOTO_ZIP_SHA256}, got ${digest}`,
    );
  }

  const member = (await JSZip.loadAsync(zip)).file(NOTO_MEMBER);
  if (!member) {
    throw new Error(`downloaded archive does not contain ${NOTO_MEMBER}`);
  }
  const font = await member.async("uint8array");
  if (sha256(font) !== NOTO_TTC_SHA256) {
    throw new Error("extracted Noto Serif CJK font checksum mismatch");
  }
  const workDirectory = mkdtempSync(join(root, "vendor", ".typst-tmp-"));
  try {
    const staged = join(workDirectory, NOTO_MEMBER);
    writeFileSync(staged, font);
    renameSync(staged, notoDestination);
  } finally {
    rmSync(workDirectory, { recursive: true, force: true });
  }
}

async function prepareLicenses(): Promise<void> {
  const directory = join(target, "licenses");
  mkdirSync(directory, { recursive: true });
  for (const license of LICENSE_FILES) {
    const destination = join(directory, license.name);
    if (existsSync(destination)) continue;
    if (license.fromNodeModules) {
      const source = join(root, license.source);
      if (!existsSync(source)) {
        throw new Error(`license file ${license.source} is missing`);
      }
      copyFileSync(source, destination);
      continue;
    }
    const bytes = await download(license.source, license.name);
    writeFileSync(destination, bytes);
  }
}

async function prepareEpub(): Promise<void> {
  copyFileSync(
    join(root, "node_modules", "jszip", "dist", "jszip.min.js"),
    join(target, "jszip.min.js"),
  );
  copyFileSync(
    join(root, "node_modules", "epubjs", "dist", "epub.min.js"),
    join(target, "epub.min.js"),
  );
  copyFileSync(
    join(root, "src", "client", "epub-viewer.html"),
    join(target, "epub-viewer.html"),
  );
  const result = await Bun.build({
    entrypoints: [join(root, "src", "client", "epub-viewer.ts")],
    target: "browser",
    format: "esm",
    minify: true,
    sourcemap: "none",
    outdir: target,
    naming: "epub-viewer.js",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("EPUB viewer bundle failed");
  }
}

async function prepareRuntime(): Promise<void> {
  const compilerPackage = join(
    root,
    "node_modules",
    "@myriaddreamin",
    "typst-ts-web-compiler",
    "pkg",
  );
  const rendererPackage = join(
    root,
    "node_modules",
    "@myriaddreamin",
    "typst-ts-renderer",
    "pkg",
  );
  copyFileSync(
    join(compilerPackage, "typst_ts_web_compiler_bg.wasm"),
    join(target, "compiler.wasm"),
  );
  copyFileSync(
    join(rendererPackage, "typst_ts_renderer_bg.wasm"),
    join(target, "renderer.wasm"),
  );

  const result = await Bun.build({
    entrypoints: [join(root, "src", "client", "typst-worker.ts")],
    target: "browser",
    format: "esm",
    minify: true,
    sourcemap: "none",
    outdir: target,
    naming: "worker.js",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("Typst worker bundle failed");
  }
}

async function main(): Promise<void> {
  mkdirSync(target, { recursive: true });

  await prepareLicenses();
  if (!cacheIsValid()) {
    await prepareFonts();
    writeFileSync(
      markerPath,
      JSON.stringify(
        { version: VERSION, assets: ASSET_TAG, noto: NOTO_TAG, fonts: markeredFonts() },
        null,
        2,
      ),
    );
  } else {
    console.log(`Typst ${VERSION} assets already prepared at ${target}`);
  }

  await prepareEpub();
  await prepareRuntime();
  console.log(`Typst ${VERSION} prepared at ${target}`);
}

await main();
