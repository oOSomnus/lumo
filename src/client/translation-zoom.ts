import {
  TRANSLATION_ZOOM_PRESETS,
  TRANSLATION_ZOOM_SCALES,
  type TranslationZoom,
} from "../shared/contracts";

// The translation pane's zoom follows the PDF.js viewer's presets, so both panes size a page alike.

/** Typst lays out in points; at actual size one point is 96/72 CSS pixels, as in PDF.js. */
export const CSS_PX_PER_PT = 96 / 72;
/** PDF.js never lets automatic zoom go past this scale. */
export const MAX_AUTO_SCALE = 1.25;

export interface Size {
  width: number;
  height: number;
}

/** The preview's CSS width for `page` (Typst points) in a `viewport` (CSS pixels). */
export function translationPreviewWidth(
  zoom: TranslationZoom,
  page: Size,
  viewport: Size,
): number {
  const actualWidth = page.width * CSS_PX_PER_PT;
  const actualHeight = page.height * CSS_PX_PER_PT;
  const widthScale = viewport.width / actualWidth;
  const heightScale = viewport.height / actualHeight;
  let scale: number;
  switch (zoom) {
    case "page-actual":
      scale = 1;
      break;
    case "page-width":
      scale = widthScale;
      break;
    case "page-fit":
      scale = Math.min(widthScale, heightScale);
      break;
    case "auto":
      scale = Math.min(
        MAX_AUTO_SCALE,
        page.width <= page.height ? widthScale : Math.min(widthScale, heightScale),
      );
      break;
    default:
      scale = zoom;
  }
  return Math.max(1, Math.floor(actualWidth * scale));
}

/** The menu's entries in order; a `<select>` value is the zoom as a string. */
export const TRANSLATION_ZOOMS: readonly TranslationZoom[] = [
  ...TRANSLATION_ZOOM_PRESETS,
  ...TRANSLATION_ZOOM_SCALES,
];

export function translationZoomFromValue(value: string): TranslationZoom | null {
  return TRANSLATION_ZOOMS.find((zoom) => String(zoom) === value) ?? null;
}
