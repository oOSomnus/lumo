import { MAX_EPUB_IMAGE_PIXELS } from "../shared/limits";

// The size an image declares in its first bytes. The browser's decoder allocates width × height × 4 bytes
// before it reads a single row, so a small file can name a picture no machine has memory for.

interface ImageSize {
  width: number;
  height: number;
}

const be16 = (b: Uint8Array, at: number): number => (b[at]! << 8) | b[at + 1]!;
const le16 = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8);
const le24 = (b: Uint8Array, at: number): number => le16(b, at) | (b[at + 2]! << 16);
const be32 = (b: Uint8Array, at: number): number =>
  ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const ascii = (b: Uint8Array, at: number, length: number): string =>
  String.fromCharCode(...b.subarray(at, at + length));

function pngSize(b: Uint8Array): ImageSize | null {
  // 8 signature bytes, then the IHDR chunk: length, "IHDR", width, height.
  if (b.length < 24 || ascii(b, 12, 4) !== "IHDR") return null;
  return { width: be32(b, 16), height: be32(b, 20) };
}

function gifSize(b: Uint8Array): ImageSize | null {
  return b.length < 10 ? null : { width: le16(b, 6), height: le16(b, 8) };
}

/** The first frame header (SOF0–SOF15 except DHT, JPG and DAC) holds the size; segments before it are skipped by their length. */
function jpegSize(b: Uint8Array): ImageSize | null {
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1]!;
    if (marker === 0xff) {
      at += 1; // fill byte
    } else if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2; // standalone marker
    } else if (marker === 0xd9 || marker === 0xda) {
      return null; // the image ends or its data starts before any frame header
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return at + 9 <= b.length ? { height: be16(b, at + 5), width: be16(b, at + 7) } : null;
    } else {
      at += 2 + be16(b, at + 2);
    }
  }
  return null;
}

function webpSize(b: Uint8Array): ImageSize | null {
  switch (b.length >= 16 ? ascii(b, 12, 4) : "") {
    case "VP8X":
      return b.length < 30 ? null : { width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
    case "VP8L": {
      if (b.length < 25 || b[20] !== 0x2f) return null;
      const bits = (le16(b, 21) | (le16(b, 23) << 16)) >>> 0;
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    case "VP8 ":
      if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
      return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
    default:
      return null;
  }
}

/** The declared size of a PNG, GIF, JPEG or WebP; null for any other type, an unreadable header, or a size of zero. */
export function epubImageDimensions(bytes: Uint8Array, mime: string): ImageSize | null {
  const size =
    mime === "image/png"
      ? pngSize(bytes)
      : mime === "image/gif"
        ? gifSize(bytes)
        : mime === "image/jpeg"
          ? jpegSize(bytes)
          : mime === "image/webp"
            ? webpSize(bytes)
            : null;
  return size && size.width > 0 && size.height > 0 ? size : null;
}

/** True only for an image whose header is readable and declares no more pixels than `MAX_EPUB_IMAGE_PIXELS`. */
export function canDecodeImage(bytes: Uint8Array, mime: string): boolean {
  const size = epubImageDimensions(bytes, mime);
  return size !== null && size.width * size.height <= MAX_EPUB_IMAGE_PIXELS;
}
