import { createHash } from "node:crypto";
import type { Page, Response } from "@playwright/test";
import {
  expect,
  downloadAllTranslations,
  noteField,
  openApp,
  openFromLibrary,
  openTranslatedPage,
  saveCopyButton,
  translationPath,
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

  await expect(page.getByRole("main", { name: "书库" })).toBeVisible();
  await openFromLibrary(page, "single (edited copy).pdf");
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
  await unblockedSettings
    .getByRole("combobox", { name: /^界面语言/ })
    .selectOption("en");
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

  // Credentials the provider no longer accepts: the server answers AI_AUTH_FAILED, which pauses the queue.
  const rejected = /\/api\/translate$/;
  await page.route(rejected, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "AI_AUTH_FAILED", message: "The provider rejected the credentials." },
      }),
    }),
  );

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
    "AI_AUTH_FAILED",
  );
  expect(await (await errorRead).json()).toBeNull();

  // The failure reads as a sentence with a way out; the code and the raw detail wait behind "Technical details".
  await expect(page.getByRole("button", { name: "Open AI settings" })).toBeVisible();
  await page.getByText("Technical details").click();
  await expect(page.locator(".error-details code")).toHaveText("AI_AUTH_FAILED");
  await page.unroute(rejected);

  const seeded = await lumo.api.put(path, {
    data: { typst: "= cached recovery", provider: "custom", model: "smoke" },
  });
  expect(seeded.ok()).toBe(true);

  await expect(translateButton).toHaveText("Translate this page");
  await translateButton.click();

  await expect(page.locator(".page-status")).toHaveText(/Saved/);
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await expect(page.locator(".typst-source")).toContainText("= cached recovery");
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
    data: { typst: "= task cache", provider: "custom", model: "smoke" },
  });
  expect(seeded.ok()).toBe(true);
  await page.getByRole("button", { name: "Translate this page" }).click();
  await expect(page.locator(".page-status")).toHaveText(/Saved/);
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await expect(page.locator(".typst-source")).toContainText("= task cache");

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

/** Counts near-black pixels of a PNG drawn on white, using a blank page so the app CSP is not involved. */
async function darkPixels(page: Page, png: Buffer): Promise<number> {
  const scratch = await page.context().newPage();
  try {
    return await scratch.evaluate(async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      let count = 0;
      for (let index = 0; index < data.length; index += 4) {
        if (data[index]! < 100 && data[index + 1]! < 100 && data[index + 2]! < 100) {
          count += 1;
        }
      }
      return count;
    }, png.toString("base64"));
  } finally {
    await scratch.close();
  }
}

/** Width the right pane offers its content: .page-body minus padding (clientWidth already excludes a scrollbar). */
function paneWidth(page: Page): Promise<number> {
  return page.locator(".page-body").evaluate((body) => {
    const style = getComputedStyle(body);
    return body.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  });
}

function expectNear(actual: number, expected: number, what: string, tolerance = 1): void {
  expect(Math.abs(actual - expected), `${what}: ${actual} vs ${expected}`).toBeLessThanOrEqual(
    tolerance,
  );
}

/** The preview, its frame and the SVG drawn in it all span the pane without distorting the page. */
async function expectPreviewFillsPane(
  page: Page,
  [pageWidth, pageHeight]: readonly [number, number],
): Promise<void> {
  // The iframe is sandboxed; Playwright still reaches its document through the frame locator.
  const svg = page.frameLocator(".typst-preview iframe").locator("body > svg");
  await expect(async () => {
    const pane = await paneWidth(page);
    const outer = await page.evaluate(() => {
      const width = (selector: string) =>
        document.querySelector(selector)!.getBoundingClientRect().width;
      const body = document.querySelector(".page-body")!;
      return {
        translation: width(".translation-body"),
        preview: width(".typst-preview"),
        frame: document.querySelector(".typst-preview iframe")!.clientWidth,
        overflow: body.scrollWidth - body.clientWidth,
      };
    });
    const drawn = await svg.evaluate(
      (element) => {
        const box = element.getBoundingClientRect();
        const [, , width, height] = (element.getAttribute("viewBox") ?? "")
          .split(/\s+/)
          .map(Number);
        return { width: box.width, height: box.height, ratio: width! / height! };
      },
      undefined,
      { timeout: 1_000 },
    );
    expectNear(outer.translation, pane, "translation body vs pane");
    expectNear(outer.preview, pane, "preview vs pane");
    expectNear(outer.frame, outer.preview - 2, "frame vs preview inside its 1px borders");
    expectNear(drawn.width, outer.frame, "SVG vs frame");
    expectNear(drawn.width / drawn.height / drawn.ratio, 1, "drawn SVG ratio vs viewBox", 0.01);
    // Pins the measurement to this page, not the previous page's frame still on screen.
    expectNear(drawn.ratio / (pageWidth / pageHeight), 1, "viewBox vs page size", 0.01);
    expect(outer.overflow, "page body scrolls horizontally").toBeLessThanOrEqual(1);
  }).toPass({ timeout: 20_000 });
}

