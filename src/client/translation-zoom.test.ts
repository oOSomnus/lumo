import { describe, expect, test } from "bun:test";
import { translationZoomSchema } from "../shared/contracts";
import {
  CSS_PX_PER_PT,
  TRANSLATION_ZOOMS,
  translationPreviewWidth,
  translationZoomFromValue,
} from "./translation-zoom";

// 510pt (180mm) wide: 680px at actual size.
const portrait = { width: 510, height: 720 };
const landscape = { width: 720, height: 510 };
const actual = 510 * CSS_PX_PER_PT;

describe("translationPreviewWidth", () => {
  test("actual size and percentages scale the page's own width", () => {
    const viewport = { width: 2000, height: 900 };
    expect(translationPreviewWidth("page-actual", portrait, viewport)).toBe(680);
    expect(translationPreviewWidth(1, portrait, viewport)).toBe(680);
    expect(translationPreviewWidth(0.5, portrait, viewport)).toBe(340);
    expect(translationPreviewWidth(2, portrait, viewport)).toBe(1360);
    expect(translationPreviewWidth(4, portrait, { width: 300, height: 300 })).toBe(2720);
  });

  test("page width fills the viewport width", () => {
    expect(translationPreviewWidth("page-width", portrait, { width: 1999.6, height: 100 })).toBe(
      1999,
    );
  });

  test("page fit keeps the whole page inside the viewport", () => {
    const viewport = { width: 2000, height: 960 };
    expect(translationPreviewWidth("page-fit", portrait, viewport)).toBe(680);
    expect(translationPreviewWidth("page-fit", portrait, { width: 400, height: 4000 })).toBe(400);
  });

  test("automatic zoom fits a portrait page's width, capped at 125%", () => {
    expect(translationPreviewWidth("auto", portrait, { width: 3000, height: 200 })).toBe(
      Math.floor(actual * 1.25),
    );
    expect(translationPreviewWidth("auto", portrait, { width: 600, height: 200 })).toBe(600);
  });

  test("automatic zoom fits a landscape page whole", () => {
    // 680px tall at actual size, so half size: 960px wide becomes 480px.
    expect(translationPreviewWidth("auto", landscape, { width: 3000, height: 340 })).toBe(480);
  });
});

describe("translation zoom values", () => {
  test("every menu entry is a valid stored zoom and round-trips through its string", () => {
    for (const zoom of TRANSLATION_ZOOMS) {
      expect(translationZoomSchema.safeParse(zoom).success).toBe(true);
      expect(translationZoomFromValue(String(zoom))).toBe(zoom);
    }
    expect(translationZoomFromValue("0.33")).toBeNull();
    expect(translationZoomFromValue("page-height")).toBeNull();
  });

  test("the schema rejects unlisted zooms", () => {
    for (const zoom of [0.33, 5, "huge", "page-height", "1"]) {
      expect(translationZoomSchema.safeParse(zoom).success).toBe(false);
    }
  });
});
