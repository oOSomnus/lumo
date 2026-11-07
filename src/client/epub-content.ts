import { MAX_CONTEXT_IMAGE_BASE64_CHARS, MAX_PAGE_TEXT_CHARS } from "../shared/limits";
import { EpubBridgeError } from "./epub-bridge";
import { canDecodeImage } from "./epub-image";
import type { CfiLike, EpubBook, EpubGlobal, SectionLike } from "./epub-js";
import { pageSignature } from "./epub-page";
import type { TypstAsset } from "./typst";

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const MAX_PREVIEW_BASE64 = 5_500_000;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_IMAGES = 256;

interface PreparedImage {
  path: string;
  imageBase64: string;
}

interface Extracted {
  xhtml: string;
  images: PreparedImage[];
  assets: TypstAsset[];
}

interface LoadedImage {
  data: Uint8Array;
  mime: string;
  ext: string;
}

function relPath(sectionHref: string, src: string): string | null {
  if (!src || /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(src)) return null;
  try {
    const url = new URL(src, `https://epub.invalid/${sectionHref}`);
    return decodeURIComponent(url.pathname.slice(1));
  } catch {
    return null;
  }
}

function mimeFromBytes(bytes: Uint8Array): { mime: string; ext: string } | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { mime: "image/png", ext: "png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { mime: "image/gif", ext: "gif" };
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart();
  if ((head.startsWith("<?xml") || head.startsWith("<svg")) && head.includes("<svg")) {
    return { mime: "image/svg+xml", ext: "svg" };
  }
  return null;
}

async function toBytes(value: unknown): Promise<Uint8Array | null> {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return btoa(binary);
}

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function pngImage(bytes: Uint8Array, mime: string): Promise<Uint8Array | null> {
  if (!canDecodeImage(bytes, mime)) return null;
  try {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mime }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await canvasBlob(canvas, "image/png");
    canvas.width = canvas.height = 0;
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/** The bitmap on a white background, longest edge `edge` pixels at most, as base64 JPEG. */
async function encodeJpeg(bitmap: ImageBitmap, edge: number, quality: number): Promise<string | null> {
  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await canvasBlob(canvas, "image/jpeg", quality);
  canvas.width = canvas.height = 0;
  return blob ? bytesToBase64(new Uint8Array(await blob.arrayBuffer())) : null;
}

async function jpegPreview(bytes: Uint8Array, mime: string): Promise<string | null> {
  if (mime === "image/jpeg") return bytesToBase64(bytes);
  if (mime === "image/svg+xml" || !canDecodeImage(bytes, mime)) return null;
  try {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mime }));
    try {
      return await encodeJpeg(bitmap, 1600, 0.86);
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

/** A neighbour reference: shrunk until its base64 fits the request limit; null for an image that cannot be a JPEG (SVG). Throws for one too large to decode. */
async function contextJpeg(bytes: Uint8Array, mime: string): Promise<string | null> {
  if (mime === "image/svg+xml") return null;
  if (!canDecodeImage(bytes, mime)) throw new Error("the image is too large or unreadable to decode");
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mime }));
  try {
    let edge = Math.min(1000, Math.max(bitmap.width, bitmap.height));
    for (; edge >= 1; edge *= 0.75) {
      const base64 = await encodeJpeg(bitmap, edge, 0.75);
      if (base64 !== null && base64.length <= MAX_CONTEXT_IMAGE_BASE64_CHARS) return base64;
    }
    return null;
  } finally {
    bitmap.close();
  }
}

const unavailable = (message: string): EpubBridgeError =>
  new EpubBridgeError("EPUB_PAGE_UNAVAILABLE", message);