async function expectSourceThenPreview(
  page: Page,
  pageSize: readonly [number, number],
  text: string,
): Promise<void> {
  await page.getByRole("button", { name: "Source", exact: true }).click();
  const source = page.locator(".typst-source");
  await expect(source).toContainText(text);
  // Wrapped source stays inside the pane; horizontal scrolling would hide characters.
  const overflow = (element: Element): number => element.scrollWidth - element.clientWidth;
  expect(await source.evaluate(overflow)).toBeLessThanOrEqual(1);
  expect(await page.locator(".page-body").evaluate(overflow)).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expectPreviewFillsPane(page, pageSize);
}

test("Typst preview renders glyphs and fills the translation pane", async ({ page, lumo }) => {
  const document = await uploadPdf(lumo.api, "glyphs.pdf", 2, "glyphs");
  for (const [pageNumber, width, height, text] of [
    [1, 120, 80, "Preview"],
    [2, 1400, 900, "Preview wide"],
  ] as const) {
    const seeded = await lumo.api.put(translationPath(document.id, pageNumber, "en"), {
      data: {
        typst: [
          `#set page(width: ${width}pt, height: ${height}pt, margin: 10pt)`,
          '#set text(font: "Libertinus Serif", size: 24pt)',
          text,
        ].join("\n"),
        provider: "custom",
        model: "smoke",
      },
    });
    expect(seeded.ok()).toBe(true);
  }

  await page.setViewportSize({ width: 2400, height: 1100 });
  await openTranslatedPage(page, lumo.url, "glyphs.pdf");
  const preview = page.locator(".typst-preview iframe");
  await expect(preview).toBeVisible();
  // A bordered but empty frame is visible too; only drawn glyphs make dark pixels.
  await expect
    .poll(async () => darkPixels(page, await preview.screenshot()), { timeout: 20_000 })
    .toBeGreaterThan(100);

  // Wider than the old 820px cap, so these checks can tell the cap from the pane.
  expect(await paneWidth(page)).toBeGreaterThan(820);
  // A page far smaller than the pane grows to it...
  await expectPreviewFillsPane(page, [120, 80]);
  await expectSourceThenPreview(page, [120, 80], "Preview");

  // ...and one far larger shrinks to it, at every split.
  const viewer = page.frameLocator("iframe.pdf-frame");
  await viewer.locator("#pageNumber").fill("2");
  await viewer.locator("#pageNumber").press("Enter");
  await expect(page.locator(".page-position strong")).toHaveText("Page 2 / 2");
  await expectPreviewFillsPane(page, [1400, 900]);

  const splitter = page.locator(".splitter");
  await splitter.press("End");
  await expect(splitter).toHaveAttribute("aria-valuenow", "80");
  await expectPreviewFillsPane(page, [1400, 900]);
  await splitter.press("Enter");
  await expect(splitter).toHaveAttribute("aria-valuenow", "50");
  await expectPreviewFillsPane(page, [1400, 900]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: "Translation", exact: true }).click();
  await expect(preview).toBeVisible();
  await expectPreviewFillsPane(page, [1400, 900]);
  await expectSourceThenPreview(page, [1400, 900], "Preview wide");
});

