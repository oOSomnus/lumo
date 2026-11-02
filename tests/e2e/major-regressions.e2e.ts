import { createHash } from "node:crypto";
import type { Page, Response } from "@playwright/test";
import {
  expect,
  noteField,
  openApp,
  openFromLibrary,
  saveCopyButton,
  fixturePdf,
  test,
  uploadPdf,
} from "./fixtures";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("R1 stale save failure releases the save controls", async ({ page, lumo }) => {
  await uploadPdf(lumo.api, "first.pdf", 2, "first");
  await uploadPdf(lumo.api, "second.pdf", 2, "second");

  await openApp(page, lumo.url);
  await openFromLibrary(page, "first.pdf");
  await expect(noteField(page)).toHaveValue("first");
  await noteField(page).fill("first edit");
  await expect(saveCopyButton(page)).toBeEnabled();

  const intercept = Promise.withResolvers<void>();
  const captured = Promise.withResolvers<void>();
  const failureGate = Promise.withResolvers<void>();
  const uploadRoute = /\/api\/documents\?/;
  await page.route(uploadRoute, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    captured.resolve();
    await failureGate.promise;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "STORAGE_ERROR", message: "injected" },
      }),
    });
    intercept.resolve();
  });

  await saveCopyButton(page).click();
  await captured.promise;

  await openFromLibrary(page, "second.pdf");
  const dialog = page.getByRole("dialog", { name: "Switch documents?" });
  await dialog.getByRole("button", { name: "Switch anyway" }).click();
  await expect(noteField(page)).toHaveValue("second");
  await noteField(page).fill("second edit");

  failureGate.resolve();
  await intercept.promise;
  await page.unroute(uploadRoute);

  await expect(saveCopyButton(page)).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Discard changes", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".app-banner.error")).toHaveCount(0);
  await expect(page.locator(".file-name")).toHaveText("second.pdf");

  await saveCopyButton(page).click();
  await expect(page.locator(".file-name")).toHaveText("second (edited copy).pdf");
  await expect(noteField(page)).toHaveValue("second edit");

  await noteField(page).fill("third edit");
  const retryIntercept = Promise.withResolvers<void>();
  const retryCaptured = Promise.withResolvers<void>();
  const retryGate = Promise.withResolvers<void>();
  await page.route(uploadRoute, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    retryCaptured.resolve();
    await retryGate.promise;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "STORAGE_ERROR", message: "injected" },
      }),
    });
    retryIntercept.resolve();
  });
  await saveCopyButton(page).click();
  await retryCaptured.promise;
  retryGate.resolve();
  await retryIntercept.promise;
  await page.unroute(uploadRoute);

  await expect(page.locator(".app-banner.error")).toBeVisible();
  await expect(saveCopyButton(page)).toBeEnabled();
  await expect(noteField(page)).toHaveValue("third edit");
});

