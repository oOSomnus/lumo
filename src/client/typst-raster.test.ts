import { describe, expect, test } from "bun:test";
import { MAX_RASTER_AREA, MAX_RASTER_EDGE, rasterSize } from "./typst-raster";

describe("rasterSize", () => {
  test("a page within the caps gets one backing pixel per device pixel", () => {
    expect(rasterSize({ width: 680, height: 960 }, 1)).toEqual({ width: 680, height: 960 });
    expect(rasterSize({ width: 680.5, height: 960.25 }, 2)).toEqual({ width: 1361, height: 1920 });
  });

  test("a tall page is scaled down uniformly to the edge cap", () => {
    const size = rasterSize({ width: 600, height: 12_000 }, 2);
    expect(size.height).toBe(MAX_RASTER_EDGE);
    expect(size.width).toBe(Math.floor(1200 * (MAX_RASTER_EDGE / 24_000)));
  });

  test("a large page is scaled down uniformly to the area cap", () => {
    const size = rasterSize({ width: 2720, height: 3840 }, 2);
    expect(size.width * size.height).toBeLessThanOrEqual(MAX_RASTER_AREA);
    expect(size.width * size.height).toBeGreaterThan(MAX_RASTER_AREA * 0.99);
    expect(size.width / size.height).toBeCloseTo(2720 / 3840, 2);
  });

  test("an empty box still gets a pixel", () => {
    expect(rasterSize({ width: 0, height: 0 }, 1)).toEqual({ width: 1, height: 1 });
  });
});
