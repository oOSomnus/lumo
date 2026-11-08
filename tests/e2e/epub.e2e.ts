import type { APIRequestContext, Page, Request } from "@playwright/test";
import {
  FIXTURE_JPEG,
  IMAGE_PAGE_CHAPTER,
  downloadAllTranslations,
  fixtureEpub,
  pngDeclaring,
  SVG_PAGE_CHAPTER,
  expect,
  openApp,
  openFromLibrary,
  test,
  uploadEpub,
} from "./fixtures";
import { translatePageInputSchema } from "../../src/shared/contracts";
import { epubTranslationUnit } from "../../src/shared/epub";
import { MAX_EPUB_IMAGE_PIXELS } from "../../src/shared/limits";

const POSITION = /^Section (\d+) \/ (\d+) · page (\d+) \/ (\d+)$/;
const SAVED = { timeout: 20_000 };

interface Reference {
  text?: string;
  imageBase64?: string;
}

interface TranslateBody {
  documentId: string;
  targetLanguage: string;
  format: string;
  unit: string;
  sourceCfi: string;
  pageNumber: number;
  xhtml?: string;
  images?: { path: string; imageBase64: string }[];
  context?: { previous?: Reference; next?: Reference };
  repair?: { typst: string; diagnostics: string };
}

/** The toolbar's "Section a / b · page c / d" as numbers. */
async function readPosition(page: Page) {
  const label = page.locator(".epub-position");
  await expect(label).toHaveText(POSITION);
  const [section, sections, current, pages] = POSITION.exec((await label.textContent())!.trim())!
    .slice(1)
    .map(Number);
  return { section: section!, sections: sections!, page: current!, pages: pages! };
}

async function openBook(page: Page, url: string, name: string): Promise<void> {
  await openApp(page, url);
  await openFromLibrary(page, name);
  await page.getByRole("combobox", { name: /^Target language/ }).selectOption("en");
  await readPosition(page);
}

/** Only the model's answer is faked; page preparation, neighbours, Typst, PUT and SQLite stay real. The request itself must satisfy the wire contract for this book. */
async function fakeModel(
  page: Page,
  documentId: string,
  answer: (body: TranslateBody) => string = (body) => `= ${body.unit.slice(-6)}`,
): Promise<TranslateBody[]> {
  const requests: TranslateBody[] = [];
  await page.route(/\/api\/translate$/, async (route) => {
    const sent: unknown = route.request().postDataJSON();
    try {
      translatePageInputSchema.parse(sent);
      expect(sent).toMatchObject({ format: "epub", documentId, targetLanguage: "en" });
    } catch (error) {
      await route.abort();
      throw error;
    }
    const body = sent as TranslateBody;
    requests.push(body);
    const content = { typst: answer(body), provider: "custom", model: "smoke" };
    await route.fulfill({
      contentType: "application/x-ndjson; charset=utf-8",
      body: `${JSON.stringify({ type: "start" })}\n${JSON.stringify({ type: "generated", content })}\n`,
    });
  });
  return requests;
}

async function savedLocations(api: APIRequestContext, documentId: string) {
  const response = await api.get(
    `/api/documents/${documentId}/translation-locations?targetLanguage=en`,
  );
  const body: { locations: { pageNumber: number; unit: string; sourceCfi?: string }[] } =
    await response.json();
  return body.locations;
}

async function savedView(api: APIRequestContext, documentId: string) {
  const response = await api.get(`/api/documents/${documentId}/view`);
  const body: { view: { cfi?: string | null; fontSize?: number } | null } = await response.json();
  return body.view;
}

async function openContentsEntry(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Contents", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Contents of this book" })
    .getByRole("button", { name, exact: true })
    .click();
}

const paragraphNumbers = (text: string): Set<string | undefined> =>
  new Set([...text.matchAll(/Paragraph (\d+)\./g)].map((match) => match[1]));

test("EPUB contents panel opens an entry, closes with Escape and gives focus back", async ({
  page,
  lumo,
}) => {
  await uploadEpub(lumo.api, "long.epub", { long: true });
  await openBook(page, lumo.url, "long.epub");
  const before = await readPosition(page);

  const contents = page.getByRole("button", { name: "Contents", exact: true });
  await contents.click();
  const panel = page.getByRole("navigation", { name: "Contents of this book" });
  await expect(panel.getByRole("button", { name: "Chapter One", exact: true })).toHaveAttribute(
    "aria-current",
    "location",
  );
  await panel.getByRole("button", { name: "Part B", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(contents).toBeFocused();
  await expect.poll(async () => (await readPosition(page)).page).toBeGreaterThan(before.page);
  expect((await readPosition(page)).section).toBe(1);

  await contents.click();
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(contents).toBeFocused();

  await openContentsEntry(page, "Chapter Two");
  await expect.poll(async () => (await readPosition(page)).section).toBe(2);
});

test("EPUB translates the visible page, sends its neighbours as reference only and keeps each page apart", async ({
  page,
  lumo,
}) => {
  const document = await uploadEpub(lumo.api, "long.epub", { long: true });
  const requests = await fakeModel(page, document.id);
  await openBook(page, lumo.url, "long.epub");

  // A page inside the chapter has a neighbouring page on both sides.
  await openContentsEntry(page, "Part A");
  await expect.poll(async () => (await readPosition(page)).page).toBeGreaterThan(1);
  const middle = await readPosition(page);
  expect(middle.page).toBeLessThan(middle.pages);

  await page.getByRole("button", { name: "Translate this page" }).click();
  await expect(page.locator(".page-status")).toHaveText(/Saved/, SAVED);
  expect(requests).toHaveLength(1);
  const first = requests[0]!;
  expect(first.format).toBe("epub");
  expect(first.xhtml).toContain("Part A");
  const onPage = paragraphNumbers(first.xhtml ?? "");
  expect(onPage.size).toBeGreaterThan(0);
  for (const side of ["previous", "next"] as const) {
    const text = first.context?.[side]?.text ?? "";
    expect(text.length, `${side} excerpt`).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(2000);
    for (const number of paragraphNumbers(text)) {
      expect(onPage.has(number), `${side} excerpt repeats paragraph ${number}`).toBe(false);
    }
  }
  expect(await savedLocations(lumo.api, document.id)).toEqual([
    { pageNumber: 1, unit: first.unit, sourceCfi: first.sourceCfi },
  ]);

  // The next screen page is another unit with nothing saved yet.
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.locator(".epub-position")).toContainText(
    `page ${middle.page + 1} / ${middle.pages}`,
  );
  await page.getByRole("button", { name: "Translate this page" }).click();
  await expect.poll(() => requests.length).toBe(2);
  await expect(page.locator(".page-status")).toHaveText(/Saved/, SAVED);
  expect(requests[1]!.unit).not.toBe(first.unit);
  expect(requests[1]!.sourceCfi).not.toBe(first.sourceCfi);
  expect(await savedLocations(lumo.api, document.id)).toHaveLength(2);

  // Back on the first page, its own translation shows.
  await page.getByRole("button", { name: "Previous page", exact: true }).click();
  await expect(page.locator(".epub-position")).toContainText(
    `page ${middle.page} / ${middle.pages}`,
  );
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await expect(page.locator(".typst-source")).toContainText(`= ${first.unit.slice(-6)}`);
});

test("EPUB reading settings keep the position and persist across a reload", async ({
  page,
  lumo,
}) => {
  const document = await uploadEpub(lumo.api, "long.epub", { long: true });
  const requests = await fakeModel(page, document.id);
  await openBook(page, lumo.url, "long.epub");
  await openContentsEntry(page, "Part A");
  await expect.poll(async () => (await readPosition(page)).page).toBeGreaterThan(1);
  const before = await readPosition(page);

  await page.locator(".epub-settings summary").click();
  const larger = page.getByRole("button", { name: "Larger text" });
  await larger.click();
  await larger.click();
  await expect(page.locator(".epub-settings output")).toHaveText("22 px");
  await expect
    .poll(async () => (await readPosition(page)).pages)
    .toBeGreaterThan(before.pages);

  // The page that was on screen began at the heading, and still does after the text grew.
  await page.getByRole("button", { name: "Translate this page" }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]!.xhtml).toContain("Part A");
  await expect(page.locator(".page-status")).toHaveText(/Saved/, SAVED);
  const after = await readPosition(page);

  await expect
    .poll(async () => (await savedView(lumo.api, document.id))?.fontSize)
    .toBe(22);
  await page.reload();
  await openFromLibrary(page, "long.epub");
  expect(await readPosition(page)).toEqual(after);
  await page.locator(".epub-settings summary").click();
  await expect(page.locator(".epub-settings output")).toHaveText("22 px");
});

