export type PageSelectionErrorCode =
  | "SELECTION_EMPTY"
  | "SELECTION_EMPTY_TOKEN"
  | "SELECTION_INVALID_TOKEN"
  | "SELECTION_TOKEN_TOO_LARGE"
  | "SELECTION_OUT_OF_BOUNDS"
  | "SELECTION_REVERSED_RANGE";

export class PageSelectionError extends Error {
  constructor(
    readonly code: PageSelectionErrorCode,
    message: string,
    readonly params?: Record<string, string | number>,
  ) {
    super(message);
    this.name = "PageSelectionError";
  }
}

const TOKEN_PATTERN = /^(\d+)(?:\s*-\s*(\d+))?$/;

/**
 * Parses expressions such as "1,3-5,12". Digits are 1-based actual page
 * numbers. Any invalid token rejects the whole expression.
 */
export function parsePageSelection(value: string, pageCount: number): number[] {
  const normalized = value.replace(/，/g, ",").trim();
  if (normalized === "") {
    throw new PageSelectionError(
      "SELECTION_EMPTY",
      "enter page numbers, for example 1,3-5,12",
    );
  }

  const pages = new Set<number>();
  for (const rawToken of normalized.split(",")) {
    const token = rawToken.trim();
    if (token === "") {
      throw new PageSelectionError(
        "SELECTION_EMPTY_TOKEN",
        "page numbers must not contain empty items",
      );
    }
    const match = TOKEN_PATTERN.exec(token);
    if (!match) {
      throw new PageSelectionError(
        "SELECTION_INVALID_TOKEN",
        `unrecognized page expression: ${token}`,
        { token },
      );
    }
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      throw new PageSelectionError(
        "SELECTION_TOKEN_TOO_LARGE",
        `page number is out of range: ${token}`,
        { token },
      );
    }
    if (start < 1 || end < 1 || start > pageCount || end > pageCount) {
      throw new PageSelectionError(
        "SELECTION_OUT_OF_BOUNDS",
        `pages must be between 1 and ${pageCount}: ${token}`,
        { pageCount, token },
      );
    }
    if (start > end) {
      throw new PageSelectionError(
        "SELECTION_REVERSED_RANGE",
        `range starts after it ends: ${token}`,
        { token },
      );
    }
    for (let page = start; page <= end; page++) pages.add(page);
  }

  return [...pages].sort((a, b) => a - b);
}
