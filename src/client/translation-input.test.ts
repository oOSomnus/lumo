import { describe, expect, test } from "bun:test";
import { translatePageInputSchema } from "../shared/contracts";
import { generationRequest, repairRequest } from "./translation-input";

const unit = `page-${"a".repeat(64)}`;
const sourceCfi = "epubcfi(/6/4!/4/2,/1:0,/3:5)";
const repair = { typst: "= Title", diagnostics: "error: unexpected token" };

const pdfTask = {
  documentId: "d".repeat(64),
  pageNumber: 3,
  targetLanguage: "zh-CN" as const,
  force: false,
};
const epubTask = { ...pdfTask, pageNumber: 2, unit, sourceCfi };

describe("generation requests", () => {
  test("a PDF page keeps its neighbouring excerpts and passes the strict schema", () => {
    const request = generationRequest(pdfTask, {
      format: "pdf",
      text: "page text",
      imageBase64: "/9j/4AAQSkZJRg==",
      context: { previous: { text: "tail" }, next: { text: "head" } },
    });
    expect(translatePageInputSchema.parse(request)).toEqual(request);
    expect(request).toMatchObject({ context: { previous: { text: "tail" }, next: { text: "head" } } });
  });

  test("local context warnings never reach the wire", () => {
    const request = generationRequest(epubTask, {
      format: "epub",
      xhtml: "<p>x</p>",
      images: [],
      context: { next: { text: "head" } },
      contextWarnings: ["previous"],
    });
    expect(request).not.toHaveProperty("contextWarnings");
    expect(translatePageInputSchema.parse(request)).toEqual(request);
  });

  test("an EPUB page without its range fails before any request is built", () => {
    const prepared = { format: "epub" as const, xhtml: "<p>x</p>", images: [] };
    expect(() => generationRequest(pdfTask, prepared)).toThrow(
      expect.objectContaining({ code: "EPUB_PAGE_UNAVAILABLE" }),
    );
    expect(() => generationRequest({ ...epubTask, sourceCfi: undefined }, prepared)).toThrow(
      expect.objectContaining({ code: "EPUB_PAGE_UNAVAILABLE" }),
    );
  });
});

describe("repair requests", () => {
  test("repair carries identity and diagnostics only, for both formats", () => {
    const pdf = repairRequest(pdfTask, repair);
    const epub = repairRequest(epubTask, repair);
    expect(translatePageInputSchema.parse(pdf)).toEqual(pdf);
    expect(translatePageInputSchema.parse(epub)).toEqual(epub);
    expect(pdf).toMatchObject({ format: "pdf", repair });
    expect(epub).toMatchObject({ format: "epub", unit, sourceCfi, repair });
    for (const request of [pdf, epub]) {
      for (const field of ["text", "imageBase64", "xhtml", "images", "context"]) {
        expect(request).not.toHaveProperty(field);
      }
    }
  });
});