test("R2 language reload unblocks after saving a copy", async ({ page, lumo }) => {
  await uploadPdf(lumo.api, "single.pdf", 2, "single");
  await openApp(page, lumo.url);
  await openFromLibrary(page, "single.pdf");
  await expect(noteField(page)).toHaveValue("single");

  await noteField(page).fill("r2-edit");
  await saveCopyButton(page).click();
  await expect(page.locator(".file-name")).toHaveText("single (edited copy).pdf");

  const viewer = page.frameLocator("iframe.pdf-frame");
  await expect(viewer.locator('input[name="note"]')).toHaveValue("r2-edit");
  await expect(page.getByRole("button", { name: "Translate this page" })).toBeEnabled();

  await viewer.locator("#pageNumber").fill("2");
  await viewer.locator("#pageNumber").press("Enter");
  await expect(viewer.locator("#pageNumber")).toHaveValue("2");
  // 125% equals the viewer's auto scale in this pane, so a distinct zoom proves restoration.
  await viewer.locator("#scaleSelect").selectOption("1.5");
  await expect(viewer.locator("#scaleSelect")).toHaveValue("1.5");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("combobox", { name: /^Interface language/ }).selectOption("zh-CN");
  const apply = settings.getByRole("button", { name: "Save language and reload" });
  await expect(apply).toBeEnabled();
  await apply.click();

  await expect(page.getByRole("button", { name: "书库", exact: true })).toBeVisible();
  const reloaded = page.frameLocator("iframe.pdf-frame");
  await expect(reloaded.locator("#pageNumber")).toHaveValue("2");
  await expect(reloaded.locator("#scaleSelect")).toHaveValue("1.5");
  await reloaded.locator("#pageNumber").fill("1");
  await reloaded.locator("#pageNumber").press("Enter");
  await expect(reloaded.locator('input[name="note"]')).toHaveValue("r2-edit");

  await noteField(page).fill("r2-late");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const blockedSettings = page.getByRole("dialog", { name: "设置" });
  await blockedSettings
    .getByRole("combobox", { name: /^界面语言/ })
    .selectOption("en");
  await expect(
    blockedSettings.getByRole("button", { name: "保存语言并重新加载" }),
  ).toBeDisabled();
  await blockedSettings.getByRole("button", { name: "关闭", exact: true }).click();

  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  const discard = page.getByRole("dialog", { name: "放弃修改？" });
  await discard.getByRole("button", { name: "放弃修改" }).click();
  await expect(noteField(page)).toHaveValue("r2-edit");

  await page.getByRole("button", { name: "设置", exact: true }).click();
  const unblockedSettings = page.getByRole("dialog", { name: "设置" });
  await expect(
    unblockedSettings.getByRole("button", { name: "保存语言并重新加载" }),
  ).toBeEnabled();
});

test("R2 completed preview import unblocks the language reload", async ({ page, lumo }) => {
  await openApp(page, lumo.url);
  await page.locator('input[type="file"]').setInputFiles({
    name: "imported.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(fixturePdf("imported")),
  });
  await expect(page.locator(".file-name")).toHaveText("imported.pdf");
  await expect(noteField(page)).toHaveValue("imported");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings
    .getByRole("combobox", { name: /^Interface language/ })
    .selectOption("zh-CN");
  await expect(
    settings.getByRole("button", { name: "Save language and reload" }),
  ).toBeEnabled();
});

type SaveGate = {
  ready: boolean;
  release: (() => void) | null;
  restore: () => void;
};

async function installSaveGate(page: Page, mode: "hold" | "reject"): Promise<void> {
  await page.evaluate((gateMode) => {
    const frame = document.querySelector("iframe.pdf-frame") as HTMLIFrameElement;
    const app = (frame.contentWindow as any).PDFViewerApplication;
    const handler = app.pdfDocument._transport.messageHandler;
    const original = handler.sendWithPromise;
    const gate: SaveGate & { reject?: () => void } = {
      ready: false,
      release: null,
      restore: () => {
        handler.sendWithPromise = original;
      },
    };
    (window as any).__lumoSaveGate = gate;
    handler.sendWithPromise = function (
      action: string,
      data: unknown,
      transfers?: unknown,
    ) {
      if (action !== "SaveDocument") {
        return original.call(this, action, data, transfers);
      }
      if (gateMode === "reject") {
        return new Promise((_, reject) => {
          gate.ready = true;
          gate.release = () => {
            gate.restore();
            reject(new Error("injected save failure"));
          };
        });
      }
      const sent = original.call(this, action, data, transfers);
      return sent.then(
        (bytes: unknown) =>
          new Promise((resolve) => {
            gate.ready = true;
            gate.release = () => {
              gate.restore();
              resolve(bytes);
            };
          }),
      );
    };
  }, mode);
}

async function waitForSaveGate(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as any).__lumoSaveGate?.ready));
}

async function releaseSaveGate(page: Page): Promise<void> {
  await page.evaluate(() => {
    const gate = (window as any).__lumoSaveGate as SaveGate;
    gate.release?.();
  });
}

