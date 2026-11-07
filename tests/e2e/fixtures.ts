import {
  expect,
  request as playwrightRequest,
  test as base,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import JSZip from "jszip";

export interface DocumentRecord {
  id: string;
  name: string;
  pageCount: number;
}

export interface LumoApp {
  url: string;
  api: APIRequestContext;
}

const STARTUP_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;

function redact(text: string): string {
  return text
    .replace(/([?&]token=)[^\s&]+/g, "$1***")
    .replace(/Bearer\s+\S+/g, "Bearer ***");
}

export function fixturePdf(label: string, pageCount = 2): Uint8Array {
  const pageIds = [
    3,
    ...Array.from({ length: pageCount - 1 }, (_, i) => i + 7),
  ];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /AcroForm 6 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /Helv 4 0 R >> >> /Annots [5 0 R] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Type /Annot /Subtype /Widget /FT /Tx /T (note) /V (${label}) /Rect [40 300 300 330] /P 3 0 R /F 4 /DA (/Helv 12 Tf 0 g) >>`,
    "<< /Fields [5 0 R] /DR << /Font << /Helv 4 0 R >> >> /DA (/Helv 12 Tf 0 g) /NeedAppearances true >>",
  ];
  for (let i = 1; i < pageCount; i++) {
    objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << >> >>");
  }
  let pdf = "%PDF-1.7\n";
  const offsets: number[] = [];
  for (const [i, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

export async function uploadPdf(
  api: APIRequestContext,
  name: string,
  pageCount: number,
  label = name,
): Promise<DocumentRecord> {
  const query = new URLSearchParams({
    name,
    pageCount: String(pageCount),
    format: "pdf",
  });
  const response = await api.post(`/api/documents?${query}`, {
    headers: { "Content-Type": "application/pdf" },
    data: Buffer.from(fixturePdf(label, pageCount)),
  });
  expect(response.ok(), `upload ${name} failed with HTTP ${response.status()}`).toBe(true);
  return (await response.json()) as DocumentRecord;
}

export const LONG_EPUB_PARAGRAPHS = 60;

/** One chapter long enough for several screens; its two anchored headings always start a screen page, whatever the text size. */
function longChapterXhtml(): string {
  const paragraphs = Array.from({ length: LONG_EPUB_PARAGRAPHS }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    const heading =
      index === 20
        ? '<h2 id="part-a" style="break-before:column">Part A</h2>'
        : index === 40
          ? '<h2 id="part-b" style="break-before:column">Part B</h2>'
          : "";
    return `${heading}<p>Paragraph ${number}. ${"The quick brown fox jumps over the lazy dog. ".repeat(5)}</p>`;
  });
  return `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head><body><h1>Chapter One</h1>${paragraphs.join("")}</body></html>`;
}

const LONG_NAV =
  '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol><li><a href="c1.xhtml">Chapter One</a><ol><li><a href="c1.xhtml#part-a">Part A</a></li><li><a href="c1.xhtml#part-b">Part B</a></li></ol></li><li><a href="c2.xhtml">Chapter Two</a></li></ol></nav></body></html>';

/** Three screen pages: text, an image alone, text. */
export const IMAGE_PAGE_CHAPTER =
  '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head><body><h1>Chapter One</h1><p>Text before the image.</p><p style="break-before:column"><img src="images/pic.jpg" alt="tiny"/></p><p style="break-before:column">Text after the image.</p></body></html>';

/** Two screen pages: text, then an inline SVG alone, which the reader cannot translate. */
export const SVG_PAGE_CHAPTER =
  '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head><body><h1>Chapter One</h1><p>Text before the figure.</p><p style="break-before:column"><svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#888"/></svg></p></body></html>';

/** The 8x8 JPEG every fixture book carries; an export must hand back exactly these bytes. */
export const FIXTURE_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjMwLjEwMAD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABgEBAQAAAAAAAAAAAAAAAAAABgcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAAIAAgDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCLAE1/f//Z",
  "base64",
);

/** A PNG that declares `width`×`height` and stops after its header: nothing can decode it, yet it names a huge picture. */
export function pngDeclaring(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}

const MEDIA_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

/** `long` is the long chapter with contents; `chapter` replaces the first chapter's XHTML; `images` adds files under `images/`. */
export async function fixtureEpub({
  long = false,
  chapter,
  images = {},
}: {
  long?: boolean;
  chapter?: string;
  images?: Record<string, Uint8Array>;
} = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">urn:uuid:fixture</dc:identifier><dc:title>Fixture</dc:title><dc:language>en</dc:language></metadata><manifest>
      <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
      <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
      <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
      <item id="img" href="images/pic.jpg" media-type="image/jpeg"/>${Object.keys(images)
        .map(
          (name, index) =>
            `<item id="extra${index}" href="images/${name}" media-type="${MEDIA_TYPES[name.split(".").pop()!]}"/>`,
        )
        .join("")}
    </manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
  );
  zip.file(
    "OEBPS/nav.xhtml",
    long
      ? LONG_NAV
      : '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol><li><a href="c1.xhtml">Chapter One</a></li><li><a href="c2.xhtml">Chapter Two</a></li></ol></nav></body></html>',
  );
  zip.file(
    "OEBPS/c1.xhtml",
    long
      ? longChapterXhtml()
      : (chapter ??
        '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head><body><h1>Chapter One</h1><p>Hello world from EPUB.</p><img src="images/pic.jpg" alt="tiny"/></body></html>'),
  );
  zip.file(
    "OEBPS/c2.xhtml",
    '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Two</title></head><body><h1>Chapter Two</h1><p>Second section.</p></body></html>',
  );
  zip.file("OEBPS/images/pic.jpg", FIXTURE_JPEG);
  for (const [name, bytes] of Object.entries(images)) zip.file(`OEBPS/images/${name}`, bytes);
  // One fixed timestamp on every entry, directories included, keeps equal fixtures byte-identical: a book's id never depends on the clock.
  const date = new Date("2000-01-01T00:00:00Z");
  for (const entry of Object.values(zip.files)) entry.date = date;
  return zip.generateAsync({ type: "uint8array" });
}

export async function uploadEpub(
  api: APIRequestContext,
  name: string,
  options?: { long?: boolean; chapter?: string; images?: Record<string, Uint8Array> },
): Promise<DocumentRecord> {
  const query = new URLSearchParams({ name, format: "epub" });
  const response = await api.post(`/api/documents?${query}`, {
    headers: { "Content-Type": "application/epub+zip" },
    data: Buffer.from(await fixtureEpub(options)),
  });
  expect(response.ok(), `upload ${name} failed with HTTP ${response.status()}`).toBe(true);
  return (await response.json()) as DocumentRecord;
}

export async function openApp(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url);
  } catch (error) {
    throw new Error(redact(error instanceof Error ? error.message : String(error)));
  }
}

export function noteField(page: Page): Locator {
  return page
    .frameLocator("iframe.pdf-frame")
    .locator('input[name="note"]');
}

export function saveCopyButton(page: Page): Locator {
  return page.getByRole("button", {
    name: /^(?:Save edited copy|Saving copy…)$/,
  });
}

export async function openFromLibrary(page: Page, name: string): Promise<void> {
  const library = page.getByRole("main", { name: /^(?:Library|书库)$/ });
  if (!(await library.isVisible())) {
    await page
      .getByRole("button", { name: /^(?:Library|书库)$/, exact: true })
      .click();
  }
  await library
    .getByRole("button", { name, exact: true })
    .first()
    .click();
}

export const test = base.extend<{ lumo: LumoApp }>({
  lumo: async ({}, use, testInfo) => {
    const directory = mkdtempSync(join(tmpdir(), "lumo-major-"));
    const standalone = testInfo.project.name === "standalone";
    const command = standalone ? resolve("dist/lumo") : "bun";
    const args = standalone ? [] : [resolve("src/server/index.ts")];
    const child = spawn(command, args, {
      cwd: resolve("."),
      env: {
        ...process.env,
        NODE_ENV: standalone ? "production" : "development",
        LUMO_DATA_DIR: directory,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let log = "";
    let exited = false;
    const closedReady = Promise.withResolvers<void>();
    const closed = closedReady.promise;
    child.once("close", () => {
      exited = true;
      closedReady.resolve();
    });

    const ready = Promise.withResolvers<string>();
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      callback();
    };
    const inspect = (chunk: Buffer): void => {
      log += chunk.toString("utf8");
      const match = /Open in your browser: (\S+)/.exec(log);
      if (match) settle(() => ready.resolve(match[1]!));
    };
    child.stdout?.on("data", inspect);
    child.stderr?.on("data", inspect);
    const startupTimer = setTimeout(() => {
      settle(() =>
        ready.reject(
          new Error(
            `Lumo did not print its startup URL within ${STARTUP_TIMEOUT_MS}ms.\n${redact(log)}`,
          ),
        ),
      );
    }, STARTUP_TIMEOUT_MS);
    void closed.then(() => {
      settle(() =>
        ready.reject(
          new Error(`Lumo exited before it was ready.\n${redact(log)}`),
        ),
      );
    });

    let api: APIRequestContext | undefined;
    try {
      let url: string;
      try {
        url = await ready.promise;
      } finally {
        clearTimeout(startupTimer);
      }
      const parsed = new URL(url);
      const token = parsed.searchParams.get("token");
      if (!token) throw new Error("startup URL has no access code");
      api = await playwrightRequest.newContext({
        baseURL: parsed.origin,
        extraHTTPHeaders: {
          Authorization: `Bearer ${token}`,
          Origin: parsed.origin,
        },
      });
      const library = await api.get("/api/library");
      if (!library.ok()) {
        throw new Error(
          `GET /api/library failed with HTTP ${library.status()}: ${redact(await library.text())}`,
        );
      }
      await use({ url, api });
    } finally {
      await api?.dispose().catch(() => {});
      if (!exited) {
        child.kill("SIGTERM");
        let stopTimer: NodeJS.Timeout | undefined;
        const stopTimeout = new Promise<"timeout">((resolveTimeout) => {
          stopTimer = setTimeout(() => resolveTimeout("timeout"), STOP_TIMEOUT_MS);
        });
        const result = await Promise.race([
          closed.then(() => "closed" as const),
          stopTimeout,
        ]);
        clearTimeout(stopTimer);
        if (result === "timeout") {
          child.kill("SIGKILL");
          await closed;
        }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
});

export { expect };

/** Opens the export dialog, downloads every translation of the language and returns the ZIP's files by name as bytes. */
export async function downloadAllTranslations(page: Page): Promise<Record<string, Uint8Array>> {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "All translated content in this language (ZIP)" }).click(),
  ]);
  const zip = await JSZip.loadAsync(await readFile(await download.path()));
  const files: Record<string, Uint8Array> = {};
  for (const [name, file] of Object.entries(zip.files)) {
    if (!file.dir) files[name] = await file.async("uint8array");
  }
  return files;
}
