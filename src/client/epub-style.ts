import type { ColorTheme } from "../shared/contracts";
import type { EpubReaderStyle } from "../shared/epub";
import { PAGE_COLORS } from "./reading-theme";

const TEXT_ELEMENTS =
  "p, div, span, li, ul, ol, dl, dt, dd, blockquote, section, article, aside, header, footer, figure, figcaption, " +
  "table, tr, td, th, h1, h2, h3, h4, h5, h6, em, strong, i, b, u, small, cite, label";

/** Marks a stylesheet as ours; `addStylesheetCss` ignores an empty one, which would leave the old rules in place. */
const SHEET_MARK = "/* lumo reading style */";

/** The key `Contents.addStylesheetCss` files the sheet under; epub.js turns it into this element id. */
export const STYLE_KEY = "lumo-reading";
const STYLE_ID = `epubjs-inserted-css-${STYLE_KEY}`;

/**
 * The stylesheet injected into every section. A reflowable book gets the font
 * settings; every book gets the app's colour theme. `light` leaves the book's own
 * colours alone. Replaced as a whole on every change, so rules never stack.
 */
export function readingCss(
  style: EpubReaderStyle,
  fixedLayout: boolean,
  theme: ColorTheme,
): string {
  const rules = [SHEET_MARK];
  if (!fixedLayout) {
    const family = style.fontFamily;
    rules.push(
      `html, body { font-size: ${style.fontSize}px !important; }`,
      `body { font-family: ${family} !important; line-height: ${style.lineHeight} !important; }`,
      `body :where(${TEXT_ELEMENTS}, a) { font-family: inherit !important; }`,
      `body :where(p, div, li, dt, dd, blockquote, td, th) { line-height: ${style.lineHeight} !important; }`,
    );
  }
  if (theme !== "light") {
    const colors = PAGE_COLORS[theme];
    rules.push(
      `html, body { background: ${colors.page} !important; color: ${colors.text} !important; }`,
      `body :where(${TEXT_ELEMENTS}, pre, code) { color: ${colors.text} !important; background-color: transparent !important; }`,
      `body a { color: ${colors.link} !important; }`,
    );
  }
  return rules.join("\n");
}

/**
 * The serialized section with the stylesheet already in it, so the first
 * layout is the final one. A section serialized with no head gets one from the
 * parser when the sheet follows `<html>`.
 */
export function injectStyle(html: string, css: string): string {
  const sheet = `<style id="${STYLE_ID}">${css}</style>`;
  const head = html.search(/<\/head\s*>/i);
  if (head >= 0) return html.slice(0, head) + sheet + html.slice(head);
  return html.replace(/<html\b[^>]*>/i, (open) => open + sheet);
}