const copyUploadPattern = /\/api\/documents\?/;

test("R3 late edits during save are not overwritten by the copy", async ({ page, context, lumo }) => {
  const first = await uploadPdf(lumo.api, "first.pdf", 2, "first");
  const originalHash = sha256(
    Buffer.from(await (await lumo.api.get(`/api/documents/${first.id}/file`)).body()),
  );

  await openApp(page, lumo.url);
  await openFromLibrary(page, "first.pdf");
  await expect(noteField(page)).toHaveValue("first");
  await noteField(page).fill("first-edit");

  await installSaveGate(page, "hold");
  const upload = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      copyUploadPattern.test(response.url()) &&
      response.status() === 200,
  );
  await saveCopyButton(page).click();
  await waitForSaveGate(page);

  await noteField(page).fill("late-edit");
  await releaseSaveGate(page);
  await upload;

  await expect(page.locator(".app-banner.error")).toBeVisible();
  await expect(noteField(page)).toHaveValue("late-edit");
  await expect(page.locator(".file-name")).toHaveText("first.pdf");
  await expect(saveCopyButton(page)).toBeEnabled();

  const library = (await (await lumo.api.get("/api/library")).json()) as {
    documents: { id: string; name: string }[];
  };
  const stored = library.documents.find((entry) => entry.name === "first (edited copy).pdf");
  expect(stored, "the stored copy should be in the library").toBeTruthy();

  const other = await context.newPage();
  await openApp(other, lumo.url);
  await openFromLibrary(other, "first (edited copy).pdf");
  await expect(noteField(other)).toHaveValue("first-edit");
  await other.close();

  const secondUpload = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      copyUploadPattern.test(response.url()) &&
      response.status() === 200,
  );
  await saveCopyButton(page).click();
  await secondUpload;
  await expect(page.locator(".file-name")).toHaveText("first (edited copy).pdf");
  await expect(noteField(page)).toHaveValue("late-edit");
  await expect(page.locator(".app-banner.error")).toHaveCount(0);

  expect(
    sha256(Buffer.from(await (await lumo.api.get(`/api/documents/${first.id}/file`)).body())),
  ).toBe(originalHash);
});

test("R3 rejected save keeps edits and does not touch the next document", async ({ page, lumo }) => {
  await uploadPdf(lumo.api, "alpha.pdf", 2, "alpha");
  await uploadPdf(lumo.api, "beta.pdf", 2, "beta");

  await openApp(page, lumo.url);
  await openFromLibrary(page, "alpha.pdf");
  await expect(noteField(page)).toHaveValue("alpha");
  await noteField(page).fill("alpha edit");

  await installSaveGate(page, "reject");
  await saveCopyButton(page).click();
  await waitForSaveGate(page);
  await releaseSaveGate(page);

  await expect(page.locator(".app-banner.error")).toBeVisible();
  await expect(noteField(page)).toHaveValue("alpha edit");
  await expect(saveCopyButton(page)).toBeEnabled();

  await installSaveGate(page, "hold");
  const upload = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      copyUploadPattern.test(response.url()) &&
      response.status() === 200,
  );
  await saveCopyButton(page).click();
  await waitForSaveGate(page);

  await openFromLibrary(page, "beta.pdf");
  const dialog = page.getByRole("dialog", { name: "Switch documents?" });
  await dialog.getByRole("button", { name: "Switch anyway" }).click();
  await expect(noteField(page)).toHaveValue("beta");

  await releaseSaveGate(page);
  await upload;

  await expect(noteField(page)).toHaveValue("beta");
  await expect(page.locator(".app-banner.error")).toHaveCount(0);
  await expect(saveCopyButton(page)).toHaveCount(0);
});

async function installBitmapCloseProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const frame = document.querySelector("iframe.pdf-frame") as HTMLIFrameElement;
    const win = frame.contentWindow as any;
    const proto = win.ImageBitmap.prototype;
    const original = proto.close;
    const closed: unknown[] = [];
    (window as any).__lumoClosedBitmaps = closed;
    (window as any).__lumoRestoreBitmapClose = () => {
      proto.close = original;
    };
    proto.close = function (this: ImageBitmap) {
      closed.push(this);
      return original.call(this);
    };
  });
}

