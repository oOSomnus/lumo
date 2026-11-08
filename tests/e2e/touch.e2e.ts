import type { Locator, Page } from "@playwright/test";
import { expect, openApp, openFromLibrary, openTranslatedPage, test, uploadPdf } from "./fixtures";

const FINGERTIP = 44;
// Layout rounds a 44px box to a fraction of a pixel.
const SLACK = 0.5;

/** Visible controls among `controls` smaller than a fingertip; icon-only buttons need both sides, text fields their height. */
function undersized(controls: Locator, bothSides: boolean): Promise<string[]> {
  return controls.evaluateAll(
    (elements, [minimum, both]) =>
      elements.flatMap((element) => {
        const { width, height } = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || width === 0 || height === 0) return [];
        const small = height < minimum || (both && width < minimum);
        return small ? [`${element.id || element.className || element.localName}: ${width}x${height}`] : [];
      }),
    [FINGERTIP - SLACK, bothSides] as const,
  );
}

/** How far an element's content reaches past its own box sideways. */
function sideways(element: Locator): Promise<number> {
  return element.evaluate((node) => node.scrollWidth - node.clientWidth);
}

function pageSideways(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

/** The box must lie inside the frame, whatever the toolbar around it clips. */
async function expectInside(inner: Locator, frame: Locator, what: string): Promise<void> {
  const box = (await inner.boundingBox())!;
  const bounds = (await frame.boundingBox())!;
  expect(box.x, `${what} left`).toBeGreaterThanOrEqual(bounds.x - SLACK);
  expect(box.y, `${what} top`).toBeGreaterThanOrEqual(bounds.y - SLACK);
  expect(box.x + box.width, `${what} right`).toBeLessThanOrEqual(bounds.x + bounds.width + SLACK);
  expect(box.y + box.height, `${what} bottom`).toBeLessThanOrEqual(bounds.y + bounds.height + SLACK);
}

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  for (const uiLocale of ["en", "zh-CN"] as const) {
    test(`controls reach a fingertip and no pane scrolls sideways, in ${uiLocale}`, async ({ page, lumo }) => {
      const saved = await lumo.api.patch("/api/settings", { data: { uiLocale } });
      expect(saved.ok()).toBe(true);
      await uploadPdf(lumo.api, "touch.pdf", 3, "touch");
      await openApp(page, lumo.url);
      await openFromLibrary(page, "touch.pdf");
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
      const viewer = page.frameLocator("iframe.pdf-frame");
      await expect(viewer.locator("#pageNumber")).toHaveAttribute("max", "3");
      const [original, translation, batch] = await page.locator(".mobile-tabs button").all();

      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });

        // The original: the PDF toolbar, with its icon buttons, page box and the tools menu.
        await original!.tap();
        await expect(viewer.locator("#lumo-pdf-tools > summary")).toBeVisible();
        expect(await undersized(viewer.locator("#toolbarViewer :is(button, summary)"), true), `PDF buttons at ${width}px`).toEqual([]);
        expect(await undersized(viewer.locator("#toolbarViewer :is(input, select)"), false), `PDF fields at ${width}px`).toEqual([]);
        expect(await sideways(viewer.locator("#toolbarContainer")), `PDF toolbar at ${width}px`).toBeLessThanOrEqual(1);

        // The translation and the batch panel.
        await translation!.tap();
        expect(await undersized(page.locator(".page-toolbar :is(button, select)"), false), `page toolbar at ${width}px`).toEqual([]);
        expect(await sideways(page.locator(".page-body")), `page body at ${width}px`).toBeLessThanOrEqual(1);
        await batch!.tap();
        const panel = page.locator(".batch-panel");
        await expect(panel).toBeVisible();
        expect(
          await undersized(panel.locator(":is(button, select, input:not([type=checkbox], [type=radio]), .page-checkbox, .radio-row, summary)"), false),
          `batch panel at ${width}px`,
        ).toEqual([]);
        expect(await sideways(panel), `batch panel at ${width}px`).toBeLessThanOrEqual(1);

        // The settings, with the custom provider's fields shown.
        await page.getByRole("button", { name: /^(?:Settings|设置)$/ }).tap();
        const settings = page.getByRole("dialog");
        await expect(settings).toBeVisible();
        await settings.locator("select").first().selectOption("custom");
        await expect(settings.locator("details.settings-advanced")).toBeVisible();
        expect(
          await undersized(settings.locator(":is(button, select, textarea, summary, input:not([type=checkbox], [type=radio]))"), false),
          `settings at ${width}px`,
        ).toEqual([]);
        expect(await sideways(settings.locator(".dialog-card")), `settings at ${width}px`).toBeLessThanOrEqual(1);
        expect(await pageSideways(page), `page at ${width}px`).toBeLessThanOrEqual(1);
        await settings.locator(".dialog-heading button").tap();
        await expect(settings).toBeHidden();
      }
    });
  }

  test("the reading tools menu opens search, zoom and every annotation tool inside the viewer, and gives the toolbar back when wide", async ({
    page,
    lumo,
  }) => {
    await uploadPdf(lumo.api, "tools.pdf", 3, "tools");
    await openApp(page, lumo.url);
    await openFromLibrary(page, "tools.pdf");
    const viewer = page.frameLocator("iframe.pdf-frame");
    await expect(viewer.locator("#pageNumber")).toHaveAttribute("max", "3");
    const frame = page.locator("iframe.pdf-frame");
    const toggle = viewer.locator("#lumo-pdf-tools > summary");
    const toolButtons = viewer.locator("#editorModeButtons button");

    /** Which tool buttons are available: disabled and hidden ones must stay that way wherever the buttons sit. */
    const states = () =>
      toolButtons.evaluateAll((buttons) =>
        buttons.map((button) => [button.id, button.hasAttribute("disabled"), button.closest("[hidden]") !== null]),
      );

    await page.locator(".mobile-tabs button").first().tap();
    const narrowStates = await states();
    expect(narrowStates.length).toBeGreaterThan(0);

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(toggle).toBeVisible();
      await toggle.tap();
      const panel = viewer.locator(".lumo-pdf-tools-panel");
      await expect(panel).toBeVisible();
      await expectInside(panel, frame, `tools menu at ${width}px`);
      expect(await states()).toEqual(narrowStates);

      // Each annotation tool opens its own parameter popup, which stays inside the viewer.
      for (const [button, popup, parameter, value] of [
        ["#editorHighlightButton", "#editorHighlightParamsToolbar", "#editorFreeHighlightThickness", "16"],
        ["#editorFreeTextButton", "#editorFreeTextParamsToolbar", "#editorFreeTextFontSize", "24"],
        ["#editorInkButton", "#editorInkParamsToolbar", "#editorInkThickness", "6"],
      ] as const) {
        await viewer.locator(button).tap();
        await expect(viewer.locator(popup)).toBeVisible();
        await expectInside(viewer.locator(popup), frame, `${button} popup at ${width}px`);
        await viewer.locator(parameter).fill(value);
        await expect(viewer.locator(parameter)).toHaveValue(value);
        await viewer.locator(button).tap();
      }
      await viewer.locator("#editorStampButton").tap();
      await expect(viewer.locator("#editorStampParamsToolbar")).toBeVisible();
      await expectInside(viewer.locator("#editorStampParamsToolbar"), frame, `image popup at ${width}px`);
      await expect(viewer.locator("#editorStampAddImage")).toBeEnabled();
      await viewer.locator("#editorStampButton").tap();

      // Search and zoom: in the menu on the narrowest screens, in the toolbar otherwise.
      if (width <= 360) await expect(panel.locator("#viewFindButton")).toBeVisible();
      const find = viewer.locator("#viewFindButton");
      await find.tap();
      await expect(viewer.locator("#findbar")).toBeVisible();
      await expectInside(viewer.locator("#findbar"), frame, `find bar at ${width}px`);
      await viewer.locator("#findInput").fill("touch");
      await find.tap();
      await expect(viewer.locator("#findbar")).toBeHidden();
      const zoom = viewer.locator("#scaleSelect option:checked");
      const before = await zoom.textContent();
      await viewer.locator("#zoomInButton").tap();
      await expect.poll(() => zoom.textContent()).not.toBe(before);

      // Escape closes the menu and hands the focus back to its button.
      if (!(await panel.isVisible())) await toggle.tap();
      await expect(panel).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
      await expect(toggle).toBeFocused();
    }

    // Wide again: the menu is gone and the buttons are back where PDF.js put them.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(viewer.locator("#lumo-pdf-tools")).toBeHidden();
    await expect(viewer.locator("#toolbarViewerRight > #editorModeButtons")).toHaveCount(1);
    await expect(viewer.locator("#toolbarViewerMiddle")).toBeVisible();
    expect(await states()).toEqual(narrowStates);
  });
});

