import { useMemo, type CSSProperties, type ReactNode } from "react";
import type { ThemedToken } from "shiki/core";
import { useI18n } from "../i18n";
import { highlightTypst } from "../typst-highlight";

// shiki's FontStyle bits.
const ITALIC = 1;
const BOLD = 2;
const UNDERLINE = 4;

function tokenStyle(token: ThemedToken): CSSProperties {
  const style = token.fontStyle ?? 0;
  return {
    color: token.color,
    ...(style & ITALIC ? { fontStyle: "italic" } : {}),
    ...(style & BOLD ? { fontWeight: 600 } : {}),
    ...(style & UNDERLINE ? { textDecoration: "underline" } : {}),
  };
}

/** The source as text nodes and coloured spans; whatever lies between tokens (line breaks) comes from the source itself. */
function highlighted(source: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const line of highlightTypst(source)) {
    for (const token of line) {
      if (token.content === "") continue;
      if (token.offset < cursor || !source.startsWith(token.content, token.offset)) {
        throw new Error("the highlighter altered the source text");
      }
      if (token.offset > cursor) nodes.push(source.slice(cursor, token.offset));
      nodes.push(
        <span key={token.offset} style={tokenStyle(token)}>
          {token.content}
        </span>,
      );
      cursor = token.offset + token.content.length;
    }
  }
  if (cursor < source.length) nodes.push(source.slice(cursor));
  return nodes;
}

interface TypstSourceProps {
  source: string;
  label?: string;
  className?: string;
  tabIndex?: number;
}

/** Read-only Typst source. It is always shown in full: a highlighting failure falls back to plain text. */
export function TypstSource({ source, label, className, tabIndex }: TypstSourceProps) {
  const { t } = useI18n();
  const nodes = useMemo(() => {
    try {
      return highlighted(source);
    } catch (error) {
      console.error("Typst highlighting failed", error);
      return null;
    }
  }, [source]);
  return (
    <>
      <pre
        className={className ? `typst-source ${className}` : "typst-source"}
        aria-label={label}
        tabIndex={tabIndex}
      >
        <code>{nodes ?? source}</code>
      </pre>
      {nodes === null && (
        <p className="muted" role="status">
          {t.translation.highlightUnavailable}
        </p>
      )}
    </>
  );
}