async function closedBitmapCount(page: Page): Promise<number> {
  return page.evaluate(() => ((window as any).__lumoClosedBitmaps as unknown[]).length);
}

async function restoreBitmapClose(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).__lumoRestoreBitmapClose?.();
  });
}

async function addStampImage(page: Page): Promise<void> {
  const viewer = page.frameLocator("iframe.pdf-frame");
  const chooserPromise = page.waitForEvent("filechooser");
  await viewer.locator("#editorStampButton").click();
  await viewer.locator("#editorStampAddImage").click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: "stamp.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ),
  });
  await expect(viewer.locator(".stampEditor")).toHaveCount(1);
}

test("R3 fingerprint reads only close their own image copies", async ({ page, context, lumo }) => {
  await uploadPdf(lumo.api, "stamp.pdf", 2, "stamp");
  await openApp(page, lumo.url);
  await openFromLibrary(page, "stamp.pdf");
  await expect(noteField(page)).toHaveValue("stamp");
  await addStampImage(page);
  await installBitmapCloseProbe(page);
  try {
    await noteField(page).fill("stamp-edit");
    await installSaveGate(page, "hold");
    const firstUpload = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        copyUploadPattern.test(response.url()) &&
        response.status() === 200,
    );
    await saveCopyButton(page).click();
    await waitForSaveGate(page);
    await noteField(page).fill("stamp-late");
    await releaseSaveGate(page);
    await firstUpload;

    await expect(page.locator(".app-banner.error")).toBeVisible();
    expect(await closedBitmapCount(page)).toBe(2);
    await expect(page.frameLocator("iframe.pdf-frame").locator(".stampEditor")).toHaveCount(1);

    const secondUpload = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        copyUploadPattern.test(response.url()) &&
        response.status() === 200,
    );
    await saveCopyButton(page).click();
    await secondUpload;
    await expect(page.locator(".file-name")).toHaveText("stamp (edited copy).pdf");
    expect(await closedBitmapCount(page)).toBe(4);
  } finally {
    await restoreBitmapClose(page);
  }

  const library = (await (await lumo.api.get("/api/library")).json()) as {
    documents: { id: string; name: string }[];
  };
  const copy = library.documents.find((entry) => entry.name === "stamp (edited copy).pdf");
  expect(copy, "the stored copy should be in the library").toBeTruthy();
  const copyBytes = Buffer.from(
    await (await lumo.api.get(`/api/documents/${copy!.id}/file`)).body(),
  );
  expect(copyBytes.includes("/Stamp")).toBe(true);

  const other = await context.newPage();
  await openApp(other, lumo.url);
  await openFromLibrary(other, "stamp (edited copy).pdf");
  await expect(
    other.frameLocator("iframe.pdf-frame").locator(".stampAnnotation").first(),
  ).toBeVisible();
  await other.close();
});

function translationPath(documentId: string, page: number, language: string): string {
  return `/api/documents/${documentId}/translations/${page}/${language}`;
}

function waitForTranslationRead(
  page: Page,
  path: string,
): Promise<Response> {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === path,
  );
}