test("EPUB batch translates every screen page of a section once", async ({ page, lumo }) => {
  const document = await uploadEpub(lumo.api, "long.epub", { long: true });
  const requests = await fakeModel(page, document.id);
  await openBook(page, lumo.url, "long.epub");
  const before = await readPosition(page);
  const { pages } = before;
  expect(pages).toBeGreaterThan(2);

  await page.getByRole("tab", { name: "Batch translation" }).click();
  await page.getByRole("radio", { name: "By section number" }).check();
  await page.getByRole("button", { name: "Current section", exact: true }).click();
  await page.getByRole("button", { name: /^Start translation/ }).click();
  await expect.poll(() => requests.length, { timeout: 90_000 }).toBe(pages);
  await expect
    .poll(async () => (await savedLocations(lumo.api, document.id)).length, { timeout: 90_000 })
    .toBe(pages);
  expect(new Set(requests.map((request) => request.unit)).size).toBe(pages);
  expect(new Set(requests.map((request) => request.sourceCfi)).size).toBe(pages);
  await expect(page.locator(".batch-tasks")).toContainText(`page ${pages} / ${pages}`);
  // The batch lays pages out in a hidden rendition: what the reader sees stays put.
  expect(await readPosition(page)).toEqual(before);
});

test("EPUB sends an image-only neighbour as its image and omits a neighbour past the book's edge", async ({
  page,
  lumo,
}) => {
  const document = await uploadEpub(lumo.api, "pictures.epub", { chapter: IMAGE_PAGE_CHAPTER });
  const requests = await fakeModel(page, document.id);
  await openBook(page, lumo.url, "pictures.epub");
  const label = page.locator(".epub-position");
  await expect(label).toHaveText(/page 1 \/ 3$/);

  const translated = async (count: number): Promise<void> => {
    await page.getByRole("button", { name: "Translate this page" }).click();
    await expect.poll(() => requests.length).toBe(count);
    await expect(page.locator(".page-status")).toHaveText(/Saved/, SAVED);
  };
  await translated(1);
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(label).toContainText("page 2 / 3");
  await translated(2);
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(label).toContainText("page 3 / 3");
  await translated(3);
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(label).toContainText("Section 2 / 2");
  await translated(4);

  const [first, picture, after, last] = requests as [TranslateBody, TranslateBody, TranslateBody, TranslateBody];
  // The first page has nothing before it; the page after it holds only an image.
  expect(first.context?.previous).toBeUndefined();
  expect(first.context?.next?.text).toBeUndefined();
  expect(first.context?.next?.imageBase64).toMatch(/^\/9j\//);
  // The image page itself carries its image; the pages around it are text.
  expect(picture.xhtml).toContain("<img");
  expect(picture.images).toHaveLength(1);
  expect(picture.context?.previous?.text).toContain("Text before the image.");
  expect(picture.context?.next?.text).toContain("Text after the image.");
  // A neighbour crosses into the next section; the image is the reference before it.
  expect(after.context?.previous?.imageBase64).toMatch(/^\/9j\//);
  expect(after.context?.next?.text).toContain("Chapter Two");
  // The last page of the book has nothing after it.
  expect(last.context?.previous?.text).toContain("Text after the image.");
  expect(last.context?.next).toBeUndefined();
});

test("EPUB disables translating a page with nothing to translate and says why", async ({
  page,
  lumo,
}) => {
  const document = await uploadEpub(lumo.api, "figure.epub", { chapter: SVG_PAGE_CHAPTER });
  const requests = await fakeModel(page, document.id);
  await openBook(page, lumo.url, "figure.epub");
  const label = page.locator(".epub-position");
  const translate = page.getByRole("button", { name: "Translate this page" });
  await expect(label).toContainText("page 1 / 2");
  await expect(translate).toBeEnabled();

  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(label).toContainText("page 2 / 2");
  await expect(translate).toBeDisabled();
  await expect(page.getByText("This page has no text or image the reader can translate.")).toBeVisible();
  expect(requests).toHaveLength(0);

  // The page after it translates again.
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(label).toContainText("Section 2 / 2");
  await expect(translate).toBeEnabled();
});

test("EPUB repair sends the failing Typst only, never the page", async ({ page, lumo }) => {
  const document = await uploadEpub(lumo.api, "novel.epub");
  const broken = "#set page(width:180mm,height:auto)\n#strong[应收账款（Accounts Receivable）";
  const requests = await fakeModel(page, document.id, (body) => (body.repair ? `${broken}]` : broken));
  await openBook(page, lumo.url, "novel.epub");

  await page.getByRole("button", { name: "Translate this page" }).click();
  await expect(page.locator(".page-status")).toHaveText(/Saved/, SAVED);
  expect(requests).toHaveLength(2);
  const [generation, repair] = requests as [TranslateBody, TranslateBody];
  expect(generation.xhtml).toContain("Hello world from EPUB.");
  expect(repair.repair?.typst).toBe(broken);
  expect(repair.unit).toBe(generation.unit);
  expect(repair.sourceCfi).toBe(generation.sourceCfi);
  for (const field of ["xhtml", "images", "context"]) {
    expect(repair, `repair carries ${field}`).not.toHaveProperty(field);
  }
});

test("EPUB selection is its own unit, the page keeps its translation and the position survives a reload", async ({
  page,
  lumo,
}) => {
  const document = await uploadEpub(lumo.api, "novel.epub");
  const requests = await fakeModel(page, document.id);
  await openBook(page, lumo.url, "novel.epub");
  const book = () => page.frameLocator("iframe.epub-frame").frameLocator("iframe").first();
  await book().getByText("Chapter One").waitFor();
  await expect.poll(() => readPosition(page)).toEqual({ section: 1, sections: 2, page: 1, pages: 1 });

  await page.getByRole("button", { name: "Translate this page" }).click();
  await expect(page.locator(".page-status")).toHaveText(/Saved/, SAVED);
  const pageRequest = requests[0]!;
  expect(pageRequest.xhtml).toContain("Hello world from EPUB.");
  expect(pageRequest.images).toHaveLength(1);
  expect(pageRequest.images![0]!.path).toMatch(/^assets\/[a-f0-9]{64}\.jpg$/);
  await expect(page.locator(".typst-preview iframe")).toBeVisible();

  await book()
    .locator("p")
    .evaluate((element) => {
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      const selection = element.ownerDocument.defaultView?.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
  await expect(page.locator(".epub-selection")).toContainText("Hello world from EPUB.");
  await page.getByRole("button", { name: "Translate selection" }).click();
  await expect.poll(() => requests.length).toBe(2);
  await expect(page.locator(".page-status")).toHaveText(/Saved/, SAVED);
  expect(requests[1]!.unit).toMatch(/^sel-/);
  expect(requests[1]).not.toHaveProperty("context");
  const locations = await savedLocations(lumo.api, document.id);
  expect(locations.map((location) => location.unit).sort()).toEqual(
    [pageRequest.unit, requests[1]!.unit].sort(),
  );

  await page.getByRole("button", { name: "Clear selection" }).click();
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await expect(page.locator(".typst-source")).toContainText(`= ${pageRequest.unit.slice(-6)}`);

  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await book().getByText("Chapter Two").waitFor();
  await expect.poll(() => readPosition(page)).toEqual({ section: 2, sections: 2, page: 1, pages: 1 });
  await expect
    .poll(async () => (await savedView(lumo.api, document.id))?.cfi)
    .toContain("/6/4");

  await page.reload();
  await openFromLibrary(page, "novel.epub");
  await book().getByText("Chapter Two").waitFor();
  await expect.poll(() => readPosition(page)).toEqual({ section: 2, sections: 2, page: 1, pages: 1 });
});

test("EPUB contents and settings stay usable on a narrow screen", async ({ page, lumo }) => {
  await uploadEpub(lumo.api, "long.epub", { long: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, lumo.url);
  await openFromLibrary(page, "long.epub");
  await readPosition(page);

  await openContentsEntry(page, "Chapter Two");
  await expect.poll(async () => (await readPosition(page)).section).toBe(2);

  await page.locator(".epub-settings summary").click();
  const panel = page.locator(".epub-settings-panel");
  await expect(panel).toBeVisible();
  const box = (await panel.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});

test("EPUB export writes whole pages in reading order and leaves selections out", async ({
  page,
  lumo,
}) => {
  const document = await uploadEpub(lumo.api, "long.epub", { long: true });
  const requests = await fakeModel(
    page,
    document.id,
    (body) => `= ${body.xhtml?.match(/Part A|Part B|Chapter One/)?.[0]}`,
  );
  await openBook(page, lumo.url, "long.epub");

  const translate = async () => {
    const before = requests.length;
    await page.getByRole("button", { name: "Translate this page" }).click();
    await expect.poll(() => requests.length).toBe(before + 1);
    await expect(page.locator(".page-status")).toHaveText(/Saved/, SAVED);
  };
  // Translated out of reading order on purpose: Part B, the first page, then Part A.
  await openContentsEntry(page, "Part B");
  await expect.poll(async () => (await readPosition(page)).page).toBeGreaterThan(1);
  await translate();
  await openContentsEntry(page, "Chapter One");
  await expect.poll(async () => (await readPosition(page)).page).toBe(1);
  await translate();
  await openContentsEntry(page, "Part A");
  await expect.poll(async () => (await readPosition(page)).page).toBeGreaterThan(1);
  await translate();

  // A selection of the same section is a saved record too, but never part of the export.
  const sourceCfi = "epubcfi(/6/2!/4,/2/1:0,/2/1:5)";
  const seeded = await lumo.api.put(
    `/api/documents/${document.id}/translations/1/en?unit=${await epubTranslationUnit("selection", sourceCfi)}`,
    { data: { typst: "= selection", provider: "custom", model: "smoke", sourceCfi } },
  );
  expect(seeded.ok()).toBe(true);

  const files = await downloadAllTranslations(page);
  const names = Object.keys(files).sort();
  expect(names).toEqual(["1-s1-en.typ", "2-s1-en.typ", "3-s1-en.typ"]);
  const text = new TextDecoder();
  expect(names.map((name) => text.decode(files[name]))).toEqual(["= Chapter One", "= Part A", "= Part B"]);
});

test("EPUB export returns each source image byte for byte beside the page's Typst", async ({
  page,
  lumo,
}) => {
  const document = await uploadEpub(lumo.api, "novel.epub");
  const requests = await fakeModel(
    page,
    document.id,
    (body) => `= Page\n#image("${body.images![0]!.path}")`,
  );
  await openBook(page, lumo.url, "novel.epub");
  await page.getByRole("button", { name: "Translate this page" }).click();
  await expect(page.locator(".page-status")).toHaveText(/Saved/, SAVED);
  const path = requests[0]!.images![0]!.path;

  const files = await downloadAllTranslations(page);
  expect(Object.keys(files).sort()).toEqual(["1-s1-en.typ", path]);
  expect(Buffer.from(files[path]!).equals(FIXTURE_JPEG)).toBe(true);
  expect(new TextDecoder().decode(files["1-s1-en.typ"])).toContain(`#image("${path}")`);
});

test("EPUB batch still translates every screen page while a narrow screen hides the book", async ({
  page,
  lumo,
}) => {
  const document = await uploadEpub(lumo.api, "long.epub", { long: true });
  const requests = await fakeModel(page, document.id);
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, lumo.url);
  await openFromLibrary(page, "long.epub");
  const before = await readPosition(page);
  expect(before.pages).toBeGreaterThan(2);

  await page.getByRole("tab", { name: "Batch", exact: true }).click();
  const panel = page.locator(".batch-panel");
  await panel.getByRole("combobox", { name: /^Target language/ }).selectOption("en");
  await panel.getByRole("radio", { name: "By section number" }).check();
  await panel.getByRole("button", { name: "Current section", exact: true }).click();
  await panel.getByRole("button", { name: /^Start translation/ }).click();
  await expect.poll(() => requests.length, { timeout: 90_000 }).toBe(before.pages);
  await expect
    .poll(async () => (await savedLocations(lumo.api, document.id)).length, { timeout: 90_000 })
    .toBe(before.pages);
  expect(new Set(requests.map((request) => request.unit)).size).toBe(before.pages);

  await page.getByRole("tab", { name: "Original", exact: true }).click();
  expect(await readPosition(page)).toEqual(before);
});

/**
 * Keeps the first matching request from reaching the viewer, like a layout that never finishes.
 * `fontSize` narrows `setView` to a settings change (the view restored on open has another size).
 * Call it before the page loads: the listener has to come before the viewer's own.
 */
async function holdFirstRequest(
  page: Page,
  op: string,
  fontSize?: number,
): Promise<{ held: () => Promise<number> }> {
  await page.addInitScript(
    ({ wanted, size }) => {
      if (!location.pathname.endsWith("/epub-viewer.html")) return;
      const held: unknown[] = [];
      Object.assign(window, { held });
      window.addEventListener(
        "message",
        (event: MessageEvent) => {
          const message = event.data;
          if (
            held.length === 0 &&
            message?.type === "request" &&
            message.request?.op === wanted &&
            (size === undefined || message.request.view?.fontSize === size)
          ) {
            held.push(message);
            event.stopImmediatePropagation();
          }
        },
        true,
      );
    },
    { wanted: op, size: fontSize },
  );
  return {
    held: () =>
      page
        .frames()
        .find((frame) => frame.url().endsWith("/typst/epub-viewer.html"))!
        .evaluate(() => (window as unknown as { held: unknown[] }).held.length),
  };
}

/** Opens the reading settings unless they already are. */
async function openSettings(page: Page): Promise<void> {
  if (!(await page.locator(".epub-settings-panel").isVisible())) {
    await page.locator(".epub-settings summary").click();
  }
}

test("EPUB reading settings still being applied to one book leave the next book usable and unflagged", async ({
  page,
  lumo,
}) => {
  await uploadEpub(lumo.api, "long.epub", { long: true });
  const second = await uploadEpub(lumo.api, "novel.epub");
  const requests = await fakeModel(page, second.id);
  const viewer = await holdFirstRequest(page, "setView", 20);
  await openBook(page, lumo.url, "long.epub");

  await openSettings(page);
  await page.getByRole("button", { name: "Larger text" }).click();
  await expect.poll(viewer.held).toBe(1);

  // The first book's settings request is still pending when the second book is opened.
  await openFromLibrary(page, "novel.epub");
  await readPosition(page);
  await expect(page.locator(".viewer-error")).toHaveCount(0);

  await openSettings(page);
  await page.getByRole("button", { name: "Larger text" }).click();
  await expect(page.locator(".epub-settings output")).toHaveText("20 px");
  await expect(page.getByRole("button", { name: "Translate this page" })).toBeEnabled();
  await page.getByRole("button", { name: "Translate this page" }).click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.locator(".page-status")).toHaveText(/Saved/, SAVED);
  await expect(page.locator(".viewer-error")).toHaveCount(0);
});

/**
 * Records the pixel count each PNG declares as the viewer hands it to the browser's decoder, and refuses the ones over `limit`
 * as a decoder out of memory would, so a test never allocates what it is guarding against.
 */
async function watchPngDecoding(
  page: Page,
  limit: number,
): Promise<() => Promise<number[]>> {
  await page.addInitScript((pixelLimit) => {
    if (!location.pathname.endsWith("/epub-viewer.html")) return;
    const declared: number[] = [];
    const real = window.createImageBitmap.bind(window) as (...args: unknown[]) => Promise<ImageBitmap>;
    Object.assign(window, {
      declared,
      createImageBitmap: async (source: unknown, ...rest: unknown[]) => {
        if (source instanceof Blob && source.type === "image/png") {
          const header = new DataView(await source.slice(0, 24).arrayBuffer());
          const pixels = header.getUint32(16) * header.getUint32(20);
          declared.push(pixels);
          if (pixels > pixelLimit) throw new DOMException("out of memory", "InvalidStateError");
        }
        return real(source, ...rest);
      },
    });
  }, limit);
  return () =>
    page
      .frames()
      .find((frame) => frame.url().endsWith("/typst/epub-viewer.html"))!
      .evaluate(() => (window as unknown as { declared: number[] }).declared);
}

test("EPUB images over the pixel limit never reach the decoder, and their pages still translate", async ({
  page,
  lumo,
}) => {
  const chapter = IMAGE_PAGE_CHAPTER.replace("images/pic.jpg", "images/huge.png");
  const document = await uploadEpub(lumo.api, "huge.epub", {
    chapter,
    images: { "huge.png": pngDeclaring(12_000, 12_000) },
  });
  const requests = await fakeModel(page, document.id);
  const declared = await watchPngDecoding(page, MAX_EPUB_IMAGE_PIXELS);
  await openBook(page, lumo.url, "huge.epub");
  const label = page.locator(".epub-position");
  await expect(label).toHaveText(/page 1 \/ 3$/);

  // The page before the picture reads it as its neighbour; the picture's own page reads it as its preview.
  await page.getByRole("button", { name: "Translate this page" }).click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.locator(".page-status")).toHaveText(/Saved/, SAVED);
  await expect(page.locator(".page-warning")).toBeVisible();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(label).toContainText("page 2 / 3");
  await page.getByRole("button", { name: "Translate this page" }).click();
  await expect.poll(() => requests.length).toBe(2);
  await expect(page.locator(".page-status")).toHaveText(/Saved/, SAVED);

  expect(requests[0]!.context?.next).toBeUndefined();
  expect(requests[1]!.xhtml).toContain("<img");
  expect(requests[1]!.images).toEqual([]);
  expect((await declared()).filter((pixels) => pixels > MAX_EPUB_IMAGE_PIXELS)).toEqual([]);
});

/** Keeps the next EPUB upload on the wire until `release()`; every other request goes through. */
async function holdUpload(page: Page): Promise<{ started: Promise<unknown>; release: () => void }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().includes("/api/documents?"),
  );
  await page.route(/\/api\/documents\?/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await gate;
    await route.continue();
  });
  return { started, release };
}

