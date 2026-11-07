const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Drops placeholder bytes models copy from text layers. Typst has no syntax
 * for these controls, so a single one fails the whole document.
 */
export function stripPlaceholderControls(source: string): string {
  return source.replace(CONTROL_CHARS, "");
}

// Typst's own line breaks, so a reported line is the line the compiler counted.
const LINE_BREAK = /\r\n|[\n\v\f\r\u0085\u2028\u2029]/;
const RANGE = /^(\d+):(\d+)-(\d+):(\d+)$/;
const EXCERPT_RADIUS = 100;

/** Splits source into the lines Typst counts, so shown lines match compiler line numbers. */
export function splitTypstLines(source: string): string[] {
  return source.split(LINE_BREAK);
}

/**
 * Formats typst.ts diagnostics for the reader and the repair prompt. typst.ts
 * numbers lines and columns from 0 and counts columns in characters; this
 * reports 1-based positions and quotes the source line with the reported range
 * between ⟦ and ⟧.
 */
export function describeTypstDiagnostics(
  source: string,
  diagnostics: unknown,
): string {
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) {
    return "Typst compilation failed without diagnostics";
  }
  const lines = splitTypstLines(source);
  return diagnostics.map((entry) => describeDiagnostic(entry, lines)).join("\n");
}

function describeDiagnostic(entry: unknown, lines: string[]): string {
  if (!entry || typeof entry !== "object") return String(entry);
  const { severity, range, message } = entry as Record<string, unknown>;
  const head = `${typeof severity === "string" ? severity : "error"}: ${String(message ?? "")}`;
  const match = typeof range === "string" ? RANGE.exec(range) : null;
  const text = match ? lines[Number(match[1])] : undefined;
  if (!match || text === undefined) return head;

  const [line, column, endLine, endColumn] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  const chars = Array.from(text);
  const from = Math.min(column, chars.length);
  const to = Math.min(endLine === line ? endColumn : chars.length, from + EXCERPT_RADIUS);
  const start = Math.max(0, from - EXCERPT_RADIUS);
  const end = Math.min(chars.length, to + EXCERPT_RADIUS);
  const excerpt = [
    start > 0 ? "…" : "",
    chars.slice(start, from).join(""),
    "⟦",
    chars.slice(from, to).join(""),
    "⟧",
    chars.slice(to, end).join(""),
    end < chars.length ? "…" : "",
  ].join("");
  return `${head} (line ${line + 1}, column ${column + 1})\n${line + 1} | ${excerpt}`;
}
