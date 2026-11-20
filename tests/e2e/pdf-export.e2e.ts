import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  expect,
  openTranslatedPage,
  test,
  translationPath,
  uploadPdf,
} from "./fixtures";

const A4_WIDTH = 595.28;
const ORIGINAL_WIDTH = 400;

function savedPage(title: string): string {
  return `#set page(width: 180mm, height: auto, margin: 12mm)\n= ${title}\nTranslated body of ${title.toLowerCase()}.`;
}

/** Clicks Export PDF and reads the download: each page's width and text. */
async function exportPdf(page: Page): Promise<{ widths: number[]; texts: string[] }> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export PDF", exact: true }).click(),
  ]);
  return readPdf(await download.path(), download.suggestedFilename());
}

async function readPdf(path: string, name: string): Promise<{ widths: number[]; texts: string[] }> {
  expect(name).toMatch(/\.pdf$/);
  const data = new Uint8Array(await readFile(path));
  const task = pdfjs.getDocument({ data });
  const pdf = await task.promise;
  const widths: number[] = [];
  const texts: string[] = [];
  for (let index = 1; index <= pdf.numPages; index += 1) {
    const pdfPage = await pdf.getPage(index);
    widths.push(Math.round(pdfPage.getViewport({ scale: 1 }).width * 100) / 100);
    const content = await pdfPage.getTextContent();
    texts.push(content.items.map((item) => ("str" in item ? item.str : "")).join(""));
  }
  await task.destroy();
  return { widths, texts };
}

test("PDF export typesets translations at the chosen width, alone or after each original page", async ({
  page,
  lumo,
}) => {
  const document = await uploadPdf(lumo.api, "pdf-export.pdf", 3, "export");
  for (const [pageNumber, title] of [
    [1, "Page one"],
    [2, "Page two"],
  ] as const) {
    const response = await lumo.api.put(translationPath(document.id, pageNumber, "en"), {
      data: { typst: savedPage(title), provider: "custom", model: "smoke" },
    });
    expect(response.ok()).toBe(true);
  }

  await openTranslatedPage(page, lumo.url, "pdf-export.pdf");
  await expect(page.locator(".page-status")).toHaveText(/Saved/);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("button", { name: "PDF: choose pages, layout and width…" }).click();
  const dialog = page.getByRole("dialog", { name: "Export translation as PDF" });
  await expect(dialog).toBeVisible();
  // The selection starts as the translated pages.
  await expect(dialog.getByText("2 pages selected · 2 translated")).toBeVisible();

  const translationOnly = await exportPdf(page);
  expect(translationOnly.widths).toEqual([A4_WIDTH, A4_WIDTH]);
  expect(translationOnly.texts[0]).toContain("Page one");
  expect(translationOnly.texts[1]).toContain("Translated body of page two.");
  await expect(dialog.getByText("The PDF was downloaded.")).toBeVisible();

  await dialog.getByRole("radio", { name: "Each original page, then its translation" }).check();
  await dialog.getByRole("combobox", { name: "Translation page width" }).selectOption("letter");
  const interleaved = await exportPdf(page);
  expect(interleaved.widths).toEqual([ORIGINAL_WIDTH, 612, ORIGINAL_WIDTH, 612]);
  expect(interleaved.texts[1]).toContain("Page one");
  expect(interleaved.texts[3]).toContain("Page two");
});

