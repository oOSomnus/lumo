import { describe, expect, test } from "bun:test";
import { COLOR_THEMES } from "../shared/contracts";
import { colorSchemeOf, PDF_THEME_CSS, previewThemeCss } from "./reading-theme";
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
    expect(previewThemeCss("light")).toBe("html{background:#fff}");
    expect(previewThemeCss("sepia")).toContain("mix-blend-mode:multiply");
    expect(previewThemeCss("dark")).toContain("invert(");
    expect(previewThemeCss("night")).toContain("invert(");
    expect(new Set(COLOR_THEMES.map(previewThemeCss)).size).toBe(COLOR_THEMES.length);
  });

  test("PDF pages are repainted for every theme but light", () => {
    for (const theme of ["sepia", "dark", "night"]) {
      expect(PDF_THEME_CSS).toContain(`data-lumo-theme="${theme}"`);
    }
    expect(PDF_THEME_CSS).not.toContain('data-lumo-theme="light"');
  });
});
