// Size limits the EPUB viewer iframe needs too, so they live apart from the zod schemas of contracts.ts.

/** The text of one page, or the XHTML of one EPUB range, in a translate request. */
export const MAX_PAGE_TEXT_CHARS = 100_000;

// Neighbouring-page references sent next to the current page; they are never saved.
export const MAX_TRANSLATION_CONTEXT_CHARS = 2000;
export const MAX_CONTEXT_IMAGE_BASE64_CHARS = 250_000;

/** The most pixels (width × height) the EPUB viewer decodes from one image for a preview, a neighbour reference or a WebP conversion. */
export const MAX_EPUB_IMAGE_PIXELS = 40_000_000;
