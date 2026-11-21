import { describe, expect, test } from "bun:test";
import { COLOR_THEMES } from "../shared/contracts";
import { colorSchemeOf, PDF_THEME_CSS, previewPaint } from "./reading-theme";
import { resolveTheme } from "./theme";

describe("resolveTheme", () => {
  test("system follows the operating system; every other choice is itself", () => {
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
    for (const theme of COLOR_THEMES) {
      expect(resolveTheme(theme, true)).toBe(theme);
      expect(resolveTheme(theme, false)).toBe(theme);
    }
  });
});

describe("reading surfaces", () => {
  test("dark themes use the dark color-scheme, light and sepia the light one", () => {
    expect(COLOR_THEMES.map(colorSchemeOf)).toEqual(["light", "dark", "light", "dark"]);
  });

  test("the light preview keeps the page as rendered; the others repaint it", () => {
    expect(previewPaint("light")).toEqual({ paper: "#fff", blend: "source-over", filter: null });
    expect(previewPaint("sepia")).toMatchObject({ blend: "multiply", filter: null });
    expect(previewPaint("sepia").paper).not.toBe("#fff");
    expect(previewPaint("dark").filter).toContain("invert(");
    expect(previewPaint("night").filter).toContain("invert(");
    expect(new Set(COLOR_THEMES.map((theme) => JSON.stringify(previewPaint(theme)))).size).toBe(
      COLOR_THEMES.length,
    );
  });

  test("PDF pages are repainted for every theme but light", () => {
    for (const theme of ["sepia", "dark", "night"]) {
      expect(PDF_THEME_CSS).toContain(`data-lumo-theme="${theme}"`);
    }
    expect(PDF_THEME_CSS).not.toContain('data-lumo-theme="light"');
  });
});