test("Typst preview sanitizer keeps local glyph references and strips active content", async ({
  page,
  lumo,
}) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="120" height="80" viewBox="0 0 120 80" onload="void 0">
<script>void 0</script>
<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">injected</div></foreignObject>
<defs><path id="glyph-0" d="M10 10H110V70H10Z" fill="#000"/></defs>
<use id="use-local" xlink:href="#glyph-0"/>
<use id="use-remote" href="https://example.com/glyphs.svg#glyph-0"/>
<use id="use-data" xlink:href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4="/>
<use id="use-script" href="javascript:void 0"/>
<a xlink:href="https://example.com/" target="_blank"><rect width="5" height="5" onclick="void 0"/></a>
</svg>`;
  // Feed the real sanitizer arbitrary SVG through the worker protocol instead of exporting a test-only hook.
  const worker = `self.postMessage({ type: "ready" });
self.onmessage = (event) => {
  if (event.data?.type === "compile") {
    self.postMessage({ type: "compiled", id: event.data.id, svg: ${JSON.stringify(svg)} });
  }
};`;
  await page.route("**/typst/worker.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: worker }),
  );
  const document = await uploadPdf(lumo.api, "sanitize.pdf", 2, "sanitize");
  const seeded = await lumo.api.put(translationPath(document.id, 1, "en"), {
    data: { typst: "= stub", provider: "custom", model: "smoke" },
  });
  expect(seeded.ok()).toBe(true);

  await openTranslatedPage(page, lumo.url, "sanitize.pdf");
  const preview = page.locator(".typst-preview iframe");
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute("sandbox", "allow-same-origin");
  await expect
    .poll(async () => darkPixels(page, await preview.screenshot()), { timeout: 20_000 })
    .toBeGreaterThan(100);

  const srcdoc = await preview.getAttribute("srcdoc");
  expect(srcdoc).toBeTruthy();
  const sanitized = await page.evaluate((markup) => {
    const parsed = new DOMParser().parseFromString(markup, "text/html");
    const elements = [...parsed.querySelectorAll("*")];
    return {
      csp: parsed
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute("content"),
      tags: elements.map((element) => element.tagName.toLowerCase()),
      attributes: elements.flatMap((element) => element.getAttributeNames()),
      references: [...parsed.querySelectorAll("use")].map((element) => [
        element.id,
        element.getAttribute("href") ?? element.getAttribute("xlink:href"),
      ]),
      anchors: [...parsed.querySelectorAll("a")].map((element) =>
        element.getAttributeNames().filter((name) => /href|target/.test(name)),
      ),
    };
  }, srcdoc!);

  expect(sanitized.csp).toContain("default-src 'none'");
  expect(sanitized.csp).toContain("script-src 'none'");
  expect(sanitized.tags).toContain("path");
  expect(sanitized.tags).not.toContain("script");
  expect(sanitized.tags).not.toContain("foreignobject");
  expect(sanitized.attributes.filter((name) => name.startsWith("on"))).toEqual([]);
  expect(sanitized.references.filter(([, target]) => target !== null)).toEqual([
    ["use-local", "#glyph-0"],
  ]);
  expect(sanitized.anchors.flat()).toEqual([]);
});

test("Typst repairs unclosed delimiters before saving", async ({ page, lumo }) => {
  const document = await uploadPdf(lumo.api, "repair.pdf", 2, "repair");
  const path = translationPath(document.id, 1, "en");
  const broken = "#set page(width:180mm,height:auto)\n#strong[应收账款（Accounts Receivable）";
  const fixed = `${broken}]`;
  const requests: { repair?: { typst: string; diagnostics: string } }[] = [];
  const saves: string[] = [];
  const releaseRepair = Promise.withResolvers<void>();

  page.on("request", (request) => {
    if (request.method() !== "PUT" || new URL(request.url()).pathname !== path) return;
    const body: { typst: string } = request.postDataJSON();
    saves.push(body.typst);
  });
  // Only the model answer is faked; page preparation, the Typst worker, PUT and SQLite stay real.
  await page.route(/\/api\/translate$/, async (route) => {
    const body: (typeof requests)[number] = route.request().postDataJSON();
    requests.push(body);
    if (body.repair) await releaseRepair.promise;
    const content = { typst: body.repair ? fixed : broken, provider: "custom", model: "smoke" };
    await route.fulfill({
      contentType: "application/x-ndjson; charset=utf-8",
      body: `${JSON.stringify({ type: "start" })}\n${JSON.stringify({ type: "generated", content })}\n`,
    });
  });

  await openTranslatedPage(page, lumo.url, "repair.pdf");
  await page.getByRole("button", { name: "Translate this page" }).click();

  await expect(page.locator(".page-status")).toHaveText(/Repairing Typst/, { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Cancel this page" })).toBeVisible();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]!.repair?.typst).toBe(broken);
  // The real worker reports 1-based positions and quotes the failing line, not typst.ts's 0-based range.
  expect(requests[1]!.repair?.diagnostics).toBe(
    "error: unclosed delimiter (line 2, column 8)\n2 | #strong⟦[⟧应收账款（Accounts Receivable）",
  );
  expect(saves).toEqual([]);

  releaseRepair.resolve();
  await expect(page.locator(".page-status")).toHaveText(/Saved/, { timeout: 20_000 });
  expect(saves).toEqual([fixed]);
  expect(await (await lumo.api.get(path)).json()).toMatchObject({ typst: fixed });

  const preview = page.locator(".typst-preview iframe");
  await expect(preview).toBeVisible();
  await expect
    .poll(async () => darkPixels(page, await preview.screenshot()), { timeout: 20_000 })
    .toBeGreaterThan(100);
});

test("Typst repair goes on round after round until the page compiles, and every round stays visible", async ({
  page,
  lumo,
}) => {
  const document = await uploadPdf(lumo.api, "ledger.pdf", 2, "ledger");
  const path = translationPath(document.id, 1, "en");
  const paragraphs = [
    ["税额 $5。", "税额 \\$5。"],
    ["期初 $1,200 与期末 $3,450。", "期初 \\$1,200 与期末 \\$3,450。"],
    ["计提 $20 和 $40。", "计提 \\$20 和 \\$40。"],
  ] as const;
  // Typst reports only the last unpaired `$`, so a reply that escapes the last paragraphs still
  // leaves the page broken until the first one is escaped as well.
  const source = (escapedFromEnd: number): string =>
    `#set page(width:180mm,height:auto)\n\n${paragraphs
      .map(([raw, safe], index) => (index >= paragraphs.length - escapedFromEnd ? safe : raw))
      .join("\n\n")}\n`;
  const requests: { repair?: { typst: string; diagnostics: string } }[] = [];
  const saves: string[] = [];
  const releaseFirstRepair = Promise.withResolvers<void>();

  page.on("request", (request) => {
    if (request.method() !== "PUT" || new URL(request.url()).pathname !== path) return;
    const body: { typst: string } = request.postDataJSON();
    saves.push(body.typst);
  });
  // Only the model answer is faked; the Typst worker, the repair loop, PUT and SQLite stay real.
  await page.route(/\/api\/translate$/, async (route) => {
    const body: (typeof requests)[number] = route.request().postDataJSON();
    requests.push(body);
    if (requests.length === 2) await releaseFirstRepair.promise;
    const events: object[] = [{ type: "start" }];
    if (body.repair) {
      events.push(
        { type: "repair", progress: { phase: "requesting", replyAttempt: 1 } },
        { type: "repair", progress: { phase: "applied", replyAttempt: 1, change: { mode: "edits", count: 1 } } },
      );
    }
    const content = { typst: source(requests.length - 1), provider: "custom", model: "smoke" };
    events.push({ type: "generated", content });
    await route.fulfill({
      contentType: "application/x-ndjson; charset=utf-8",
      body: events.map((event) => `${JSON.stringify(event)}\n`).join(""),
    });
  });

  await openTranslatedPage(page, lumo.url, "ledger.pdf");
  await page.getByRole("button", { name: "Translate this page" }).click();

  // Round 1 waits for the model: its diagnostic is on screen and nothing has been stored.
  const panel = page.locator(".typst-repair");
  await expect(panel.locator(".typst-repair-summary")).toContainText("Round 1", { timeout: 20_000 });
  await expect(panel.locator("pre").first()).toContainText("error: unclosed delimiter (line 7, column 10)");
  expect(saves).toEqual([]);
  releaseFirstRepair.resolve();

  // Two replies escape one paragraph each from the end and the page still fails; the third one
  // escapes the first paragraph too. Nothing stops the run before that.
  await expect(page.locator(".page-status")).toHaveText(/Saved/, { timeout: 20_000 });
  expect(requests).toHaveLength(4);
  expect(requests[3]!.repair?.typst).toBe(source(2));
  expect(saves).toEqual([source(3)]);
  expect(await (await lumo.api.get(path)).json()).toMatchObject({ typst: source(3) });

  await expect(panel.locator("details")).toHaveCount(3);
  await expect(panel.locator("details").nth(1).locator(".typst-repair-after")).toHaveText(paragraphs[1][1]);
  // Once the page is saved every round is folded; opening one shows its coloured before/after lines.
  await panel.locator("details").nth(1).locator("summary").click();
  await expect(
    panel.locator("details").nth(1).locator(".typst-repair-after span[style*='color']").first(),
  ).toBeVisible();
  await expect(panel.locator("details").nth(1).locator("pre").last()).toContainText("line 3, column 4");
  await expect(panel.locator(".typst-repair-outcome")).toHaveText("Saved");
  // The request for round 3 also carried what round 2 had changed.
  expect(requests[3]!.repair?.diagnostics).toContain(paragraphs[1][1]);
});

test("Typst repair keeps the details of the latest five rounds and says how many earlier ones it left out", async ({
  page,
  lumo,
}) => {
  const document = await uploadPdf(lumo.api, "stubborn.pdf", 2, "stubborn");
  const path = translationPath(document.id, 1, "en");
  const broken = "#set page(width:180mm,height:auto)\n#strong[应收账款（Accounts Receivable）";
  const fixed = `${broken}]`;
  // A trailing comment keeps the bracket open but makes every reply a new source, so no pause separates the rounds.
  const reply = (request: number): string => (request === 9 ? fixed : `${broken}\n// reply ${request}`);
  const requests: unknown[] = [];
  const saves: string[] = [];

  page.on("request", (request) => {
    if (request.method() !== "PUT" || new URL(request.url()).pathname !== path) return;
    const body: { typst: string } = request.postDataJSON();
    saves.push(body.typst);
  });
  await page.route(/\/api\/translate$/, async (route) => {
    requests.push(route.request().postDataJSON());
    const content = { typst: reply(requests.length), provider: "custom", model: "smoke" };
    await route.fulfill({
      contentType: "application/x-ndjson; charset=utf-8",
      body: `${JSON.stringify({ type: "start" })}\n${JSON.stringify({ type: "generated", content })}\n`,
    });
  });

  await openTranslatedPage(page, lumo.url, "stubborn.pdf");
  await page.getByRole("button", { name: "Translate this page" }).click();
  await expect(page.locator(".page-status")).toHaveText(/Saved/, { timeout: 60_000 });

  expect(requests).toHaveLength(9);
  expect(saves).toEqual([fixed]);
  const panel = page.locator(".typst-repair");
  await expect(panel.locator(".typst-repair-summary")).toContainText("Round 8");
  await expect(panel.locator("details")).toHaveCount(5);
  await expect(panel.locator("details summary").first()).toContainText("Round 4");
  await expect(panel.locator(".typst-repair-omitted")).toHaveText("Details of 3 earlier round(s) are omitted.");
});

