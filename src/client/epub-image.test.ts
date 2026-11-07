import { describe, expect, test } from "bun:test";
import { MAX_EPUB_IMAGE_PIXELS } from "../shared/limits";
import { canDecodeImage, epubImageDimensions } from "./epub-image";

// Files written by ImageMagick/libwebp: PNG 3x2, GIF 5x4, baseline JPEG 7x6, WebP 6x4 as VP8, VP8L and VP8X.
const real = {
  png: "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACAQMAAACnuvRZAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gsHFhAhjwxGIQAAAAxJREFUCNdjYGBgAAAABAABJzQnCgAAAABJRU5ErkJggg==",
  gif: "R0lGODlhBQAEAPAAAAAA/wAAACH5BAAAAAAAIf8LSW1hZ2VNYWdpY2sOZ2FtbWE9MC40NTQ1NDUALAAAAAAFAAQAAAIEhI+ZBQA7",
  jpeg: "/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAGAAcDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJwAHgL/2Q==",
  vp8: "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoGAAQAAgA0JaACdLoB+AADsAD+8MQL/yC5YXXI1/8gP+QH/ID/+PIAAAA=",
  vp8l: "UklGRhwAAABXRUJQVlA4TA8AAAAvBcAAAAcQ/Y/+ByKi/wEA",
  vp8x: "UklGRkgAAABXRUJQVlA4WAoAAAAQAAAABQAAAwAAQUxQSAkAAAABBxAREYiI/gcAVlA4IBgAAAAwAQCdASoGAAQAAgA0JaQAA3AA/vv9UAA=",
};
const file = (name: keyof typeof real): Uint8Array => Buffer.from(real[name], "base64");

const text = (value: string): number[] => [...value].map((char) => char.charCodeAt(0));
const be16 = (n: number): number[] => [(n >> 8) & 255, n & 255];
const be32 = (n: number): number[] => [...be16(n >>> 16), ...be16(n & 0xffff)];
const le16 = (n: number): number[] => [n & 255, (n >> 8) & 255];
const le24 = (n: number): number[] => [...le16(n & 0xffff), (n >> 16) & 255];
const le32 = (n: number): number[] => [...le16(n & 0xffff), ...le16(n >>> 16)];

const png = (width: number, height: number): Uint8Array =>
  Uint8Array.from([0x89, ...text("PNG\r\n\x1a\n"), ...be32(13), ...text("IHDR"), ...be32(width), ...be32(height), 8, 6, 0, 0, 0]);
const gif = (width: number, height: number): Uint8Array =>
  Uint8Array.from([...text("GIF89a"), ...le16(width), ...le16(height), 0, 0, 0]);
const segment = (marker: number, body: number[]): number[] => [0xff, marker, ...be16(body.length + 2), ...body];
const frame = (marker: number, width: number, height: number): number[] =>
  segment(marker, [8, ...be16(height), ...be16(width), 1, 1, 0x11, 0]);
const jpeg = (...parts: number[][]): Uint8Array => Uint8Array.from([0xff, 0xd8, ...parts.flat()]);
const riff = (fourcc: string, payload: number[]): Uint8Array =>
  Uint8Array.from([...text("RIFF"), ...le32(12 + payload.length), ...text("WEBP"), ...text(fourcc), ...le32(payload.length), ...payload]);
const vp8x = (width: number, height: number): Uint8Array => riff("VP8X", [0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)]);
const vp8l = (width: number, height: number): Uint8Array => riff("VP8L", [0x2f, ...le32(width - 1 + ((height - 1) << 14))]);
const vp8 = (width: number, height: number): Uint8Array =>
  riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height)]);