test("R4 a manual retry resumes a paused queue and reads the cache", async ({ page, lumo }) => {
  const document = await uploadPdf(lumo.api, "retry.pdf", 2, "retry");
  await openApp(page, lumo.url);
  await openFromLibrary(page, "retry.pdf");
  await expect(noteField(page)).toHaveValue("retry");

  const path = translationPath(document.id, 1, "en");
  const initialRead = waitForTranslationRead(page, path);
  await page
    .getByRole("combobox", { name: /^Target language/ })
    .selectOption("en");
  const first = await initialRead;
  expect(await first.json()).toBeNull();

  const errorRead = waitForTranslationRead(page, path);
  const translateResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/translate",
  );
  const translateButton = page.getByRole("button", { name: "Translate this page" });
  await translateButton.click();
  const failed = await translateResponse;
  expect(failed.status()).toBe(503);
  expect(((await failed.json()) as { error: { code: string } }).error.code).toBe(
    "AI_NOT_CONFIGURED",
  );
  expect(await (await errorRead).json()).toBeNull();

  const seeded = await lumo.api.put(path, {
    data: { markdown: "# cached recovery", provider: "custom", model: "smoke" },
  });
  expect(seeded.ok()).toBe(true);

  await expect(translateButton).toHaveText("Translate this page");
  await translateButton.click();

  await expect(page.locator(".page-status")).toHaveText(/Saved/);
  await expect(page.getByRole("heading", { name: "cached recovery" })).toBeVisible();
});

test("R5 changing the batch language keeps the selection", async ({ page, lumo }) => {
  const document = await uploadPdf(lumo.api, "batch.pdf", 102, "batch");
  await openApp(page, lumo.url);
  await openFromLibrary(page, "batch.pdf");
  await expect(noteField(page)).toHaveValue("batch");

  await page.getByRole("tab", { name: "Batch translation" }).click();
  const panel = page.locator(".batch-panel");
  await expect(panel).toBeVisible();
  await page.locator("#batch-expression").fill("1,102");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByRole("button", { name: "Next group" }).click();

  const page102 = panel.getByRole("checkbox", { name: "102", exact: true });
  await expect(page102).toBeChecked();
  const retranslate = panel.getByRole("checkbox", {
    name: /Regenerate saved pages/,
  });
  await retranslate.check();

  const read = waitForTranslationRead(page, translationPath(document.id, 1, "en"));
  await panel
    .getByRole("combobox", { name: /^Target language/ })
    .selectOption("en");

  await expect(
    page.getByRole("tab", { name: "Batch translation" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#batch-expression")).toHaveValue("1,102");
  await expect(page102).toBeChecked();
  await expect(
    panel.getByRole("checkbox", { name: "101", exact: true }),
  ).not.toBeChecked();
  await expect(retranslate).toBeChecked();
  await expect(page.getByRole("button", { name: "Previous group" })).toBeEnabled();

  await page.getByRole("button", { name: "Previous group" }).click();
  await expect(
    panel.getByRole("checkbox", { name: "1", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("button", { name: /^Start translation/ }),
  ).toBeEnabled();
  expect(await (await read).json()).toBeNull();

  await page.getByRole("tab", { name: "Current page" }).click();
  const seeded = await lumo.api.put(translationPath(document.id, 1, "en"), {
    data: { markdown: "# task cache", provider: "custom", model: "smoke" },
  });
  expect(seeded.ok()).toBe(true);
  await page.getByRole("button", { name: "Translate this page" }).click();
  await expect(page.locator(".page-status")).toHaveText(/Saved/);
  await expect(page.getByRole("heading", { name: "task cache" })).toBeVisible();

  await page.getByRole("tab", { name: "Batch translation" }).click();
  await page.getByRole("button", { name: "Page 1", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Current page" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.locator(".page-toolbar").getByRole("combobox", { name: /^Target language/ }),
  ).toHaveValue("en");
});

test("R5 narrow layout keeps the batch panel on a language change", async ({ page, lumo }) => {
  await uploadPdf(lumo.api, "batch.pdf", 102, "batch");
  await openApp(page, lumo.url);
  await openFromLibrary(page, "batch.pdf");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: "Batch", exact: true }).click();
  const panel = page.locator(".batch-panel");
  await expect(panel).toBeVisible();

  await panel
    .getByRole("combobox", { name: /^Target language/ })
    .selectOption("en");
  await expect(page.getByRole("tab", { name: "Batch", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(panel).toBeVisible();
  await expect(page.locator("#batch-expression")).toBeVisible();
});

test("R6 clearing the provider keeps the provider options", async ({ page, lumo }) => {
  const catalogResponse = await lumo.api.get("/api/ai/catalog?provider=openai");
  expect(catalogResponse.ok()).toBe(true);
  const openAiCatalog = await catalogResponse.json();

  await openApp(page, lumo.url);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  const provider = settings.getByRole("combobox", { name: /^Provider/ });
  await expect(provider.locator('option[value="openai"]')).toBeAttached();
  const initialOptions = await provider
    .locator("option")
    .evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value),
    );
  expect(initialOptions).toEqual(expect.arrayContaining(["", "openai", "custom"]));

  await provider.selectOption("openai");
  const model = settings.getByRole("combobox", { name: /^Vision model/ });
  await expect(model).toBeEnabled();

  await provider.selectOption("");
  await expect(provider.locator('option[value="openai"]')).toBeAttached();
  await expect(provider.locator('option[value="custom"]')).toBeAttached();
  await expect(provider).toHaveValue("");
  await expect(model).toBeDisabled();
  await expect(
    settings.getByRole("button", { name: "Save AI settings" }),
  ).toBeDisabled();

  await provider.selectOption("openai");
  await expect(model).toBeEnabled();

  const routePattern = /\/api\/ai\/catalog\?provider=openai$/;
  const captured = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const served = Promise.withResolvers<void>();
  await page.route(routePattern, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    captured.resolve();
    await release.promise;
    await route
      .fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(openAiCatalog),
      })
      .catch(() => {});
    served.resolve();
  });

  const customCatalog = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().endsWith("/api/ai/catalog?provider=custom"),
  );
  await provider.selectOption("custom");
  await customCatalog;
  await provider.selectOption("openai");
  await captured.promise;
  await provider.selectOption("");
  release.resolve();
  await served.promise;
  await page.unroute(routePattern);

  await expect(provider.locator('option[value="openai"]')).toBeAttached();
  await expect(settings.getByRole("alert")).toHaveCount(0);
  await expect(provider).toHaveValue("");
  await expect(
    settings.getByRole("button", { name: "Save AI settings" }),
  ).toBeDisabled();

  await page.route(routePattern, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "HTTP_ERROR", message: "injected" } }),
    });
  });
  await provider.selectOption("openai");
  await expect(settings.getByRole("alert")).toBeVisible();
  await provider.selectOption("");
  await expect(settings.getByRole("alert")).toHaveCount(0);
  await expect(provider.locator('option[value="openai"]')).toBeAttached();
  await page.unroute(routePattern);
});