test("Typst repair asks again after a refused reply and a fruitless edit, then saves the escaped blanks", async ({
  page,
  lumo,
}) => {
  const document = await uploadPdf(lumo.api, "blanks.pdf", 2, "blanks");
  const path = translationPath(document.id, 1, "en");
  // Fill-in blanks as in a scanned exercise page: three runs of five underscores leave one
  // emphasis open on every line, and a line break at the end of the line does not close it.
  const lines = [
    "借：银行存款 _____，贷：主营业务收入 _____，应交税费 _____",
    "借：应收账款 _____，贷：主营业务收入 _____，应交税费 _____",
    "借：库存商品 _____，贷：应付账款 _____，银行存款 _____",
  ];
  const document89 = (edit: (line: string) => string): string =>
    `#set page(width:180mm,height:auto)\n\n${lines.map(edit).join("\n\n")}\n`;
  const broken = document89((line) => line);
  const appended = document89((line) => `${line} \\`);
  const fixed = document89((line) => line.replaceAll("_", "\\_"));
  const replies = [
    { typst: broken },
    { error: { code: "INVALID_AI_OUTPUT", message: "Typst repair makes no change" } },
    { typst: appended },
    { typst: fixed },
  ];
  const requests: { repair?: { typst: string; diagnostics: string } }[] = [];
  const saves: string[] = [];

  page.on("request", (request) => {
    if (request.method() !== "PUT" || new URL(request.url()).pathname !== path) return;
    const body: { typst: string } = request.postDataJSON();
    saves.push(body.typst);
  });
  await page.route(/\/api\/translate$/, async (route) => {
    requests.push(route.request().postDataJSON());
    const reply = replies[requests.length - 1]!;
    const outcome =
      "typst" in reply
        ? { type: "generated", content: { typst: reply.typst, provider: "custom", model: "smoke" } }
        : { type: "error", error: reply.error };
    await route.fulfill({
      contentType: "application/x-ndjson; charset=utf-8",
      body: `${JSON.stringify({ type: "start" })}\n${JSON.stringify(outcome)}\n`,
    });
  });

  await openTranslatedPage(page, lumo.url, "blanks.pdf");
  await page.getByRole("button", { name: "Translate this page" }).click();
  await expect(page.locator(".page-status")).toHaveText(/Saved/, { timeout: 30_000 });

  // The refused reply and the edit that changed nothing about the error did not end the run.
  expect(requests.map((request) => request.repair?.typst)).toEqual([undefined, broken, broken, appended]);
  const heading = "Previous repair attempt (not source):";
  expect(requests[1]!.repair?.diagnostics).not.toContain(heading);
  expect(requests[2]!.repair?.diagnostics).toContain("Typst repair makes no change");
  expect(requests[3]!.repair?.diagnostics).toContain(heading);
  expect(requests[3]!.repair?.diagnostics).toContain(lines[0]! + " \\");
  expect(saves).toEqual([fixed]);
  expect(await (await lumo.api.get(path)).json()).toMatchObject({ typst: fixed });

  const panel = page.locator(".typst-repair");
  await expect(panel.locator("details")).toHaveCount(3);
  await expect(panel.locator("details").nth(0).locator("summary")).toContainText("Reply rejected");
  await expect(panel.locator("details").nth(1).locator("summary")).toContainText("Still does not compile");
  await expect(panel.locator("details").nth(2).locator("summary")).toContainText("Compiles");
});