test("PDF export asks before exporting untranslated pages and can leave them out", async ({
  page,
  lumo,
}) => {
  const document = await uploadPdf(lumo.api, "pdf-missing.pdf", 3, "missing");
  const response = await lumo.api.put(translationPath(document.id, 2, "en"), {
    data: { typst: savedPage("Middle"), provider: "custom", model: "smoke" },
  });
  expect(response.ok()).toBe(true);

  await openTranslatedPage(page, lumo.url, "pdf-missing.pdf");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("button", { name: "PDF: choose pages, layout and width…" }).click();
  const dialog = page.getByRole("dialog", { name: "Export translation as PDF" });
  await dialog.getByRole("button", { name: "All pages", exact: true }).click();
  await dialog.getByRole("radio", { name: "Each original page, then its translation" }).check();
  await dialog.getByRole("button", { name: "Export PDF", exact: true }).click();

  await expect(dialog.getByText("2 of 3 selected pages have no saved translation.")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Translate 2 pages first, then export" }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Pages without a translation keep their original page only."),
  ).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByRole("button", { name: "Export without them" }).click(),
  ]);
  const exported = await readPdf(await download.path(), download.suggestedFilename());
  expect(exported.widths).toEqual([ORIGINAL_WIDTH, ORIGINAL_WIDTH, A4_WIDTH, ORIGINAL_WIDTH]);
  expect(exported.texts[2]).toContain("Middle");
  await expect(dialog.getByText("2 selected pages had no translation.")).toBeVisible();
});

test("PDF export waits for the translations it queues and stops when one fails", async ({
  page,
  lumo,
}) => {
  const document = await uploadPdf(lumo.api, "pdf-queue.pdf", 2, "queue");
  const response = await lumo.api.put(translationPath(document.id, 1, "en"), {
    data: { typst: savedPage("First"), provider: "custom", model: "smoke" },
  });
  expect(response.ok()).toBe(true);

  await openTranslatedPage(page, lumo.url, "pdf-queue.pdf");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("button", { name: "PDF: choose pages, layout and width…" }).click();
  const dialog = page.getByRole("dialog", { name: "Export translation as PDF" });
  await dialog.getByRole("button", { name: "All pages", exact: true }).click();
  await dialog.getByRole("button", { name: "Export PDF", exact: true }).click();
  // Nothing listens on the configured endpoint, so the queued page fails.
  await dialog.getByRole("button", { name: "Translate 1 page first, then export" }).click();
  await expect(dialog.getByText("1 page could not be translated.")).toBeVisible({
    timeout: 30_000,
  });

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByRole("button", { name: "Export without them" }).click(),
  ]);
  const exported = await readPdf(await download.path(), download.suggestedFilename());
  expect(exported.widths).toEqual([A4_WIDTH]);
  expect(exported.texts[0]).toContain("First");
});

test("PDF export builds the PDF by itself once the pages it queued are saved", async ({
  page,
  lumo,
}) => {
  const document = await uploadPdf(lumo.api, "pdf-auto.pdf", 2, "auto");
  const response = await lumo.api.put(translationPath(document.id, 1, "en"), {
    data: { typst: savedPage("Kept"), provider: "custom", model: "smoke" },
  });
  expect(response.ok()).toBe(true);
  // Only the model's answer is faked; page preparation, Typst validation and saving stay real.
  const requested: number[] = [];
  await page.route(/\/api\/translate$/, async (route) => {
    const body = route.request().postDataJSON() as { pageNumber: number };
    requested.push(body.pageNumber);
    const content = {
      typst: savedPage(`Fresh ${body.pageNumber}`),
      provider: "custom",
      model: "smoke",
    };
    await route.fulfill({
      contentType: "application/x-ndjson; charset=utf-8",
      body: `${JSON.stringify({ type: "start" })}\n${JSON.stringify({ type: "generated", content })}\n`,
    });
  });

  await openTranslatedPage(page, lumo.url, "pdf-auto.pdf");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("button", { name: "PDF: choose pages, layout and width…" }).click();
  const dialog = page.getByRole("dialog", { name: "Export translation as PDF" });
  await dialog.getByRole("button", { name: "All pages", exact: true }).click();
  await dialog.getByRole("button", { name: "Export PDF", exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30_000 }),
    dialog.getByRole("button", { name: "Translate 1 page first, then export" }).click(),
  ]);
  const exported = await readPdf(await download.path(), download.suggestedFilename());
  expect(requested).toEqual([2]);
  expect(exported.widths).toEqual([A4_WIDTH, A4_WIDTH]);
  expect(exported.texts[0]).toContain("Kept");
  expect(exported.texts[1]).toContain("Fresh 2");
});
