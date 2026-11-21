import type { PreviewPaint } from "./reading-theme";
import type { Size } from "./translation-zoom";

// A translation page is a vector SVG of thousands of glyphs. Painted as a document it is
// re-rasterised wherever a scroll exposes it, which stalls wheel scrolling; drawn once into a
// canvas it scrolls as a plain bitmap.

/** The largest backing store a preview canvas gets, in device pixels: safe in every engine Lumo runs on. */
export const MAX_RASTER_AREA = 16_777_216;
export const MAX_RASTER_EDGE = 16_384;

/** The backing size for a box of `css` pixels at `dpr`, scaled down uniformly to stay within the caps. */
export function rasterSize(css: Size, dpr: number): Size {
  const width = Math.max(1, css.width * dpr);
  const height = Math.max(1, css.height * dpr);
  const scale = Math.min(
    1,
    MAX_RASTER_EDGE / width,
    MAX_RASTER_EDGE / height,
    Math.sqrt(MAX_RASTER_AREA / (width * height)),
  );
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

/**
 * Decodes an SVG as an image. An image never runs the SVG's scripts or loads anything it refers
 * to, so the page needs no frame of its own.
 */
export async function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Draws `image` over the whole canvas at `size`, on the theme's paper. */
export function drawPreview(
  canvas: HTMLCanvasElement,
  image: CanvasImageSource,
  paint: PreviewPaint,
  size: Size,
): void {
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.fillStyle = paint.paper;
  context.fillRect(0, 0, size.width, size.height);
  context.globalCompositeOperation = paint.blend;
  context.drawImage(image, 0, 0, size.width, size.height);
}