test("Cancel stops a Typst repair that is waiting for the model, keeps the draft, and Continue repair starts again", async ({
  page,
  lumo,
}) => {
  const document = await uploadPdf(lumo.api, "stop.pdf", 2, "stop");
  const path = translationPath(document.id, 1, "en");
  const broken = "#set page(width:180mm,height:auto)\n#strong[应收账款（Accounts Receivable）";
  const fixed = `${broken}]`;
  const requests: { repair?: { typst: string; diagnostics: string } }[] = [];
  const saves: string[] = [];
  const modelStillThinking = Promise.withResolvers<void>();

  page.on("request", (request) => {
    if (request.method() !== "PUT" || new URL(request.url()).pathname !== path) return;
    const body: { typst: string } = request.postDataJSON();
    saves.push(body.typst);
  });
  await page.route(/\/api\/translate$/, async (route) => {
    const body: (typeof requests)[number] = route.request().postDataJSON();
    requests.push(body);
    // The first repair is never answered: Cancel aborts it.
    if (requests.length === 2) {
      await modelStillThinking.promise;
      await route.abort().catch(() => undefined);
      return;
    }
    const content = { typst: body.repair ? fixed : broken, provider: "custom", model: "smoke" };
    await route.fulfill({
      contentType: "application/x-ndjson; charset=utf-8",
      body: `${JSON.stringify({ type: "start" })}\n${JSON.stringify({ type: "generated", content })}\n`,
    });
  });

  await openTranslatedPage(page, lumo.url, "stop.pdf");
  await page.getByRole("button", { name: "Translate this page" }).click();
  await expect(page.locator(".page-status")).toHaveText(/Repairing Typst/, { timeout: 20_000 });
  await page.getByRole("button", { name: "Cancel this page" }).click();

  await expect(page.locator(".page-status")).toHaveText(/Cancelled/);
  await expect(page.locator(".typst-repair-outcome")).toContainText("latest draft is kept");
  expect(requests).toHaveLength(2);
  expect(saves).toEqual([]);
  modelStillThinking.resolve();

  // A new explicit repair is a new run: the model gets the compiler's output without a previous attempt.
  await page.getByRole("button", { name: "Continue repair" }).click();
  await expect(page.locator(".page-status")).toHaveText(/Saved/, { timeout: 20_000 });
  expect(requests).toHaveLength(3);
  expect(requests[2]!.repair).toEqual({
    typst: broken,
    diagnostics: "error: unclosed delimiter (line 2, column 8)\n2 | #strong⟦[⟧应收账款（Accounts Receivable）",
  });
  expect(saves).toEqual([fixed]);
  expect(await (await lumo.api.get(path)).json()).toMatchObject({ typst: fixed });
});