const chosenEpub = async (name: string) => ({
  name,
  mimeType: "application/epub+zip",
  buffer: Buffer.from(await fixtureEpub()),
});

test("an EPUB upload that finishes after returning to the Library lists the book and keeps the user there", async ({
  page,
  lumo,
}) => {
  await uploadEpub(lumo.api, "long.epub", { long: true });
  await openBook(page, lumo.url, "long.epub");
  const upload = await holdUpload(page);
  await page.locator('input[type="file"]').setInputFiles(await chosenEpub("second.epub"));
  await upload.started;
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("main", { name: "Library" });
  await expect(library).toBeVisible();

  upload.release();
  await expect(library.getByRole("button", { name: "second.epub", exact: true })).toBeVisible();
  // The old code opened the uploaded book a few ticks after its response; give it that time.
  await page.waitForTimeout(500);
  await expect(library).toBeVisible();
  await expect(page.getByRole("button", { name: "Return to reading", exact: true })).toBeVisible();
});

test("an EPUB upload that finishes after the open book was deleted still joins the Library", async ({
  page,
  lumo,
}) => {
  await uploadEpub(lumo.api, "long.epub", { long: true });
  await openBook(page, lumo.url, "long.epub");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("main", { name: "Library" });
  await expect(library).toBeVisible();

  const upload = await holdUpload(page);
  await page.locator('input[type="file"]').setInputFiles(await chosenEpub("second.epub"));
  await upload.started;
  await library
    .getByRole("listitem")
    .filter({ hasText: "long.epub" })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Delete document?" })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(library.getByRole("button", { name: "long.epub", exact: true })).toHaveCount(0);

  upload.release();
  await expect(library.getByRole("button", { name: "second.epub", exact: true })).toBeVisible();
  await expect(library).toBeVisible();
});