test("a pane a fifth of the window wide keeps its tools in reach, in the original and in the translation", async ({
  page,
  lumo,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await uploadPdf(lumo.api, "fifth.pdf", 3, "fifth");
  await openTranslatedPage(page, lumo.url, "fifth.pdf");
  const viewer = page.frameLocator("iframe.pdf-frame");
  const frame = page.locator("iframe.pdf-frame");
  const splitter = page.locator(".splitter");
  await expect(viewer.locator("#pageNumber")).toHaveAttribute("max", "3");

  // The original at 20%, the splitter's left end (no preset is that narrow): the page box and the tools menu are on screen and usable.
  await splitter.press("Home");
  const width = (await frame.boundingBox())!.width;
  expect(width).toBeLessThan(260);
  await expect(viewer.locator("#lumo-pdf-tools > summary")).toBeVisible();
  await expectInside(viewer.locator("#pageNumber"), frame, "page box at 20%");
  await expectInside(viewer.locator("#lumo-pdf-tools > summary"), frame, "tools button at 20%");
  expect(await sideways(viewer.locator("#toolbarContainer"))).toBeLessThanOrEqual(1);
  await viewer.locator("#pageNumber").fill("2");
  await viewer.locator("#pageNumber").press("Enter");
  await expect(page.locator(".page-position strong")).toHaveText("Page 2 / 3");

  // The translation at 20%, the splitter's right end: the toolbar wraps instead of reaching past the pane.
  await splitter.press("End");
  const pane = page.locator(".side-pane");
  expect((await pane.boundingBox())!.width).toBeLessThan(260);
  const translate = page.getByRole("button", { name: "Translate this page" });
  await expect(translate).toBeVisible();
  for (const control of [translate, page.getByRole("combobox", { name: /^Target language/ }), page.getByRole("tab", { name: "Batch translation" })]) {
    await expectInside(control, pane, "translation control at 20%");
  }
  expect(await sideways(pane)).toBeLessThanOrEqual(1);
  expect(await sideways(page.locator(".page-body"))).toBeLessThanOrEqual(1);
  await page.getByRole("tab", { name: "Batch translation" }).click();
  expect(await sideways(page.locator(".batch-panel"))).toBeLessThanOrEqual(1);
  expect(await pageSideways(page)).toBeLessThanOrEqual(1);
});