test("Typst compiles offline: packages, read() and remote images are rejected by the compiler and nothing leaves the app", async ({
  page,
  context,
  lumo,
}) => {
  const document = await uploadPdf(lumo.api, "offline.pdf", 2, "offline");
  const path = translationPath(document.id, 1, "en");
  const appOrigin = new URL(lumo.url).origin;
  // The model's answer to each rejected document is the next forbidden one, then a document that compiles.
  const forbidden = [
    '#import "@preview/cetz:0.3.0": canvas\n= Packages',
    '#let hostname = read("/etc/hostname")\n= Disk: #hostname',
    '#image("https://offline.invalid/figure.png")',
    '#include "elsewhere.typ"',
  ];
  const fixed = "= Offline";
  const requests: { repair?: { typst: string; diagnostics: string } }[] = [];
  const saves: string[] = [];
  const reached: string[] = [];

  context.on("request", (request) => {
    const url = new URL(request.url());
    const outside = url.protocol.startsWith("http") && url.origin !== appOrigin;
    if (outside || /etc\/hostname|elsewhere\.typ|figure\.png|cetz/.test(url.pathname)) {
      reached.push(request.url());
    }
    if (request.method() === "PUT" && url.pathname === path) {
      saves.push((request.postDataJSON() as { typst: string }).typst);
    }
  });

  // Control: the observer above does see a request made by a worker, so its silence below means something.
  const scratch = await context.newPage();
  await scratch.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const source =
          "fetch('https://offline.invalid/control').catch(() => {}).finally(() => postMessage(1))";
        const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
        worker.onmessage = () => resolve();
      }),
  );
  await scratch.close();
  expect(reached).toEqual(["https://offline.invalid/control"]);
  reached.length = 0;

  await page.route(/\/api\/translate$/, async (route) => {
    const body: (typeof requests)[number] = route.request().postDataJSON();
    requests.push(body);
    const content = { typst: forbidden[requests.length - 1] ?? fixed, provider: "custom", model: "smoke" };
    await route.fulfill({
      contentType: "application/x-ndjson; charset=utf-8",
      body: `${JSON.stringify({ type: "start" })}\n${JSON.stringify({ type: "generated", content })}\n`,
    });
  });

  await openTranslatedPage(page, lumo.url, "offline.pdf");
  await page.getByRole("button", { name: "Translate this page" }).click();
  await expect(page.locator(".page-status")).toHaveText(/Saved/, { timeout: 30_000 });

  // The first answer is the page itself; each later request repairs the document before it.
  expect(requests).toHaveLength(forbidden.length + 1);
  forbidden.forEach((typst, index) => {
    expect(requests[index + 1]!.repair?.typst).toBe(typst);
    expect(requests[index + 1]!.repair?.diagnostics).toMatch(/^error: /);
  });
  expect(saves).toEqual([fixed]);
  expect(reached).toEqual([]);
});