/**
 * Lets a test keep the viewer's measuring of a selection unfinished (it ends in a SHA-256 of the range)
 * while the page turns, the selection is cleared or something else is selected.
 */
async function holdSelections(page: Page) {
  type Control = { holding: boolean; held: number; finished: number; gates: (() => void)[] };
  await page.addInitScript(() => {
    if (!location.pathname.endsWith("/epub-viewer.html")) return;
    const control: Control = { holding: false, held: 0, finished: 0, gates: [] };
    Object.assign(window, { selectionDigests: control });
    const real = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      const selection = control.holding && new TextDecoder().decode(data).startsWith("selection\n");
      if (selection) {
        control.held += 1;
        await new Promise<void>((resolve) => control.gates.push(resolve));
      }
      const result = await real(algorithm, data);
      if (selection) control.finished += 1;
      return result;
    };
  });
  const viewer = () => page.frames().find((frame) => frame.url().endsWith("/typst/epub-viewer.html"))!;
  const control = () => viewer().evaluate(() => (window as unknown as { selectionDigests: Control }).selectionDigests);
  const setHolding = (holding: boolean) =>
    viewer().evaluate((value) => {
      (window as unknown as { selectionDigests: Control }).selectionDigests.holding = value;
    }, holding);
  return {
    /** From now on, measuring a selection waits until `release()`. */
    hold: () => setHolding(true),
    /** Measuring starts passing through again; what is already held stays held. */
    pass: () => setHolding(false),
    held: async () => (await control()).held,
    /** Lets every held measuring finish, then gives the viewer's message and the app's render time to land. */
    release: async () => {
      await setHolding(false);
      await viewer().evaluate(() => {
        for (const open of (window as unknown as { selectionDigests: Control }).selectionDigests.gates.splice(0)) open();
      });
      await expect.poll(async () => (await control()).finished).toBe((await control()).held);
      await page.waitForTimeout(250);
    },
  };
}

