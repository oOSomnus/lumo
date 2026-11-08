import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import JSZip from "jszip";

const VERSION = "6.3.289";
const SHA256 = "98c5832ffe7af4edd59853476a478c0d4d4d76dd49c1701f4c86f7182725cdf9";
const DOWNLOAD_URL = `https://github.com/mozilla/pdf.js/releases/download/v${VERSION}/pdfjs-${VERSION}-dist.zip`;

const root = resolve(import.meta.dir, "..");
const target = join(root, "vendor", "pdfjs");
const markerPath = join(target, ".lumo-pdfjs.json");

function cacheIsValid(): boolean {
  if (!existsSync(markerPath) || !existsSync(join(target, "web", "viewer.html"))) {
    return false;
  }
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      version?: string;
      sha256?: string;
    };
    return marker.version === VERSION && marker.sha256 === SHA256;
  } catch {
    return false;
  }
}

function removeMapsAndDemo(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      removeMapsAndDemo(fullPath);
    } else if (
      entry.name.endsWith(".map") ||
      entry.name === "compressed.tracemonkey-pldi-09.pdf"
    ) {
      rmSync(fullPath, { force: true });
    }
  }
}

function assertSafeMember(name: string, base: string): string {
  if (
    name === "" ||
    name.includes("\0") ||
    name.includes("\\") ||
    isAbsolute(name) ||
    name.startsWith("/") ||
    /^[A-Za-z]:/.test(name) ||
    name.split("/").includes("..")
  ) {
    throw new Error(`unsafe archive member: ${JSON.stringify(name)}`);
  }
  const path = resolve(base, name);
  if (path !== base && !path.startsWith(base + sep)) {
    throw new Error(`unsafe archive member: ${JSON.stringify(name)}`);
  }
  return path;
}

/** Extracts regular files and directories only; no member may land outside `destination`. */
export async function extractPdfjsArchive(
  bytes: Uint8Array,
  destination: string,
): Promise<void> {
  const archive = await JSZip.loadAsync(bytes);
  const base = resolve(destination);
  const members = Object.values(archive.files).map((entry) => ({
    entry,
    path: assertSafeMember(entry.unsafeOriginalName ?? entry.name, base),
  }));
  mkdirSync(base, { recursive: true });
  for (const { entry, path } of members) {
    if (entry.dir) {
      mkdirSync(path, { recursive: true });
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, await entry.async("uint8array"));
  }
}

async function main(): Promise<void> {
  if (cacheIsValid()) {
    console.log(`PDF.js ${VERSION} already prepared at ${target}`);
    return;
  }

  console.log(`Downloading PDF.js ${VERSION}...`);
  const response = await fetch(DOWNLOAD_URL);
  if (!response.ok) {
    throw new Error(`download failed with HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (digest !== SHA256) {
    throw new Error(
      `PDF.js download checksum mismatch: expected ${SHA256}, got ${digest}`,
    );
  }

  mkdirSync(join(root, "vendor"), { recursive: true });
  const workDirectory = mkdtempSync(join(root, "vendor", ".pdfjs-tmp-"));
  try {
    const extractDirectory = join(workDirectory, "extract");
    await extractPdfjsArchive(bytes, extractDirectory);
    if (!statSync(join(extractDirectory, "web", "viewer.html")).isFile()) {
      throw new Error("downloaded archive does not contain web/viewer.html");
    }
    removeMapsAndDemo(extractDirectory);

    rmSync(target, { recursive: true, force: true });
    renameSync(extractDirectory, target);
  } finally {
    rmSync(workDirectory, { recursive: true, force: true });
  }

  writeFileSync(
    markerPath,
    JSON.stringify({ version: VERSION, sha256: SHA256 }, null, 2),
  );
  console.log(`PDF.js ${VERSION} prepared at ${target}`);
}

if (import.meta.main) await main();
