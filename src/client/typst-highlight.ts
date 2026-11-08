import {
  createHighlighterCoreSync,
  type HighlighterCore,
  type ThemedToken,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import typst from "shiki/langs/typst.mjs";
import githubLight from "shiki/themes/github-light.mjs";

// One highlighter for the page: creating it compiles the Typst grammar, so it happens on first use.
// A failed creation is remembered instead of being retried on every streamed update.
let highlighter: HighlighterCore | Error | undefined;

function instance(): HighlighterCore {
  if (highlighter === undefined) {
    try {
      highlighter = createHighlighterCoreSync({
        langs: [typst],
        themes: [githubLight],
        engine: createJavaScriptRegexEngine(),
      });
    } catch (error) {
      highlighter = error instanceof Error ? error : new Error(String(error));
    }
  }
  if (highlighter instanceof Error) throw highlighter;
  return highlighter;
}

/** Colour tokens of `source`, line by line; the tokens carry their offsets into `source`. */
export function highlightTypst(source: string): ThemedToken[][] {
  return instance().codeToTokens(source, { lang: "typst", theme: "github-light" }).tokens;
}
