import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TypstSource } from "./components/TypstSource";
import { highlightTypst } from "./typst-highlight";

const ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
  "&amp;": "&",
};

/** What a browser would copy out of the rendered source: the markup without tags, entities decoded. */
function shownText(source: string): string {
  const html = renderToStaticMarkup(createElement(TypstSource, { source }));
  const code = /<code>([\s\S]*)<\/code>/.exec(html)?.[1] ?? "";
  return code.replace(/<[^>]+>/g, "").replace(/&(?:lt|gt|quot|#x27|amp);/g, (entity) => ENTITIES[entity]!);
}

const SOURCES = {
  empty: "",
  code: '#let answer = 42\n// a comment\n= Heading with $x^2 + y_1$ math\n#text("string")\n',
  crlf: '#let a = 1\r\n// two\r\n#text("x")\r\n',
  loneCarriageReturn: "first\rsecond\n\nthird",
  chinese: "= 标题\n这是一个包含 *强调* 的段落。\n",
  unclosedString: '#let answer = 42\n// stream\n#text("hel',
  unclosedBlockComment: "text /* never closed\nstill inside",
  trailingBlankLines: "= Title\n\n\n",
  tabs: "#let f(x) = {\n\tx + 1\n}\n",
};

describe("Typst source rendering", () => {
  for (const [name, source] of Object.entries(SOURCES)) {
    test(`keeps the text of ${name} exactly`, () => {
      expect(shownText(source)).toBe(source);
    });
  }

  test("shows markup-looking text as text, never as elements", () => {
    const source = '#text("<script>alert(1)</script><img src=x onerror=alert(2)>")';
    const html = renderToStaticMarkup(createElement(TypstSource, { source }));
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(shownText(source)).toBe(source);
  });

  test("renders a leading blank line inside the code element", () => {
    const source = "\n\n#let a = 1";
    expect(shownText(source)).toBe(source);
  });
});

describe("highlightTypst", () => {
  const flat = (source: string) => highlightTypst(source).flat();

  test("colours keywords, strings and comments differently", () => {
    const tokens = flat('#let answer = 42 // note\n#text("quoted")');
    const colourOf = (needle: string) => tokens.find((token) => token.content.includes(needle))?.color;
    const keyword = colourOf("#let");
    const comment = colourOf("// note");
    const string = colourOf('"quoted');
    expect(new Set([keyword, comment, string]).size).toBe(3);
  });

  test("colours a string that is still being written", () => {
    const tokens = flat('#text("hel');
    const unfinished = tokens.find((token) => token.content.startsWith('"hel'));
    const code = tokens.find((token) => token.content === "(");
    expect(unfinished?.color).toBeDefined();
    expect(unfinished?.color).not.toBe(code?.color);
  });

  test("colours the inside of a block comment that is not closed", () => {
    const lines = highlightTypst("/* open\nstill comment");
    expect(lines[1]?.[0]?.color).toBe(lines[0]?.[0]?.color);
  });

  test("tokens carry their offsets into the source", () => {
    const source = "#let a = 1\r\n#let b = 2";
    for (const token of flat(source)) {
      expect(source.startsWith(token.content, token.offset)).toBe(true);
    }
  });
});