test("R3 native viewer download keeps the app edits unsaved", async ({ page, lumo }) => {
  await uploadPdf(lumo.api, "download.pdf", 2, "download");
  await openApp(page, lumo.url);
  await openFromLibrary(page, "download.pdf");
  await expect(noteField(page)).toHaveValue("download");
  await noteField(page).fill("download edit");

  await page.evaluate(() => {
    const frame = document.querySelector("iframe.pdf-frame") as HTMLIFrameElement;
    const app = (frame.contentWindow as any).PDFViewerApplication;
    const original = app.pdfDocument.saveDocument.bind(app.pdfDocument);
    (window as any).__lumoNativeSaveDone = false;
    (window as any).__lumoRestoreNativeSave = () => {
      app.pdfDocument.saveDocument = original;
    };
    app.pdfDocument.saveDocument = () =>
      original().finally(() => {
        (window as any).__lumoNativeSaveDone = true;
      });
    void app.downloadOrSave();
  });
  try {
    await page.waitForFunction(() => (window as any).__lumoNativeSaveDone === true);
  } finally {
    await page.evaluate(() => {
      (window as any).__lumoRestoreNativeSave?.();
    });
  }

  await expect(saveCopyButton(page)).toBeEnabled();
  await expect(page.locator(".file-name")).toHaveText("download.pdf");
  await expect(noteField(page)).toHaveValue("download edit");
  await expect(page.locator(".app-banner.error")).toHaveCount(0);
});