/** Selects the text of the n-th paragraph on screen in the book. */
async function selectParagraph(page: Page, index: number): Promise<void> {
  await page
    .frameLocator("iframe.epub-frame")
    .frameLocator("iframe")
    .first()
    .locator("p")
    .nth(index)
    .evaluate((element) => {
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      const selection = element.ownerDocument.defaultView?.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
}

/** How many ranges the book's own selection holds; 0 once the viewer has cleared it. */
const selectedRanges = (page: Page): Promise<number> =>
  page
    .frameLocator("iframe.epub-frame")
    .frameLocator("iframe")
    .first()
    .locator("body")
    .evaluate((body) => body.ownerDocument.defaultView?.getSelection()?.rangeCount ?? 0);

test("an EPUB selection still being measured when the page turns is dropped, not shown on the next page", async ({
  page,
  lumo,
}) => {
  await uploadEpub(lumo.api, "long.epub", { long: true });
  const selections = await holdSelections(page);
  await openBook(page, lumo.url, "long.epub");
  await selections.hold();
  await selectParagraph(page, 0);
  await expect.poll(selections.held).toBe(1);

  const before = await readPosition(page);
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect.poll(async () => (await readPosition(page)).page).toBe(before.page + 1);
  await selections.release();

  await expect(page.locator(".epub-selection")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Translate this page" })).toBeVisible();
});

test("an EPUB selection still being measured when it is cleared does not come back", async ({ page, lumo }) => {
  await uploadEpub(lumo.api, "long.epub", { long: true });
  const selections = await holdSelections(page);
  await openBook(page, lumo.url, "long.epub");
  await selectParagraph(page, 0);
  await expect(page.locator(".epub-selection")).toContainText("Paragraph 01.");

  await selections.hold();
  await selectParagraph(page, 1);
  await expect.poll(selections.held).toBe(1);
  await page.getByRole("button", { name: "Clear selection" }).click();
  // The viewer has handled the clear once the book's own selection is gone.
  await expect.poll(() => selectedRanges(page)).toBe(0);
  await selections.release();

  await expect(page.locator(".epub-selection")).toHaveCount(0);
});

test("an older EPUB selection that finishes after a newer one never replaces it", async ({ page, lumo }) => {
  await uploadEpub(lumo.api, "long.epub", { long: true });
  const selections = await holdSelections(page);
  await openBook(page, lumo.url, "long.epub");
  await selections.hold();
  await selectParagraph(page, 0);
  await expect.poll(selections.held).toBe(1);
  await selections.pass();
  await selectParagraph(page, 1);
  await expect(page.locator(".epub-selection")).toContainText("Paragraph 02.");
  await selections.release();

  await expect(page.locator(".epub-selection")).toContainText("Paragraph 02.");
  await expect(page.locator(".epub-selection")).not.toContainText("Paragraph 01.");
});

test("an EPUB batch still looking for its pages blocks the interface language switch until it is stopped", async ({
  page,
  lumo,
}) => {
  const document = await uploadEpub(lumo.api, "long.epub", { long: true });
  await fakeModel(page, document.id);
  const pages = await holdFirstRequest(page, "pages");
  await openBook(page, lumo.url, "long.epub");
  await page.getByRole("tab", { name: "Batch translation" }).click();
  await page.getByRole("radio", { name: "By section number" }).check();
  await page.getByRole("button", { name: "Current section", exact: true }).click();
  await page.getByRole("button", { name: /^Start translation/ }).click();
  // No page is found, so no task exists yet: only the running batch stands in the way.
  await expect.poll(pages.held).toBe(1);

  const apply = async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("combobox", { name: /^Interface language/ }).selectOption("zh-CN");
    return { settings, button: settings.getByRole("button", { name: "Save language and reload" }) };
  };
  const blocked = await apply();
  await expect(blocked.button).toBeDisabled();
  await expect(blocked.settings.getByRole("status")).toContainText("translation");
  await blocked.settings.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByRole("button", { name: "Stop all", exact: true }).click();
  const unblocked = await apply();
  await expect(unblocked.button).toBeEnabled();
});

test("EPUB 'Untranslated sections' also selects a section whose other screen pages have no translation yet", async ({
  page,
  lumo,
}) => {
  const document = await uploadEpub(lumo.api, "long.epub", { long: true });
  const requests = await fakeModel(page, document.id);
  await openBook(page, lumo.url, "long.epub");
  const { pages } = await readPosition(page);
  expect(pages).toBeGreaterThan(2);

  // Only the first screen page of section 1 is translated.
  await page.getByRole("button", { name: "Translate this page" }).click();
  await expect(page.locator(".page-status")).toHaveText(/Saved/, SAVED);
  expect(await savedLocations(lumo.api, document.id)).toHaveLength(1);

  await page.getByRole("tab", { name: "Batch translation" }).click();
  await page.getByRole("radio", { name: "By section number" }).check();
  await page.getByRole("button", { name: "Untranslated sections", exact: true }).click();
  const start = page.getByRole("button", { name: /^Start translation/ });
  await expect(start).toHaveText("Start translation (2 sections)", { timeout: 30_000 });
  await start.click();

  // The other pages of section 1 and the single page of section 2; the first page is not sent again.
  await expect.poll(() => requests.length, { timeout: 90_000 }).toBe(pages + 1);
  await expect
    .poll(async () => (await savedLocations(lumo.api, document.id)).length, { timeout: 90_000 })
    .toBe(pages + 1);
  expect(new Set(requests.map((request) => request.unit)).size).toBe(pages + 1);
});

test("EPUB 'Untranslated sections' counts the pages of the current layout, not the ones saved at another", async ({
  page,
  lumo,
}) => {
  const document = await uploadEpub(lumo.api, "long.epub", { long: true });
  const requests = await fakeModel(page, document.id);
  await openBook(page, lumo.url, "long.epub");
  const before = await readPosition(page);

  await page.getByRole("tab", { name: "Batch translation" }).click();
  await page.getByRole("radio", { name: "By section number" }).check();
  await page.getByRole("button", { name: "All sections", exact: true }).click();
  await page.getByRole("button", { name: /^Start translation/ }).click();
  await expect.poll(() => requests.length, { timeout: 90_000 }).toBe(before.pages + 1);
  await expect
    .poll(async () => (await savedLocations(lumo.api, document.id)).length, { timeout: 90_000 })
    .toBe(before.pages + 1);

  // Larger text moves the page boundaries of section 1; section 2 is one page at either size.
  await openSettings(page);
  const larger = page.getByRole("button", { name: "Larger text" });
  await larger.click();
  await larger.click();
  await expect(page.locator(".epub-settings output")).toHaveText("22 px");
  await expect.poll(async () => (await readPosition(page)).pages).toBeGreaterThan(before.pages);
  const after = await readPosition(page);

  await page.getByRole("button", { name: "Untranslated sections", exact: true }).click();
  const start = page.getByRole("button", { name: /^Start translation/ });
  await expect(start).toHaveText("Start translation (1 section)", { timeout: 30_000 });
  await start.click();

  const total = before.pages + 1 + after.pages;
  await expect.poll(() => requests.length, { timeout: 90_000 }).toBe(total);
  await expect
    .poll(async () => (await savedLocations(lumo.api, document.id)).length, { timeout: 90_000 })
    .toBe(total);
  expect(new Set(requests.map((request) => request.unit)).size).toBe(total);
});

test("the EPUB 'Untranslated sections' shortcut shows its progress, blocks a second run and can be stopped", async ({
  page,
  lumo,
}) => {
  const document = await uploadEpub(lumo.api, "long.epub", { long: true });
  await fakeModel(page, document.id);
  const pages = await holdFirstRequest(page, "pages");
  await openBook(page, lumo.url, "long.epub");
  await page.getByRole("tab", { name: "Batch translation" }).click();
  await page.getByRole("radio", { name: "By section number" }).check();

  const shortcut = page.getByRole("button", { name: "Untranslated sections", exact: true });
  await shortcut.click();
  await expect.poll(pages.held).toBe(1);
  await expect(page.getByText("Finding pages… 0 found")).toBeVisible();
  await expect(shortcut).toBeDisabled();
  await expect(page.getByRole("button", { name: /^Start translation/ })).toBeDisabled();

  await page.getByRole("button", { name: "Stop all", exact: true }).click();
  await expect(shortcut).toBeEnabled();
  await shortcut.click();
  await expect(page.getByRole("button", { name: /^Start translation/ })).toHaveText(
    "Start translation (2 sections)",
    { timeout: 30_000 },
  );
});

test("an EPUB Contents checkbox for Chapter Two translates that section only", async ({ page, lumo }) => {
  const document = await uploadEpub(lumo.api, "long.epub", { long: true });
  const requests = await fakeModel(page, document.id);
  await openBook(page, lumo.url, "long.epub");

  await page.getByRole("tab", { name: "Batch translation" }).click();
  await page.getByRole("checkbox", { name: "Select section 2", exact: true }).check();
  for (const first of await page.getByRole("checkbox", { name: "Select section 1", exact: true }).all()) {
    await expect(first).not.toBeChecked();
  }
  await page.getByRole("button", { name: "Start translation (1 section)", exact: true }).click();

  await expect
    .poll(async () => (await savedLocations(lumo.api, document.id)).length, SAVED)
    .toBe(1);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ pageNumber: 2 });
  expect((await savedLocations(lumo.api, document.id))[0]).toMatchObject({ pageNumber: 2 });
});

