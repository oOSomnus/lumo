import type { ColorTheme } from "../shared/contracts";

// How each colour theme paints reading surfaces: the PDF pages, EPUB pages and the
// translation preview. Plain data and strings only; the EPUB iframe bundle imports
// this module, so it takes nothing from contracts.ts at runtime.

/** The page and text colours a reflowable surface is painted with. `light` keeps a book's own colours. */
export const PAGE_COLORS: Record<Exclude<ColorTheme, "light">, { page: string; text: string; link: string }> = {
  sepia: { page: "#f4ecd8", text: "#3b2f1e", link: "#8a4b08" },
  dark: { page: "#1e1e1e", text: "#d8d8d8", link: "#8ab4f8" },
  night: { page: "#13110e", text: "#cdb99a", link: "#d4a05a" },
};

/**
 * Rendered pages (PDF canvases, Typst SVG) cannot be restyled, so dark themes invert
 * their luminance and turn hues back; white paper becomes the theme's page colour.
 * Sepia instead multiplies the page onto its paper colour, which keeps black text black.
 */
const PAGE_FILTERS: Record<"dark" | "night", string> = {
  dark: "invert(0.88) hue-rotate(180deg)",
  night: "invert(0.92) hue-rotate(180deg) sepia(0.3) brightness(0.85)",
};

/** The `color-scheme` that matches a theme, for form controls, scrollbars and PDF.js's own interface. */
export function colorSchemeOf(theme: ColorTheme): "light" | "dark" {
  return theme === "dark" || theme === "night" ? "dark" : "light";
}

/** The attribute the PDF viewer document carries; `PDF_THEME_CSS` keys its rules on it. */
export const PDF_THEME_ATTRIBUTE = "data-lumo-theme";

/** Rules for the PDF.js viewer document, adopted with its toolbar sheet. */
export const PDF_THEME_CSS = [
  `html[${PDF_THEME_ATTRIBUTE}="sepia"] { --page-bg-color: ${PAGE_COLORS.sepia.page}; --body-bg-color: #e3d7bb; }`,
  `html[${PDF_THEME_ATTRIBUTE}="sepia"] .pdfViewer .page .canvasWrapper canvas { mix-blend-mode: multiply; }`,
  ...(["dark", "night"] as const).map(
    (theme) =>
      `html[${PDF_THEME_ATTRIBUTE}="${theme}"] { --page-bg-color: ${PAGE_COLORS[theme].page}; }\n` +
      `html[${PDF_THEME_ATTRIBUTE}="${theme}"] .pdfViewer .page .canvasWrapper { filter: ${PAGE_FILTERS[theme]}; }`,
  ),
  `html[${PDF_THEME_ATTRIBUTE}="night"] { --body-bg-color: #0b0a09; --toolbar-bg-color: #151310; --sidebar-toolbar-bg-color: #151310; }`,
].join("\n");

/** How a translation preview is painted: its paper, how the glyphs land on it, and a filter over the drawn page. */
export interface PreviewPaint {
  paper: string;
  blend: "source-over" | "multiply";
  filter: string | null;
}

export function previewPaint(theme: ColorTheme): PreviewPaint {
  switch (theme) {
    case "light":
      return { paper: "#fff", blend: "source-over", filter: null };
    case "sepia":
      return { paper: PAGE_COLORS.sepia.page, blend: "multiply", filter: null };
    case "dark":
    case "night":
      return { paper: "#fff", blend: "source-over", filter: PAGE_FILTERS[theme] };
  }
}
