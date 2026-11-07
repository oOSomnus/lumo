import JSZip from "jszip";

const MAX_ENTRIES = 20_000;
const MAX_XML_CHARS = 2 * 1024 * 1024;
const MIMETYPE = "application/epub+zip";

// JSZip documents internalStream, but its typings leave it out.
interface ZipStream {
  on(event: "data", listener: (chunk: Uint8Array) => void): ZipStream;
  on(event: "error", listener: (error: Error) => void): ZipStream;
  on(event: "end", listener: () => void): ZipStream;
  pause(): ZipStream;
  resume(): ZipStream;
}

export class EpubPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EpubPackageError";
  }
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return match ? (match[2] ?? match[3] ?? "") : null;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function decodeHref(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function directory(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index + 1);
}

function joinPath(base: string, relative: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(relative) || relative.startsWith("//")) {
    throw new EpubPackageError("EPUB manifest references an external resource");
  }
  const parts = `${base}${relative}`.split("/");
  const output: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (output.length === 0) {
        throw new EpubPackageError("EPUB manifest escapes the archive");
      }
      output.pop();
    } else {
      output.push(part);
    }
  }
  return output.join("/");
}

/**
 * Reads one entry as UTF-8 and gives up as soon as it passes `maxChars` UTF-16 units, so a
 * compressed bomb is never inflated further than one chunk beyond the limit.
 */
function readEntryText(zip: JSZip, path: string, maxChars: number): Promise<string> {
  const file = zip.file(path);
  if (!file) return Promise.reject(new EpubPackageError(`EPUB is missing ${path}`));
  const stream = (
    file as JSZip.JSZipObject & { internalStream(type: "uint8array"): ZipStream }
  ).internalStream("uint8array");
  return new Promise((resolve, reject) => {
    // ignoreBOM keeps a leading BOM in the text, as JSZip's own decoding does: the limit counts it and a BOM-prefixed mimetype stays invalid.
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    const parts: string[] = [];
    let length = 0;
    let settled = false;
    const settle = (error?: EpubPackageError): void => {
      if (settled) return;
      settled = true;
      stream.pause();
      if (error) reject(error);
      else resolve(parts.join(""));
    };
    const take = (text: string): void => {
      length += text.length;
      if (length > maxChars) settle(new EpubPackageError(`${path} is too large`));
      else parts.push(text);
    };
    stream
      .on("data", (chunk) => {
        if (!settled) take(decoder.decode(chunk, { stream: true }));
      })
      .on("error", () => settle(new EpubPackageError(`${path} could not be read`)))
      .on("end", () => {
        if (settled) return;
        take(decoder.decode());
        settle();
      })
      .resume();
  });
}

export async function readEpubSpineCount(bytes: Uint8Array): Promise<number> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new EpubPackageError("EPUB is not a readable ZIP archive");
  }
  const entries = Object.keys(zip.files);
  if (entries.length > MAX_ENTRIES) {
    throw new EpubPackageError("EPUB contains too many entries");
  }
  if ((await readEntryText(zip, "mimetype", MIMETYPE.length)) !== MIMETYPE) {
    throw new EpubPackageError("EPUB mimetype is missing or invalid");
  }

  const container = await readEntryText(zip, "META-INF/container.xml", MAX_XML_CHARS);
  const rootfile = /<(?:[^\s<>/:]+:)?rootfile\b[^>]*>/i.exec(container)?.[0];
  if (!rootfile) throw new EpubPackageError("EPUB container has no rootfile");
  const packagePath = attribute(rootfile, "full-path");
  if (!packagePath) throw new EpubPackageError("EPUB rootfile has no path");

  const opf = await readEntryText(zip, decodeHref(packagePath), MAX_XML_CHARS);
  const base = directory(decodeHref(packagePath));
  const manifest = new Map<string, string>();
  for (const match of opf.matchAll(/<(?:[^\s<>/:]+:)?item\b[^>]*>/gi)) {
    const tag = match[0];
    const id = attribute(tag, "id");
    const href = attribute(tag, "href");
    if (!id || !href) continue;
    manifest.set(id, joinPath(base, decodeHref(href)));
  }

  let count = 0;
  for (const match of opf.matchAll(/<(?:[^\s<>/:]+:)?itemref\b[^>]*>/gi)) {
    const idref = attribute(match[0], "idref");
    if (!idref || !manifest.has(idref)) {
      throw new EpubPackageError("EPUB spine references an unknown manifest item");
    }
    // linear="no" entries count too: the reader indexes every itemref, not only linear ones.
    count += 1;
  }
  if (count === 0) throw new EpubPackageError("EPUB spine is empty");
  return count;
}