test("an EPUB section ticked through its chapter and its sub-entries is translated once per page", async ({
  page,
  lumo,
}) => {
  const document = await uploadEpub(lumo.api, "long.epub", { long: true });
  const requests = await fakeModel(page, document.id);
  await openBook(page, lumo.url, "long.epub");
  const { pages } = await readPosition(page);

  await page.getByRole("tab", { name: "Batch translation" }).click();
  const rows = await page.getByRole("checkbox", { name: "Select section 1", exact: true }).all();
  expect(rows.length).toBeGreaterThan(1);
  for (const row of rows) await row.check();
  await page.getByRole("button", { name: "Start translation (1 section)", exact: true }).click();

  await expect
    .poll(async () => (await savedLocations(lumo.api, document.id)).length, { timeout: 90_000 })
    .toBe(pages);
  expect(requests).toHaveLength(pages);
  expect(new Set(requests.map((request) => request.unit)).size).toBe(pages);
});

/** Everything an EPUB can try against its reader: none of it may run, fetch or leave the book. */
const HOSTILE_CHAPTER = [
  '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title>',
  '<meta http-equiv="refresh" content="0;url=http://evil.invalid/refresh"/>',
  '<link rel="stylesheet" href="http://evil.invalid/style.css"/>',
  '<style>@import url("http://evil.invalid/import.css"); p { background-image: url("http://evil.invalid/background.png"); }</style>',
  '<script>window.top.__pwned = "script"; window.parent.__pwned = "script"; fetch("http://evil.invalid/script");</script>',
  "</head><body onload=\"window.top.__pwned = 'onload'\">",
  "<h1>Chapter One</h1>",
  "<p onclick=\"window.top.__pwned = 'onclick'\">Visible text.</p>",
  "<p><a href=\"javascript:window.top.__pwned = 'href'\">Hostile link</a></p>",
  '<p><a href="http://evil.invalid/link">Remote link</a></p>',
  "<p><img src=\"images/missing.png\" onerror=\"window.top.__pwned = 'onerror'\" alt=\"missing\"/></p>",
  '<p><img src="http://evil.invalid/remote.png" alt="remote"/></p>',
  '<iframe src="http://evil.invalid/frame"></iframe>',
  '<form action="http://evil.invalid/form"><button type="submit">Send</button></form>',
  '<object data="http://evil.invalid/object"></object>',
  '<audio src="http://evil.invalid/audio.mp3"></audio>',
  "</body></html>",
].join("");

