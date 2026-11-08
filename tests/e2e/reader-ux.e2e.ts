import { createServer } from "node:http";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import {
  configureCustomAi,
  expect,
  fixturePdf,
  noteField,
  openApp,
  openFromLibrary,
  openTranslatedPage,
  saveCopyButton,
  test,
  translationPath,
  uploadPdf,
} from "./fixtures";

/** Saved translations give the right pane a preview and a source on every page of the book. */
async function seedTranslations(api: APIRequestContext, documentId: string, pages: number): Promise<void> {
  for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
    const response = await api.put(translationPath(documentId, pageNumber, "en"), {
      data: { typst: `= Page ${pageNumber}`, provider: "custom", model: "smoke" },
    });
    expect(response.ok(), `seeding page ${pageNumber} failed`).toBe(true);
  }
}

function near(actual: number, expected: number, tolerance: number, what: string): void {
  expect(Math.abs(actual - expected), `${what}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance);
}

/** How many different colours the highlighted tokens of a source block use. */
function tokenColors(block: Locator): Promise<number> {
  return block
    .locator("span[style*='color']")
    .evaluateAll((spans) => new Set(spans.map((span) => span.style.color)).size);
}

/** A /api/translate answer that ends in a finished document, in the wire format of the real endpoint. */
function generatedReply(typst: string): string {
  const content = { typst, provider: "custom", model: "smoke" };
  return `${JSON.stringify({ type: "start" })}\n${JSON.stringify({ type: "generated", content })}\n`;
}

/** One model reply as OpenAI-compatible server-sent events; the first chunk goes out at once, the rest after `release()`. */
async function startModel(chunks: string[]) {
  const gate = Promise.withResolvers<void>();
  const server = createServer((request, response) => {
    request.resume();
    request.once("end", async () => {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (delta: object, finish: string | null = null): void => {
        const chunk = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: "smoke" };
        response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      };
      send({ role: "assistant", content: "" });
      send({ content: chunks[0] });
      await gate.promise;
      for (const chunk of chunks.slice(1)) send({ content: chunk });
      send({}, "stop");
      response.end("data: [DONE]\n\n");
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the model server has no TCP address");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    release: gate.resolve,
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.closeAllConnections();
      server.close(() => closed.resolve());
      return closed.promise;
    },
  };
}

// ── Layout presets ────────────────────────────────────────────────────────────────────────────

async function geometry(page: Page) {
  return page.evaluate(() => {
    const width = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().width;
    const inert = (selector: string) => document.querySelector(selector)!.hasAttribute("inert");
    return {
      total: width(".workspace-panes"),
      left: width(".pdf-pane"),
      right: width(".side-pane"),
      leftInert: inert(".pdf-pane"),
      rightInert: inert(".side-pane"),
      splitter: document.querySelector(".splitter") !== null,
    };
  });
}

/** Chooses a preset, then checks which pane is on screen and how wide: the left share is measured without the 6px splitter. */
async function expectLayout(page: Page, name: string, shape: "left" | "right" | number): Promise<void> {
  const layout = page.getByRole("group", { name: "Pane layout" });
  await layout.getByRole("button", { name, exact: true }).click();
  await expect(layout.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(layout.locator('button[aria-pressed="true"]')).toHaveCount(1);
  const pane = await geometry(page);
  if (shape === "left" || shape === "right") {
    const shown = shape === "left" ? pane.left : pane.right;
    near(shown, pane.total, 1, `${name}: the shown pane fills the workspace`);
    expect(pane.leftInert, `${name}: left pane inert`).toBe(shape === "right");
    expect(pane.rightInert, `${name}: right pane inert`).toBe(shape === "left");
    expect(pane.splitter, `${name}: no splitter`).toBe(false);
    return;
  }
  const available = pane.total - 6;
  near(pane.left, available * shape, pane.total * 0.01, `${name}: left pane`);
  near(pane.right, available * (1 - shape), pane.total * 0.01, `${name}: right pane`);
  expect(pane.leftInert || pane.rightInert, `${name}: both panes usable`).toBe(false);
  expect(pane.splitter, `${name}: splitter`).toBe(true);
}

test("The five pane layouts show the right panes at the right widths and leave the open work alone", async ({
  page,
  lumo,
}) => {
  const stored = await uploadPdf(lumo.api, "layout.pdf", 3, "layout");
  await seedTranslations(lumo.api, stored.id, 3);
  const downloads: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === `/api/documents/${stored.id}/file`) downloads.push(request.url());
  });
  await openTranslatedPage(page, lumo.url, "layout.pdf");
  const viewer = page.frameLocator("iframe.pdf-frame");
  await expect(viewer.locator("#pageNumber")).toHaveAttribute("max", "3");

  // Work in both panes: a Typst edit nobody has saved, an unsaved form edit and a 150% zoom.
  // The marker lives in the viewer's own document, so a reload of the viewer would erase it.
  await viewer.locator("#scaleSelect").selectOption("1.5");
  await page.getByRole("button", { name: "Edit source" }).click();
  // A pane that is not on screen has no accessible textbox, but its draft must still be there.
  const editor = page.getByRole("textbox", { name: "Typst source", includeHidden: true });
  await editor.fill("= Page 1 edited");
  await noteField(page).fill("kept");
  await expect(saveCopyButton(page)).toBeEnabled();
  await viewer.locator("html").evaluate((root) => {
    root.dataset.layoutMarker = "kept";
  });
  const loaded = downloads.length;
  expect(loaded).toBeGreaterThan(0);

  for (const [name, shape] of [
    ["Left only", "left"],
    ["Right only", "right"],
    ["Equal split", 0.5],
    ["Left wider", 0.6],
    ["Right wider", 0.4],
    ["Equal split", 0.5],
  ] as const) {
    await expectLayout(page, name, shape);
    await expect(viewer.locator("#scaleSelect")).toHaveValue("1.5");
    await expect(viewer.locator("html")).toHaveAttribute("data-layout-marker", "kept");
    await expect(noteField(page)).toHaveValue("kept");
    await expect(editor).toHaveValue("= Page 1 edited");
    await expect(saveCopyButton(page)).toBeEnabled();
    // The book is never fetched or opened again by a layout change.
    expect(downloads).toHaveLength(loaded);
  }

  // The splitter reaches both ends of 20–80 by dragging and by keys. Those ends are no preset, so no button is pressed there.
  const splitter = page.locator(".splitter");
  const layout = page.getByRole("group", { name: "Pane layout" });
  const width = page.viewportSize()!.width;
  for (const [x, value] of [
    [0, "20"],
    [width, "80"],
  ] as const) {
    const box = (await splitter.boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 8 });
    await page.mouse.up();
    await expect(splitter).toHaveAttribute("aria-valuenow", value);
    await expect(layout.locator('button[aria-pressed="true"]')).toHaveCount(0);
  }
  await splitter.focus();
  for (const [key, value] of [["Home", "20"], ["End", "80"], ["Enter", "50"]] as const) {
    await splitter.press(key);
    await expect(splitter).toHaveAttribute("aria-valuenow", value);
  }
  // Two 5% steps from the middle land on the 60/40 presets, and the buttons follow the keys.
  for (const [key, value, preset] of [
    ["Shift+ArrowRight", "60", "Left wider"],
    ["Shift+ArrowLeft", "40", "Right wider"],
  ] as const) {
    await splitter.press("Enter");
    await splitter.press(key);
    await splitter.press(key);
    await expect(splitter).toHaveAttribute("aria-valuenow", value);
    await expect(layout.getByRole("button", { name: preset, exact: true })).toHaveAttribute("aria-pressed", "true");
  }
  await expect(viewer.locator("html")).toHaveAttribute("data-layout-marker", "kept");
  await expect(editor).toHaveValue("= Page 1 edited");

  // A narrow window has its tabs, not the presets; wide again, the chosen preset is back.
  await layout.getByRole("button", { name: "Left wider", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".layout-switch")).toHaveCount(0);
  await expect(page.locator(".mobile-tabs")).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 960 });
  await expectLayout(page, "Left wider", 0.6);
  await expect(editor).toHaveValue("= Page 1 edited");

  // The presets stay within reach in the fullscreen workspace.
  await page.locator(".fullscreen-button").click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.tagName ?? "")).toBe("MAIN");
  await expectLayout(page, "Right only", "right");
  await expectLayout(page, "Equal split", 0.5);
  await page.evaluate(() => document.exitFullscreen());
  expect(downloads).toHaveLength(loaded);
});

test("A single pane keeps the batch tab it was showing", async ({ page, lumo }) => {
  await uploadPdf(lumo.api, "batch-layout.pdf", 4, "batch-layout");
  await openTranslatedPage(page, lumo.url, "batch-layout.pdf");
  await page.getByRole("tab", { name: "Batch translation" }).click();
  const panel = page.locator(".batch-panel");
  await expect(panel).toBeVisible();

  await expectLayout(page, "Left only", "left");
  await expect(panel).toBeHidden();
  await expectLayout(page, "Right only", "right");
  await expect(panel).toBeVisible();
  await expectLayout(page, "Equal split", 0.5);
  await expect(page.getByRole("tab", { name: "Batch translation" })).toHaveAttribute("aria-selected", "true");
  await expect(panel).toBeVisible();
});

// ── Arrow keys ────────────────────────────────────────────────────────────────────────────────

test("ArrowLeft and ArrowRight turn the page from the original, the translation, the source, the preview and the batch panel", async ({
  page,
  lumo,
}) => {
  const stored = await uploadPdf(lumo.api, "keys.pdf", 3, "keys");
  await seedTranslations(lumo.api, stored.id, 3);
  await openTranslatedPage(page, lumo.url, "keys.pdf");
  const viewer = page.frameLocator("iframe.pdf-frame");
  const current = viewer.locator("#pageNumber");
  await expect(current).toHaveAttribute("max", "3");

  /** One key press moves exactly one page: a double turn would show 3 here. */
  const turn = async (key: "ArrowLeft" | "ArrowRight", expected: string): Promise<void> => {
    await page.keyboard.press(key);
    await expect(current).toHaveValue(expected);
  };

  // The blank margin of the original.
  await viewer.locator("#viewerContainer").click({ position: { x: 3, y: 3 } });
  await turn("ArrowRight", "2");
  await turn("ArrowLeft", "1");

  // The blank of the translation pane.
  await page.locator(".page-body").click({ position: { x: 3, y: 3 } });
  await turn("ArrowRight", "2");
  await turn("ArrowLeft", "1");

  // The Typst source: a new page opens on its preview, so the source is chosen again after every turn.
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await page.locator(".typst-source").click();
  await turn("ArrowRight", "2");
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await page.locator(".typst-source").click();
  await turn("ArrowLeft", "1");

  // The preview frame, which is a document of its own: it is replaced on every page, so each press starts with a click.
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const preview = page.frameLocator(".typst-preview iframe");
  await expect(preview.locator("body > svg")).toBeVisible();
  await preview.locator("body").click();
  await turn("ArrowRight", "2");
  await expect(preview.locator("body > svg")).toBeVisible();
  await preview.locator("body").click();
  await turn("ArrowLeft", "1");

  // The blank of the batch panel.
  await page.getByRole("tab", { name: "Batch translation" }).click();
  await page.locator(".batch-panel").click({ position: { x: 3, y: 3 } });
  await turn("ArrowRight", "2");
  await turn("ArrowLeft", "1");
  await page.getByRole("tab", { name: "Current page" }).click();

  // Zoomed to 200% the page scrolls sideways, and the key still turns the page once instead of scrolling or jumping twice.
  await viewer.locator("#scaleSelect").selectOption("2");
  await expect
    .poll(() => viewer.locator("#viewerContainer").evaluate((el) => el.scrollWidth > el.clientWidth))
    .toBe(true);
  await viewer.locator("#viewerContainer").click({ position: { x: 3, y: 3 } });
  await turn("ArrowRight", "2");
  await turn("ArrowRight", "3");
  await turn("ArrowLeft", "2");
});

test("The arrow keys keep their own meaning in fields, on the splitter, in dialogs and while editing an annotation", async ({
  page,
  lumo,
}) => {
  const stored = await uploadPdf(lumo.api, "guards.pdf", 3, "guards");
  await seedTranslations(lumo.api, stored.id, 3);
  await openTranslatedPage(page, lumo.url, "guards.pdf");
  const viewer = page.frameLocator("iframe.pdf-frame");
  const current = viewer.locator("#pageNumber");
  await expect(current).toHaveAttribute("max", "3");
  await current.fill("2");
  await current.press("Enter");
  await expect(page.locator(".page-position strong")).toHaveText("Page 2 / 3");

  /** Page 2 of 3: a wrong turn lands on 1 or 3. */
  const still = (): Promise<void> => expect(current).toHaveValue("2");

  // Fields of the viewer.
  await current.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowRight");
  await still();
  await viewer.locator("#scaleSelect").focus();
  await page.keyboard.press("ArrowRight");
  await still();

  // The source editor.
  await page.getByRole("button", { name: "Edit source" }).click();
  const editor = page.getByRole("textbox", { name: "Typst source" });
  await editor.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowRight");
  await still();
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(editor).toBeHidden();

  // An IME composition is not a page turn, in the app or in the viewer.
  await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>("iframe.pdf-frame")!;
    for (const target of [document.body, frame.contentDocument!.body]) {
      target.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", isComposing: true, bubbles: true, cancelable: true }),
      );
    }
  });
  await still();

  // Modifiers keep their browser meaning.
  await viewer.locator("#viewerContainer").click({ position: { x: 3, y: 3 } });
  for (const key of ["Shift+ArrowRight", "Control+ArrowRight", "Alt+ArrowLeft", "Meta+ArrowRight"]) {
    await page.keyboard.press(key);
  }
  await still();

  // The splitter moves with the arrows; the page stays.
  const splitter = page.locator(".splitter");
  await splitter.focus();
  await page.keyboard.press("ArrowRight");
  await expect(splitter).toHaveAttribute("aria-valuenow", "51");
  await still();

  // A modal dialog owns the keyboard.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  await settings.getByRole("heading", { level: 2 }).focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await still();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await expect(settings).toBeHidden();

  // Text typed into an annotation moves its caret; the page stays.
  await viewer.locator("#editorFreeTextButton").click();
  await viewer.locator('.page[data-page-number="2"] .annotationEditorLayer').click({ position: { x: 120, y: 120 } });
  await page.keyboard.type("note");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await still();

  // The keys are not simply dead: after the fields, a plain press turns the page again.
  await page.keyboard.press("Escape");
  await viewer.locator("#editorFreeTextButton").click();
  await viewer.locator("#viewerContainer").click({ position: { x: 3, y: 3 } });
  await page.keyboard.press("ArrowRight");
  await expect(current).toHaveValue("3");
});

test("A page turns with the arrow keys before the book is in the Library, and once per press after switching books", async ({
  page,
  lumo,
}) => {
  await uploadPdf(lumo.api, "other.pdf", 3, "other");
  const gate = Promise.withResolvers<void>();
  const upload = /\/api\/documents\?/;
  await page.route(upload, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await gate.promise;
    await route.fallback();
  });
  await openApp(page, lumo.url);
  await page.locator('input[type="file"]').setInputFiles({
    name: "preview.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(fixturePdf("preview", 3)),
  });
  const viewer = page.frameLocator("iframe.pdf-frame");
  const current = viewer.locator("#pageNumber");
  await expect(current).toHaveAttribute("max", "3");
  await viewer.locator("#viewerContainer").click({ position: { x: 3, y: 3 } });
  await page.keyboard.press("ArrowRight");
  await expect(current).toHaveValue("2");
  gate.resolve();
  await expect(page.locator(".file-name")).toHaveText("preview.pdf");
  await page.unroute(upload);

  // Switching back and forth never leaves a second listener behind: one press, one page.
  for (const name of ["other.pdf", "preview.pdf", "other.pdf", "preview.pdf"]) {
    await openFromLibrary(page, name);
    await expect(page.locator(".file-name")).toHaveText(name);
    await expect(current).toHaveAttribute("max", "3");
    const before = Number(await current.inputValue());
    await viewer.locator("#viewerContainer").click({ position: { x: 3, y: 3 } });
    await page.keyboard.press(before < 3 ? "ArrowRight" : "ArrowLeft");
    await expect(current).toHaveValue(String(before < 3 ? before + 1 : before - 1));
  }
});

// ── Typst preview and highlighting ─────────────────────────────────────────────────────────────

test("The preview frame takes the arrow keys but runs no script and reaches no network", async ({ page, lumo }) => {
  const stored = await uploadPdf(lumo.api, "isolated.pdf", 3, "isolated");
  await seedTranslations(lumo.api, stored.id, 3);
  const leaked: string[] = [];
  await page.route("**/pwned/**", (route) => {
    leaked.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "image/png", body: "" });
  });
  await openTranslatedPage(page, lumo.url, "isolated.pdf");
  const frame = page.locator(".typst-preview iframe");
  const preview = page.frameLocator(".typst-preview iframe");
  const current = page.frameLocator("iframe.pdf-frame").locator("#pageNumber");
  await expect(frame).toHaveAttribute("sandbox", "allow-same-origin");
  await expect(preview.locator("body > svg")).toBeVisible();

  // The app can reach into the frame; whatever is put there cannot run, load or call out.
  const marker = await page.evaluate(async () => {
    const root = document.documentElement;
    root.dataset.marker = "app";
    const inner = document.querySelector<HTMLIFrameElement>(".typst-preview iframe")!.contentDocument!;
    const script = inner.createElement("script");
    script.textContent = 'window.parent.document.documentElement.dataset.marker = "script ran"';
    inner.body.append(script);
    inner.body.insertAdjacentHTML(
      "beforeend",
      '<img src="http://127.0.0.1:1/pwned/pixel.png" onerror="window.parent.document.documentElement.dataset.marker = \'handler ran\'">' +
        '<iframe src="http://127.0.0.1:1/pwned/frame.html"></iframe>',
    );
    const settled = Promise.withResolvers<void>();
    setTimeout(settled.resolve, 300);
    await settled.promise;
    return root.dataset.marker;
  });
  expect(marker).toBe("app");
  expect(leaked).toEqual([]);

  // Page after page, and after a recompile, one press turns one page.
  await preview.locator("body").click();
  await page.keyboard.press("ArrowRight");
  await expect(current).toHaveValue("2");
  await expect(preview.locator("body > svg")).toBeVisible();
  await preview.locator("body").click();
  await page.keyboard.press("ArrowRight");
  await expect(current).toHaveValue("3");

  await page.getByRole("button", { name: "Edit source" }).click();
  await page.getByRole("textbox", { name: "Typst source" }).fill("= Page 3 recompiled");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".page-status")).toHaveText(/Saved/, { timeout: 20_000 });
  await expect(preview.locator("body > svg")).toBeVisible();
  await preview.locator("body").click();
  await page.keyboard.press("ArrowLeft");
  await expect(current).toHaveValue("2");
  expect(leaked).toEqual([]);
});

test("The streaming source, the saved source and the repair snippets are highlighted, and nothing comes from outside", async ({
  page,
  lumo,
}) => {
  const model = await startModel(["#set text(size: 12pt)\n= Streaming heading\n", "Body with #strong[bold] text.\n"]);
  try {
    await configureCustomAi(lumo.api, model.url);
    await uploadPdf(lumo.api, "stream.pdf", 2, "stream");
    const origin = new URL(lumo.url).origin;
    const outside: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (!url.startsWith(origin) && !/^(data|blob|about):/.test(url)) outside.push(url);
    });
    await openTranslatedPage(page, lumo.url, "stream.pdf");
    await page.getByRole("button", { name: "Translate this page" }).click();

    // The first chunk is on screen, already coloured, while the model is still talking.
    const live = page.locator(".live-source .typst-source");
    await expect(live).toContainText("= Streaming heading");
    await expect(live).not.toContainText("Body with");
    await expect
      .poll(() => tokenColors(live))
      .toBeGreaterThan(1);

    model.release();
    await expect(page.locator(".page-status")).toHaveText(/Saved/, { timeout: 30_000 });
    await page.getByRole("button", { name: "Source", exact: true }).click();
    const source = page.locator(".typst-source");
    await expect(source).toContainText("Body with #strong[bold] text.");
    await expect
      .poll(() => tokenColors(source))
      .toBeGreaterThan(1);

    // The edit box stays a plain textarea.
    await page.getByRole("button", { name: "Edit source" }).click();
    await expect(page.getByRole("textbox", { name: "Typst source" })).toHaveValue(/Body with #strong\[bold\] text\./);
    expect(outside).toEqual([]);
  } finally {
    model.release();
    await model.close();
  }
});

// ── Batch summary ──────────────────────────────────────────────────────────────────────────────

test("The PDF batch summary counts selected, skipped and to-translate pages, and its actions appear only when they apply", async ({
  page,
  lumo,
}) => {
  const stored = await uploadPdf(lumo.api, "summary.pdf", 4, "summary");
  const saved = await lumo.api.put(translationPath(stored.id, 1, "en"), {
    data: { typst: "= Saved", provider: "custom", model: "smoke" },
  });
  expect(saved.ok()).toBe(true);
  const release = Promise.withResolvers<void>();
  await page.route(/\/api\/translate$/, async (route) => {
    const { pageNumber }: { pageNumber: number } = route.request().postDataJSON();
    if (pageNumber === 2) await release.promise;
    if (pageNumber === 3) {
      await route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "AI_REQUEST_FAILED", message: "injected" } }),
      });
      return;
    }
    if (pageNumber === 4) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "AI_AUTH_FAILED", message: "injected" } }),
      });
      return;
    }
    await route.fulfill({ contentType: "application/x-ndjson; charset=utf-8", body: generatedReply(`= Page ${pageNumber}`) });
  });
  await openTranslatedPage(page, lumo.url, "summary.pdf");
  const viewer = page.frameLocator("iframe.pdf-frame");
  await expect(viewer.locator("#pageNumber")).toHaveAttribute("max", "4");

  // Idle: nothing to stop and nothing to retry.
  await page.getByRole("tab", { name: "Batch translation" }).click();
  const panel = page.locator(".batch-panel");
  await expect(panel.getByRole("button", { name: "Stop all", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /^Retry failed/ })).toHaveCount(0);

  // Page 1 is saved, page 2 is being translated: of four selected pages two are left.
  await page.getByRole("tab", { name: "Current page" }).click();
  await viewer.locator("#pageNumber").fill("2");
  await viewer.locator("#pageNumber").press("Enter");
  await expect(page.locator(".page-position strong")).toHaveText("Page 2 / 4");
  await page.getByRole("button", { name: "Translate this page" }).click();
  await expect(page.getByRole("button", { name: "Cancel this page" })).toBeVisible();
  await page.getByRole("tab", { name: "Batch translation" }).click();
  await panel.locator("#batch-expression").fill("1-4");
  await panel.getByRole("button", { name: "Apply", exact: true }).click();
  const summary =
    "4 selected · 1 skipped (task or unsaved draft) · 1 skipped (already translated) · 2 to translate";
  await expect(panel).toContainText(summary);
  await expect(panel).toContainText("2 pages will be translated.");
  await expect(panel.getByRole("button", { name: "Start translation (2)", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Stop all", exact: true })).toBeVisible();

  // Neither the selection method nor the language loses the range.
  await panel.getByRole("radio", { name: "By outline" }).check();
  await panel.getByRole("radio", { name: "By page numbers" }).check();
  await expect(panel.locator("#batch-expression")).toHaveValue("1-4");
  await expect(panel).toContainText(summary);
  const language = panel.getByRole("combobox", { name: /^Target language/ });
  await language.selectOption("ja");
  await expect(panel.locator("#batch-expression")).toHaveValue("1-4");
  await expect(panel).toContainText("4 selected · 0 skipped (task or unsaved draft) · 0 skipped (already translated) · 4 to translate");
  await language.selectOption("en");
  await expect(panel).toContainText(summary);

  // A failed page and a refused credential: the matching actions show up, and settings stay one click away.
  await panel.locator("#batch-expression").fill("3-4");
  await panel.getByRole("button", { name: "Apply", exact: true }).click();
  await panel.getByRole("button", { name: /^Start translation/ }).click();
  await expect(panel.getByRole("button", { name: "Resume queue", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Open AI settings" }).first()).toBeVisible();
  await expect(panel.getByRole("button", { name: /^Retry failed/ })).toBeVisible();
  release.resolve();
  await expect(panel.locator(".task-error").first()).toBeVisible();
  await expect(panel.getByRole("button", { name: "Stop all", exact: true })).toHaveCount(0);
});

test("A draft that could not be saved is retried without the AI, and sending it back to the model asks for the setup first", async ({
  page,
  lumo,
}) => {
  const stored = await uploadPdf(lumo.api, "draft.pdf", 2, "draft");
  const path = translationPath(stored.id, 1, "en");
  const sent: string[] = [];
  await page.route(/\/api\/translate$/, async (route) => {
    sent.push(route.request().url());
    await route.fulfill({ contentType: "application/x-ndjson; charset=utf-8", body: generatedReply("= Draft page") });
  });
  let storageDown = true;
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() === "PUT" && storageDown) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "STORAGE_FAILED", message: "injected" } }),
      });
      return;
    }
    await route.fallback();
  });
  await openTranslatedPage(page, lumo.url, "draft.pdf");
  await page.getByRole("button", { name: "Translate this page" }).click();
  const retry = page.getByRole("button", { name: "Retry save", exact: true });
  await expect(retry).toBeVisible();
  expect(sent).toHaveLength(1);

  // From now on the server reports no AI at all.
  await page.route(/\/api\/ai\/settings$/, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const real = await route.fetch();
    const snapshot = await real.json();
    await route.fulfill({
      response: real,
      json: { ...snapshot, config: null, status: { configured: false, code: "AI_NOT_CONFIGURED" } },
    });
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings.getByText("AI is not set up yet. Choose a provider and a vision model.")).toBeVisible();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await expect(settings).toBeHidden();

  // Repair is a model call: it opens the setup instead of sending anything.
  await page.getByRole("button", { name: "Repair Typst", exact: true }).click();
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await expect(settings).toBeHidden();
  expect(sent).toHaveLength(1);

  // Saving the draft again is local work and needs no AI.
  storageDown = false;
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(page.locator(".page-status")).toHaveText(/Saved/, { timeout: 20_000 });
  expect(sent).toHaveLength(1);
});