test("The interface language waits while a Typst draft is kept, then applies and the reader comes back to the same page", async ({
  page,
  lumo,
}) => {
  const document = await uploadPdf(lumo.api, "locale.pdf", 2, "locale");
  const path = translationPath(document.id, 2, "en");
  const broken = "#set page(width:180mm,height:auto)\n#strong[unclosed";
  const saves: string[] = [];

  page.on("request", (request) => {
    if (request.method() === "PUT" && new URL(request.url()).pathname === path) saves.push(request.url());
  });
  // Every answer stays broken: the repair goes on until the user cancels it.
  await page.route(/\/api\/translate$/, async (route) => {
    const content = { typst: broken, provider: "custom", model: "smoke" };
    await route.fulfill({
      contentType: "application/x-ndjson; charset=utf-8",
      body: `${JSON.stringify({ type: "start" })}\n${JSON.stringify({ type: "generated", content })}\n`,
    });
  });

  await openTranslatedPage(page, lumo.url, "locale.pdf");
  const viewer = page.frameLocator("iframe.pdf-frame");
  await expect(viewer.locator("#pageNumber")).toHaveAttribute("max", "2");
  await viewer.locator("#pageNumber").fill("2");
  await viewer.locator("#pageNumber").press("Enter");
  await expect(viewer.locator("#pageNumber")).toHaveValue("2");
  await page.getByRole("button", { name: "Translate this page" }).click();
  await expect(page.locator(".page-status")).toHaveText(/Repairing Typst/, { timeout: 20_000 });
  await page.getByRole("button", { name: "Cancel this page" }).click();
  await expect(page.locator(".typst-repair-outcome")).toContainText("latest draft is kept");

  const chooseChinese = async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("combobox", { name: /^Interface language/ }).selectOption("zh-CN");
    return settings;
  };
  const blocked = await chooseChinese();
  await expect(blocked.getByRole("button", { name: "Save language and reload" })).toBeDisabled();
  await blocked.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByRole("button", { name: "Discard draft", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Discard unsaved translation?" })
    .getByRole("button", { name: "Discard", exact: true })
    .click();
  await expect(page.locator(".typst-repair-outcome")).toHaveCount(0);

  const settings = await chooseChinese();
  const apply = settings.getByRole("button", { name: "Save language and reload" });
  await expect(apply).toBeEnabled();
  await apply.click();

  await expect(page.getByRole("main", { name: "书库" })).toBeVisible();
  await openFromLibrary(page, "locale.pdf");
  await expect(page.frameLocator("iframe.pdf-frame").locator("#pageNumber")).toHaveValue("2");
  expect(saves).toEqual([]);
});

test("PDF neighboring context sends the edges of the adjacent pages and saves only the current page", async ({
  page,
  lumo,
}) => {
  const document = await uploadPdf(lumo.api, "context.pdf", 3, "context");
  type Reference = { text?: string; imageBase64?: string };
  const requests: { pageNumber: number; context?: { previous?: Reference; next?: Reference } }[] = [];
  // Only the model answer is faked; page preparation, the neighbouring pages, PUT and SQLite stay real.
  await page.route(/\/api\/translate$/, async (route) => {
    const body: (typeof requests)[number] = route.request().postDataJSON();
    requests.push(body);
    const content = { typst: `= page ${body.pageNumber} only`, provider: "custom", model: "smoke" };
    await route.fulfill({
      contentType: "application/x-ndjson; charset=utf-8",
      body: `${JSON.stringify({ type: "start" })}\n${JSON.stringify({ type: "generated", content })}\n`,
    });
  });

  await openTranslatedPage(page, lumo.url, "context.pdf");
  const viewer = page.frameLocator("iframe.pdf-frame");
  await expect(viewer.locator("#numPages")).toHaveText(/3/);
  const translatePage = async (pageNumber: number, requestCount: number) => {
    await viewer.locator("#pageNumber").fill(String(pageNumber));
    await viewer.locator("#pageNumber").press("Enter");
    await expect(page.locator(".page-position strong")).toHaveText(`Page ${pageNumber} / 3`);
    await page.getByRole("button", { name: "Translate this page" }).click();
    await expect.poll(() => requests.length).toBe(requestCount);
    await expect(page.locator(".page-status")).toHaveText(/Saved/, { timeout: 20_000 });
  };

  // The fixture pages have no text layer, so each neighbour arrives as a JPEG strip.
  await translatePage(2, 1);
  expect(requests[0]!.pageNumber).toBe(2);
  expect(requests[0]!.context?.previous?.imageBase64).toMatch(/^\/9j\//);
  expect(requests[0]!.context?.next?.imageBase64).toMatch(/^\/9j\//);

  await translatePage(1, 2);
  expect(requests[1]!.context?.previous).toBeUndefined();
  expect(requests[1]!.context?.next?.imageBase64).toMatch(/^\/9j\//);

  const locations = await lumo.api.get(
    `/api/documents/${document.id}/translation-locations?targetLanguage=en`,
  );
  expect(await locations.json()).toEqual({
    locations: [
      { pageNumber: 1, unit: "" },
      { pageNumber: 2, unit: "" },
    ],
  });
  expect(await (await lumo.api.get(translationPath(document.id, 2, "en"))).json()).toMatchObject({
    typst: "= page 2 only",
  });
});

test("Typst source editor stays open while typing, saves the edit and discarding returns to the saved text", async ({
  page,
  lumo,
}) => {
  const document = await uploadPdf(lumo.api, "editor.pdf", 2, "editor");
  const path = translationPath(document.id, 1, "en");
  const original = "= Original";
  const saves: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "PUT" || new URL(request.url()).pathname !== path) return;
    const body: { typst: string } = request.postDataJSON();
    saves.push(body.typst);
  });
  await page.route(/\/api\/translate$/, async (route) => {
    const content = { typst: original, provider: "custom", model: "smoke" };
    await route.fulfill({
      contentType: "application/x-ndjson; charset=utf-8",
      body: `${JSON.stringify({ type: "start" })}\n${JSON.stringify({ type: "generated", content })}\n`,
    });
  });

  await openTranslatedPage(page, lumo.url, "editor.pdf");
  await page.getByRole("button", { name: "Translate this page" }).click();
  const status = page.locator(".page-status");
  await expect(status).toHaveText(/Saved/, { timeout: 20_000 });

  const edit = page.getByRole("button", { name: "Edit source" });
  const editor = page.getByRole("textbox", { name: "Typst source" });
  const save = page.getByRole("button", { name: "Save", exact: true });
  const discard = page.getByRole("button", { name: "Discard changes", exact: true });

  // Nothing is typed yet: there is nothing to save and leaving the editor asks nothing.
  await edit.click();
  await expect(editor).toHaveValue(original);
  await expect(save).toBeDisabled();
  await discard.click();
  await expect(editor).toBeHidden();

  // The first keystroke turns the saved text into a draft; the editor must survive that and take the next one.
  await edit.click();
  await editor.fill(`${original}\nsecond line`);
  await expect(status).toHaveText(/Unsaved/);
  await editor.pressSequentially("!");
  await expect(editor).toHaveValue(`${original}\nsecond line!`);

  await discard.click();
  await page
    .getByRole("dialog", { name: "Discard unsaved translation?" })
    .getByRole("button", { name: "Discard", exact: true })
    .click();
  await expect(editor).toBeHidden();
  await expect(status).toHaveText(/Saved/);
  await expect(page.locator(".typst-source")).toHaveText(original);
  expect(saves).toEqual([original]);

  await edit.click();
  await editor.fill("= Edited");
  await editor.pressSequentially("!");
  await save.click();
  await expect(status).toHaveText(/Saved/, { timeout: 20_000 });
  await expect(editor).toBeHidden();
  expect(saves).toEqual([original, "= Edited!"]);
  expect(await (await lumo.api.get(path)).json()).toMatchObject({ typst: "= Edited!" });
});

test("Export all writes one file per PDF page and leaves selection translations out", async ({
  page,
  lumo,
}) => {
  const document = await uploadPdf(lumo.api, "export.pdf", 2, "export");
  const seed = async (pageNumber: number, typst: string, unit = "") => {
    const response = await lumo.api.put(
      `${translationPath(document.id, pageNumber, "en")}${unit ? `?unit=${unit}` : ""}`,
      { data: { typst, provider: "custom", model: "smoke" } },
    );
    expect(response.ok()).toBe(true);
  };
  await seed(1, "= Page one");
  await seed(2, "= Page two");
  // Same page, own unit: it must neither be exported nor overwrite the page file.
  await seed(1, "= Only a selection", "selection-1");

  await openTranslatedPage(page, lumo.url, "export.pdf");
  await expect(page.locator(".page-status")).toHaveText(/Saved/);
  const text = new TextEncoder();
  expect(await downloadAllTranslations(page)).toEqual({
    "p1-en.typ": text.encode("= Page one"),
    "p2-en.typ": text.encode("= Page two"),
  });
});