test("an EPUB with scripts, handlers, javascript: links and remote resources runs nothing and fetches nothing", async ({
  page,
  context,
  lumo,
}) => {
  await uploadEpub(lumo.api, "hostile.epub", { chapter: HOSTILE_CHAPTER });
  const appOrigin = new URL(lumo.url).origin;
  // A request the browser's content security policy stops is attempted but never sent; the others reach the network.
  const attempts = new Map<Request, string>();
  const popups: string[] = [];
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol.startsWith("http") && url.origin !== appOrigin) attempts.set(request, "sent");
  });
  context.on("requestfailed", (request) => {
    if (attempts.has(request)) attempts.set(request, request.failure()?.errorText ?? "failed");
  });
  context.on("page", (popup) => popups.push(popup.url()));
  await openBook(page, lumo.url, "hostile.epub");
  const book = page.frameLocator("iframe.epub-frame").frameLocator("iframe").first();
  await expect(book.getByText("Visible text.")).toBeVisible();

  // Everything a reader could do with the hostile elements.
  await book.getByText("Visible text.").click();
  await book.getByRole("link", { name: "Hostile link" }).click();
  await book.getByRole("link", { name: "Remote link" }).click();
  await book.getByRole("button", { name: "Send" }).click();
  await page.waitForTimeout(500);

  const viewer = page.frames().filter((frame) => frame.url().endsWith("/epub-viewer.html"));
  expect(viewer).toHaveLength(1);
  for (const frame of [page.mainFrame(), ...viewer]) {
    expect(await frame.evaluate(() => (window as unknown as { __pwned?: string }).__pwned)).toBeUndefined();
  }
  await expect.poll(() => [...attempts.values()].includes("sent")).toBe(false);
  expect(
    [...attempts].filter(([, outcome]) => outcome !== "csp").map(([request, outcome]) => `${outcome} ${request.url()}`),
  ).toEqual([]);
  expect(popups).toEqual([]);
  await readPosition(page);
});

