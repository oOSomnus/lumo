import { memo } from "react";
import Markdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { useI18n } from "../i18n";

const katexOptions = {
  trust: false,
  maxExpand: 1000,
  maxSize: 20,
  throwOnError: false,
} as const;

interface TranslationViewProps {
  markdown: string;
  streaming?: boolean;
}

export const TranslationView = memo(function TranslationView({
  markdown,
  streaming = false,
}: TranslationViewProps) {
  const { t } = useI18n();
  return (
    <div className={streaming ? "translation-body streaming" : "translation-body"}>
      <Markdown
        remarkPlugins={[
          remarkGfm,
          remarkCjkFriendly,
          [remarkMath, { singleDollarTextMath: false }],
        ]}
        rehypePlugins={[[rehypeKatex, katexOptions]]}
        skipHtml
        components={{
          img: ({ alt }) => (
            <span className="md-image-placeholder">
              {t.translation.imagePlaceholder(alt ?? "")}
            </span>
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="md-table-scroll">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {markdown}
      </Markdown>
    </div>
  );
});