describe("epubImageDimensions", () => {
  test("reads real PNG, GIF, JPEG and WebP files", () => {
    expect(epubImageDimensions(file("png"), "image/png")).toEqual({ width: 3, height: 2 });
    expect(epubImageDimensions(file("gif"), "image/gif")).toEqual({ width: 5, height: 4 });
    expect(epubImageDimensions(file("jpeg"), "image/jpeg")).toEqual({ width: 7, height: 6 });
    for (const name of ["vp8", "vp8l", "vp8x"] as const) {
      expect(epubImageDimensions(file(name), "image/webp"), name).toEqual({ width: 6, height: 4 });
    }
  });

  test("keeps the full width of a PNG that declares 2^31 and 2^32 - 1", () => {
    expect(epubImageDimensions(png(2 ** 31, 3), "image/png")).toEqual({ width: 2 ** 31, height: 3 });
    expect(epubImageDimensions(png(2 ** 32 - 1, 2 ** 32 - 1), "image/png")).toEqual({
      width: 2 ** 32 - 1,
      height: 2 ** 32 - 1,
    });
  });

  test("reads the biggest sizes a GIF and a WebP can declare", () => {
    expect(epubImageDimensions(gif(65_535, 65_535), "image/gif")).toEqual({ width: 65_535, height: 65_535 });
    expect(epubImageDimensions(vp8x(2 ** 24, 2 ** 24), "image/webp")).toEqual({ width: 2 ** 24, height: 2 ** 24 });
    expect(epubImageDimensions(vp8l(16_384, 16_384), "image/webp")).toEqual({ width: 16_384, height: 16_384 });
    expect(epubImageDimensions(vp8(16_383, 16_383), "image/webp")).toEqual({ width: 16_383, height: 16_383 });
  });

  test("a JPEG's size comes from its frame header, past other segments and markers inside them", () => {
    // A thumbnail's frame header inside an APP1 segment must not be mistaken for the picture's.
    const thumbnail = frame(0xc0, 1, 1);
    const head = [
      segment(0xe0, text("JFIF\0").concat([1, 1, 0, 0, 1, 0, 1, 0, 0])),
      segment(0xe1, thumbnail),
      segment(0xc4, new Array(17).fill(0)),
      segment(0xdb, new Array(65).fill(1)),
    ];
    for (const marker of [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc9, 0xcf]) {
      expect(epubImageDimensions(jpeg(...head, frame(marker, 4000, 5000)), "image/jpeg"), marker.toString(16)).toEqual({
        width: 4000,
        height: 5000,
      });
    }
    // Fill bytes may precede any marker.
    expect(epubImageDimensions(jpeg(...head, [0xff, 0xff, 0xff], frame(0xc2, 70, 80)), "image/jpeg")).toEqual({
      width: 70,
      height: 80,
    });
  });

  test("a JPEG with no frame header before its scan has no size", () => {
    expect(epubImageDimensions(jpeg(segment(0xe0, [0, 0]), segment(0xda, [0, 0, 0])), "image/jpeg")).toBeNull();
    expect(epubImageDimensions(jpeg(segment(0xc4, new Array(17).fill(0)), segment(0xcc, [0, 0])), "image/jpeg")).toBeNull();
    expect(epubImageDimensions(Uint8Array.from([0xff, 0xd8]), "image/jpeg")).toBeNull();
  });

  test("a header cut one byte short of its size has none", () => {
    // [type, file, bytes up to and including the size]: PNG 8 + 16, GIF 6 + 4, JPEG SOI + marker, length, precision, height, width; VP8X and VP8 30, VP8L 25.
    const sizeAt: [string, Uint8Array, number][] = [
      ["image/png", png(10, 10), 24],
      ["image/gif", gif(10, 10), 10],
      ["image/jpeg", jpeg(frame(0xc0, 10, 10)), 11],
      ["image/webp", vp8x(10, 10), 30],
      ["image/webp", vp8l(10, 10), 25],
      ["image/webp", vp8(10, 10), 30],
    ];
    for (const [mime, bytes, needed] of sizeAt) {
      expect(epubImageDimensions(bytes.subarray(0, needed), mime), `${mime} at ${needed}`).toEqual({ width: 10, height: 10 });
      expect(epubImageDimensions(bytes.subarray(0, needed - 1), mime), `${mime} at ${needed - 1}`).toBeNull();
    }
  });

  test("a size of zero, an unknown chunk or the wrong type has none", () => {
    expect(epubImageDimensions(png(0, 5), "image/png")).toBeNull();
    expect(epubImageDimensions(png(5, 0), "image/png")).toBeNull();
    expect(epubImageDimensions(gif(0, 0), "image/gif")).toBeNull();
    expect(epubImageDimensions(jpeg(frame(0xc0, 0, 9)), "image/jpeg")).toBeNull();
    expect(epubImageDimensions(riff("ANIM", new Array(20).fill(0)), "image/webp")).toBeNull();
    expect(epubImageDimensions(riff("VP8L", [0x2e, 0, 0, 0, 0, 0]), "image/webp")).toBeNull();
    expect(epubImageDimensions(riff("VP8 ", new Array(14).fill(0)), "image/webp")).toBeNull();
    expect(epubImageDimensions(file("png"), "image/jpeg")).toBeNull();
    expect(epubImageDimensions(file("png"), "image/svg+xml")).toBeNull();
    expect(epubImageDimensions(Uint8Array.from(text('<svg width="9" height="9"/>')), "image/svg+xml")).toBeNull();
  });
});

describe("canDecodeImage", () => {
  test("accepts exactly the pixel limit and refuses one pixel more", () => {
    expect(canDecodeImage(png(MAX_EPUB_IMAGE_PIXELS, 1), "image/png")).toBe(true);
    expect(canDecodeImage(png(MAX_EPUB_IMAGE_PIXELS + 1, 1), "image/png")).toBe(false);
    expect(canDecodeImage(gif(8000, 5000), "image/gif")).toBe(true);
    expect(canDecodeImage(gif(8001, 5000), "image/gif")).toBe(false);
  });

  test("refuses sizes whose product no 32-bit arithmetic holds, and files whose size cannot be read", () => {
    expect(canDecodeImage(png(2 ** 32 - 1, 2 ** 32 - 1), "image/png")).toBe(false);
    expect(canDecodeImage(vp8x(2 ** 24, 2 ** 24), "image/webp")).toBe(false);
    expect(canDecodeImage(png(0, 5), "image/png")).toBe(false);
    expect(canDecodeImage(png(10, 10).subarray(0, 23), "image/png")).toBe(false);
    expect(canDecodeImage(Uint8Array.from(text("<svg/>")), "image/svg+xml")).toBe(false);
  });

  test("accepts the real files", () => {
    expect(canDecodeImage(file("png"), "image/png")).toBe(true);
    expect(canDecodeImage(file("jpeg"), "image/jpeg")).toBe(true);
    expect(canDecodeImage(file("vp8l"), "image/webp")).toBe(true);
  });
});