test("an EPUB that cannot be read is refused with an alert and never stored, and the Library keeps working", async ({
  page,
  lumo,
}) => {
  await openApp(page, lumo.url);
  const valid = Buffer.from(await fixtureEpub());
  const unreadable = [
    ["not-a-zip.epub", Buffer.from("this is not a zip archive")],
    ["truncated.epub", valid.subarray(0, valid.length - 40)],
  ] as const;
  const library = page.getByRole("main", { name: "Library" });
  const banner = page.locator(".app-banner.error");
  for (const [name, buffer] of unreadable) {
    const answer = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().includes("/api/documents?"),
    );
    await page.locator('input[type="file"]').setInputFiles({ name, mimeType: "application/epub+zip", buffer });
    expect((await answer).status()).toBe(400);
    await expect(banner).toBeVisible();
    await expect(library.getByRole("button", { name, exact: true })).toHaveCount(0);
  }
  const stored: { documents: unknown[] } = await (await lumo.api.get("/api/library")).json();
  expect(stored.documents).toEqual([]);

  await page.locator('input[type="file"]').setInputFiles({ name: "intact.epub", mimeType: "application/epub+zip", buffer: valid });
  await readPosition(page);
});

test("an EPUB translation that finishes while the Library is showing is saved and is there on return", async ({
  page,
  lumo,
}) => {
  const document = await uploadEpub(lumo.api, "long.epub", { long: true });
  const requests = await fakeModel(page, document.id);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  // Registered after the fake model, so it sees the request first and hands it on once released.
  await page.route(/\/api\/translate$/, async (route) => {
    entered.resolve();
    await release.promise;
    await route.fallback();
  });
  await openBook(page, lumo.url, "long.epub");
  const before = await readPosition(page);
  await page.getByRole("button", { name: "Translate this page" }).click();
  await entered.promise;

  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.getByRole("main", { name: "Library" })).toBeVisible();
  release.resolve();
  await expect
    .poll(async () => (await savedLocations(lumo.api, document.id)).length, SAVED)
    .toBe(1);

  await page.getByRole("button", { name: "Return to reading", exact: true }).click();
  await expect(page.locator(".page-status")).toHaveText(/Saved/, SAVED);
  await expect(page.locator(".typst-preview iframe")).toBeVisible();
  expect(await readPosition(page)).toEqual(before);
  expect(requests).toHaveLength(1);
});

test("ArrowLeft and ArrowRight turn EPUB pages from the viewer, the chapter frame and the translation, cross into the next section and stop at the book's edges", async ({
  page,
  lumo,
}) => {
  const document = await uploadEpub(lumo.api, "long.epub", { long: true });
  await fakeModel(page, document.id);
  await openBook(page, lumo.url, "long.epub");
  const first = await readPosition(page);
  expect(first.pages).toBeGreaterThan(3);
  const at = (section: number, current: number) =>
    expect
      .poll(async () => {
        const position = await readPosition(page);
        return [position.section, position.page];
      })
      .toEqual([section, current]);

  // The viewer's own document: the first page is the book's edge, and the next press turns exactly one page.
  await page.locator("iframe.epub-frame").focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowRight");
  await at(1, 2);

  // The chapter's frame inside the viewer; its body is a strip of columns, so the frame is focused rather than clicked.
  await page.frameLocator("iframe.epub-frame").locator("iframe").focus();
  await page.keyboard.press("ArrowRight");
  await at(1, 3);

  // The translation's preview frame.
  await page.getByRole("button", { name: "Translate this page" }).click();
  await expect(page.locator(".page-status")).toHaveText(/Saved/, SAVED);
  const preview = page.frameLocator(".typst-preview iframe");
  await expect(preview.locator("body > svg")).toBeVisible();
  await preview.locator("body").click();
  await page.keyboard.press("ArrowRight");
  await at(1, 4);
  await page.keyboard.press("ArrowLeft");
  await at(1, 3);

  // Through the rest of the section, then into the next one.
  for (let next = 4; next <= first.pages; next += 1) {
    await page.keyboard.press("ArrowRight");
    await at(1, next);
  }
  await page.keyboard.press("ArrowRight");
  await at(2, 1);
  const last = await readPosition(page);
  for (let next = 2; next <= last.pages; next += 1) {
    await page.keyboard.press("ArrowRight");
    await at(2, next);
  }

  // The end of the book: ArrowRight stays, so ArrowLeft goes back exactly one page.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await (last.pages > 1 ? at(2, last.pages - 1) : at(1, first.pages));
});

test("EPUB pane layouts reflow the book in place and keep the page's first text on screen", async ({
  page,
  lumo,
}) => {
  const document = await uploadEpub(lumo.api, "long.epub", { long: true });
  const requests = await fakeModel(page, document.id);
  await openBook(page, lumo.url, "long.epub");
  await openContentsEntry(page, "Part A");
  await expect.poll(async () => (await readPosition(page)).page).toBeGreaterThan(1);
  const before = await readPosition(page);
  // The saved translation marks this page's exact text range: it is found again only once the book shows that range.
  await page.getByRole("button", { name: "Translate this page" }).click();
  await expect(page.locator(".page-status")).toHaveText(/Saved/, SAVED);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.xhtml).toContain("Part A");
  const layout = page.getByRole("group", { name: "Pane layout" });
  const choose = (name: string) => layout.getByRole("button", { name, exact: true }).click();

  // The 40% preset is a narrower column than half the window: the section needs more pages; the 60% one needs fewer.
  await choose("Right wider");
  await expect.poll(async () => (await readPosition(page)).pages).toBeGreaterThan(before.pages);
  const narrow = (await readPosition(page)).pages;
  await choose("Left wider");
  await expect.poll(async () => (await readPosition(page)).pages).toBeLessThan(narrow);
  for (const name of ["Left only", "Right only", "Equal split"]) await choose(name);

  // Back at the first layout the book is back on the same page of the same section, still starting at its heading.
  await expect.poll(() => readPosition(page)).toEqual(before);
  await expect(page.locator(".page-status")).toHaveText(/Saved/, SAVED);
  expect(requests).toHaveLength(1);
});
