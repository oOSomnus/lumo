import { describe, expect, test } from "bun:test";
import { flattenEpubToc, resolveTocHref } from "./epub-toc";

describe("resolveTocHref", () => {
  test("resolves against the directory of the nav document and keeps the fragment", () => {
    expect(resolveTocHref("nav.xhtml", "ch1.xhtml#part-a")).toBe("ch1.xhtml#part-a");
    expect(resolveTocHref("OEBPS/nav/nav.xhtml", "../text/ch1.xhtml#a")).toBe("OEBPS/text/ch1.xhtml#a");
    expect(resolveTocHref("toc.ncx", "#top")).toBe("toc.ncx#top");
  });

  test("decodes names the way the manifest spells them", () => {
    expect(resolveTocHref("nav.xhtml", "chapter%20one.xhtml#caf%C3%A9")).toBe("chapter one.xhtml#café");
  });

  test("an external or empty link is not a target", () => {
    expect(resolveTocHref("nav.xhtml", "https://example.com/a")).toBeNull();
    expect(resolveTocHref("nav.xhtml", "mailto:a@b.c")).toBeNull();
    expect(resolveTocHref("nav.xhtml", "")).toBeNull();
  });
});

describe("flattenEpubToc", () => {
  const sections = new Map([["ch1.xhtml", 0], ["ch2.xhtml", 1]]);
  const indexOf = (href: string): number | null => sections.get(href.split("#")[0]!) ?? null;

  test("lists nested items in reading order with levels and section indexes", () => {
    const toc = flattenEpubToc(
      [
        {
          label: "Chapter One",
          href: "ch1.xhtml",
          subitems: [{ label: "Part A", href: "ch1.xhtml#part-a" }, { label: "Part B", href: "ch1.xhtml#part-b" }],
        },
        { label: "Chapter Two", href: "ch2.xhtml" },
      ],
      "nav.xhtml",
      indexOf,
    );
    expect(toc.map((entry) => [entry.label, entry.level, entry.index, entry.href])).toEqual([
      ["Chapter One", 1, 0, "ch1.xhtml"],
      ["Part A", 2, 0, "ch1.xhtml#part-a"],
      ["Part B", 2, 0, "ch1.xhtml#part-b"],
      ["Chapter Two", 1, 1, "ch2.xhtml"],
    ]);
    expect(new Set(toc.map((entry) => entry.id)).size).toBe(4);
  });

  test("an untitled item gives its children its level, and an unresolvable link becomes a group", () => {
    const toc = flattenEpubToc(
      [
        { label: "  ", subitems: [{ label: "Kept", href: "ch1.xhtml" }] },
        { label: "Appendix", href: "missing.xhtml", subitems: [{ label: "Notes", href: "ch2.xhtml" }] },
        { label: "Web", href: "https://example.com" },
      ],
      "nav.xhtml",
      indexOf,
    );
    expect(toc.map((entry) => [entry.label, entry.level, entry.index, entry.href])).toEqual([
      ["Kept", 1, 0, "ch1.xhtml"],
      ["Appendix", 1, null, null],
      ["Notes", 2, 1, "ch2.xhtml"],
      ["Web", 1, null, null],
    ]);
  });
});