export interface EpubContent {
  /** The XHTML of the range with its images renamed to `assets/<hash>.<ext>`, and their previews. */
  prepare(sourceCfi: string, signal: AbortSignal): Promise<{ xhtml: string; images: PreparedImage[] }>;
  /** The original image files of the range at those paths. */
  assets(sourceCfi: string, signal: AbortSignal): Promise<readonly TypstAsset[]>;
  /** The range as the section document holds it, to check a live range against; null when it does not resolve. */
  signatureOf(sourceCfi: string): Promise<string | null>;
  /** The image of the range nearest `edge`, as a JPEG within the context budget; null when it has none. */
  edgeImage(sourceCfi: string, edge: "start" | "end", signal: AbortSignal): Promise<string | null>;
  /** The section the reader is on keeps its parsed document; every other one is released once idle. */
  keep(sectionIndex: number | null): void;
  /** Releases the parsed document of a section nobody uses. */
  release(sectionIndex: number): void;
  dispose(): void;
}

/**
 * Reads what a translation needs from the section documents of one open book.
 * Ranges are resolved against the book's own parsed documents, never against
 * what a rendition shows, so reading never moves or restyles the screen.
 */
export function createEpubContent(book: EpubBook, Cfi: EpubGlobal["CFI"]): EpubContent {
  const packageDirectory = book.path?.directory ?? "";
  const packageRelative = (path: string): string =>
    packageDirectory && path.startsWith(packageDirectory) ? path.slice(packageDirectory.length) : path;
  const loadArchive = (path: string): Promise<unknown> => book.load(packageRelative(path));
  const loadBlob = (path: string): Promise<unknown> =>
    book.archive
      ? book.archive.request(book.resolve(packageRelative(path)), "blob")
      : loadArchive(path);

  const users = new Map<number, number>();
  let pinned: number | null = null;
  // shortcut: one completed range is kept; a page turn between prepare and validate would read the images again.
  let cached: { cfi: string; value: Extracted } | null = null;

  const parse = (sourceCfi: string): CfiLike => {
    try {
      const cfi = new Cfi(sourceCfi);
      if (cfi.spinePos >= 0 && book.spine.get(cfi.spinePos)) return cfi;
    } catch {
      // falls through: an unreadable CFI is an unavailable range
    }
    throw unavailable("the range is not part of this book");
  };

  const release = (index: number): void => {
    if (!users.has(index) && index !== pinned) book.spine.get(index)?.unload();
  };

  async function withSection<T>(index: number, use: (section: SectionLike) => Promise<T> | T): Promise<T> {
    const section = book.spine.get(index);
    if (!section) throw unavailable("the section is outside the spine");
    users.set(index, (users.get(index) ?? 0) + 1);
    try {
      await section.load(loadArchive);
      return await use(section);
    } finally {
      const left = (users.get(index) ?? 1) - 1;
      if (left > 0) users.set(index, left);
      else users.delete(index);
      release(index);
    }
  }

  const rangeIn = (section: SectionLike, cfi: CfiLike): Range => {
    const range = section.document ? cfi.toRange(section.document) : null;
    if (!range) throw unavailable("the range does not resolve in its section");
    // A range of one image is written as the position of that image.
    if (range.collapsed && range.startContainer.nodeType === Node.ELEMENT_NODE) {
      range.selectNode(range.startContainer);
    }
    if (range.collapsed) throw unavailable("the range is empty");
    return range;
  };

  async function loadImage(path: string): Promise<LoadedImage | null> {
    let bytes: Uint8Array | null;
    try {
      bytes = await toBytes(await loadBlob(path));
    } catch {
      return null;
    }
    if (!bytes) return null;
    let kind = mimeFromBytes(bytes);
    if (!kind) return null;
    if (kind.mime === "image/webp") {
      const png = await pngImage(bytes, kind.mime);
      if (!png) return null;
      bytes = png;
      kind = { mime: "image/png", ext: "png" };
    }
    return { data: bytes, ...kind };
  }

  async function build(section: SectionLike, range: Range, signal: AbortSignal): Promise<Extracted> {
    const holder = section.document!.createElementNS(XHTML_NS, "body");
    holder.append(range.cloneContents());
    for (const source of [...holder.getElementsByTagName("source")]) source.remove();

    const images: PreparedImage[] = [];
    const assets: TypstAsset[] = [];
    // A path read once keeps its asset name however often the range refers to it.
    const named = new Map<string, string | null>();
    let previewChars = 0;
    let assetBytes = 0;
    for (const image of [...holder.getElementsByTagName("img")]) {
      signal.throwIfAborted();
      image.removeAttribute("srcset");
      image.removeAttribute("sizes");
      const src = image.getAttribute("src");
      if (!src) continue;
      const path = relPath(section.href, src);
      if (!path) {
        image.remove();
        continue;
      }
      let assetPath = named.get(path);
      if (assetPath === undefined) {
        const loaded = await loadImage(path);
        signal.throwIfAborted();
        if (!loaded) {
          assetPath = null;
        } else {
          assetPath = `assets/${await digest(loaded.data)}.${loaded.ext}`;
          if (!assets.some((asset) => asset.path === assetPath)) {
            assetBytes += loaded.data.byteLength;
            if (assetBytes > MAX_ASSET_BYTES) {
              throw new EpubBridgeError("PAGE_ASSETS_TOO_LARGE", "the images of this range are too large");
            }
            assets.push({ path: assetPath, data: loaded.data });
            const imageBase64 = await jpegPreview(loaded.data, loaded.mime);
            if (imageBase64 && images.length < MAX_IMAGES && previewChars + imageBase64.length <= MAX_PREVIEW_BASE64) {
              previewChars += imageBase64.length;
              images.push({ path: assetPath, imageBase64 });
            }
          }
        }
        named.set(path, assetPath);
      }
      if (assetPath === null) image.remove();
      else image.setAttribute("src", assetPath);
    }

    const xhtml = new XMLSerializer().serializeToString(holder);
    if (xhtml.length > MAX_PAGE_TEXT_CHARS) {
      throw new EpubBridgeError("EPUB_PAGE_TOO_LARGE", `this range is ${xhtml.length} characters`);
    }
    return { xhtml, images, assets };
  }

  async function extract(sourceCfi: string, signal: AbortSignal): Promise<Extracted> {
    signal.throwIfAborted();
    if (cached?.cfi === sourceCfi) return cached.value;
    const cfi = parse(sourceCfi);
    const value = await withSection(cfi.spinePos, (section) => build(section, rangeIn(section, cfi), signal));
    cached = { cfi: sourceCfi, value };
    return value;
  }

  return {
    async prepare(sourceCfi, signal) {
      const { xhtml, images } = await extract(sourceCfi, signal);
      return { xhtml, images };
    },
    async assets(sourceCfi, signal) {
      return (await extract(sourceCfi, signal)).assets;
    },
    async signatureOf(sourceCfi) {
      try {
        const cfi = parse(sourceCfi);
        return await withSection(cfi.spinePos, (section) => pageSignature(rangeIn(section, cfi)));
      } catch {
        return null;
      }
    },
    async edgeImage(sourceCfi, edge, signal) {
      const cfi = parse(sourceCfi);
      return withSection(cfi.spinePos, async (section) => {
        const range = rangeIn(section, cfi);
        const inRange = [...section.document!.body.getElementsByTagName("img")].filter((image) =>
          range.intersectsNode(image),
        );
        const image = edge === "start" ? inRange[0] : inRange[inRange.length - 1];
        const path = image && relPath(section.href, image.getAttribute("src") ?? "");
        if (!path) return null;
        const loaded = await loadImage(path);
        signal.throwIfAborted();
        if (!loaded) throw unavailable("the neighbouring image could not be read");
        try {
          return await contextJpeg(loaded.data, loaded.mime);
        } catch {
          throw unavailable("the neighbouring image could not be decoded");
        }
      });
    },
    keep(sectionIndex) {
      const previous = pinned;
      pinned = sectionIndex;
      if (previous !== null && previous !== sectionIndex) release(previous);
    },
    release,
    dispose() {
      cached = null;
      users.clear();
      pinned = null;
    },
  };
}
