import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TranslationView } from "./TranslationView";

function render(markdown: string, streaming = false): string {
  return renderToStaticMarkup(
    React.createElement(TranslationView, { markdown, streaming }),
  );
}

function tags(html: string, name: "strong" | "em"): string[] {
  return [...html.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))].map(
    (match) => match[1]!,
  );
}

describe("TranslationView", () => {
  test("parses emphasis next to CJK punctuation without swallowing surrounding text", () => {
    const html = render("这是**（重点）**内容和*（强调）*文本。");
    expect(tags(html, "strong")).toEqual(["（重点）"]);
    expect(tags(html, "em")).toEqual(["（强调）"]);
    expect(html).not.toContain("**");
    expect(html).toContain("</strong>内容和<em>");
  });

  test("keeps conventional English emphasis", () => {
    const html = render("**bold** and *italic*");
    expect(tags(html, "strong")).toEqual(["bold"]);
    expect(tags(html, "em")).toEqual(["italic"]);
  });

  test("treats ordinary currency as text rather than math", () => {
    for (const [markdown, expected] of [
      ["价格 $5，原价 $10。", ["$5", "$10"]],
      ["US$19.99 / $20–$30", ["US$19.99", "$20–$30"]],
    ] as const) {
      const html = render(markdown);
      expect(html).not.toContain("katex");
      for (const amount of expected) expect(html).toContain(amount);
    }
  });

  test("renders double-dollar inline and display math", () => {
    const inline = render("行内 $$x^2$$");
    expect(inline).toContain('class="katex"');
    expect(inline).not.toContain("katex-display");
    expect(inline).toContain("x^2");

    const display = render("$$\n\\frac{1}{2}\n$$");
    expect(display).toContain("katex-display");
    expect(display).toContain("\\frac{1}{2}");
  });

  test("keeps emphasis and dollar markers literal inside code", () => {
    const span = render("`**（字面）** $5 $$x$$`");
    expect(span).toContain("<code>**（字面）** $5 $$x$$</code>");
    expect(span).not.toContain("<strong>");
    expect(span).not.toContain("<em>");
    expect(span).not.toContain("katex");

    const fence = render("```\n**（字面）** $5 $$x$$\n```");
    expect(fence).toContain("**（字面）** $5 $$x$$");
    expect(fence).not.toContain("<strong>");
    expect(fence).not.toContain("katex");
  });

  test("keeps the full prefix while streaming an unfinished marker", () => {
    const partial = render("这是**（重", true);
    expect(partial).toContain("这是**（重");

    const complete = render("这是**（重点）**内容。");
    const streamed = render("这是**（重点）**内容。", true);
    expect(streamed.slice(streamed.indexOf(">") + 1, streamed.lastIndexOf("</div>"))).toBe(
      complete.slice(complete.indexOf(">") + 1, complete.lastIndexOf("</div>")),
    );
    expect(tags(streamed, "strong")).toEqual(["（重点）"]);
  });
});
