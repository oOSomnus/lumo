import type { Locator, Page } from "@playwright/test";
import { expect, openApp, openTranslatedPage, test, uploadPdf } from "./fixtures";

// Every test here starts from a fresh install: nothing is configured until the test sets it up through the interface.
test.use({ aiConfigured: false });

const SETTINGS_READ = /\/api\/ai\/settings$/;

/** Paths of the model requests the page sends. A button that leads to the AI setup must not produce any. */
function watchModelCalls(page: Page): string[] {
  const calls: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/translate" || path === "/api/outline-page") calls.push(path);
  });
  return calls;
}

/** Chooses the custom provider, fills a keyless local endpoint and saves it; the summary then reads "Ready". */
async function saveCustomEndpoint(settings: Locator): Promise<void> {
  await settings.getByRole("combobox", { name: /^Provider/ }).selectOption("custom");
  await settings.getByRole("textbox", { name: "Vision model" }).fill("smoke");
  await settings.getByRole("textbox", { name: "Base URL" }).fill("http://127.0.0.1:9/v1");
  await settings.getByRole("spinbutton", { name: "Context window" }).fill("128000");
  await settings.getByRole("spinbutton", { name: "Maximum output tokens" }).fill("4096");
  await settings.getByRole("button", { name: "Save AI settings" }).click();
  await expect(settings.locator(".ai-summary")).toContainText("Ready: Custom OpenAI-compatible · smoke");
}

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

test("Translate asks to set up the AI first, sends nothing, and Settings returns to the same page", async ({
  page,
  lumo,
}) => {
  await uploadPdf(lumo.api, "setup.pdf", 2, "setup");
  const calls = watchModelCalls(page);
  await openTranslatedPage(page, lumo.url, "setup.pdf");
  const viewer = page.frameLocator("iframe.pdf-frame");
  await expect(viewer.locator("#pageNumber")).toHaveAttribute("max", "2");
  await viewer.locator("#pageNumber").fill("2");
  await viewer.locator("#pageNumber").press("Enter");
  await expect(page.locator(".page-position strong")).toHaveText("Page 2 / 2");

  await expect(page.getByText("AI translation is not set up yet.")).toBeVisible();
  await page.getByRole("button", { name: "Configure AI to translate" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  // The AI comes first; the interface language and the data follow.
  await expect(settings.getByRole("heading", { level: 3 }).first()).toHaveText("AI provider and model");
  const summary = settings.locator(".ai-summary");
  await expect(summary).toContainText("AI is not set up yet.");
  const done = settings.getByRole("button", { name: "Done", exact: true });
  await expect(done).toHaveCount(0);

  await settings.getByRole("combobox", { name: /^Provider/ }).selectOption("custom");
  await expect(summary).toContainText("not saved yet");
  await saveCustomEndpoint(settings);

  // A draft is never "ready", and Done only offers itself when the form matches what is saved.
  const model = settings.getByRole("textbox", { name: "Vision model" });
  await model.fill("smoke-2");
  await expect(summary).toContainText("not saved yet");
  await expect(done).toHaveCount(0);
  await model.fill("smoke");
  await expect(summary).toContainText("Ready: Custom OpenAI-compatible · smoke");
  await done.click();
  await expect(settings).toBeHidden();

  await expect(page.getByRole("button", { name: "Translate this page" })).toBeEnabled();
  await expect(page.locator(".page-position strong")).toHaveText("Page 2 / 2");
  await expect(page.getByRole("combobox", { name: /^Target language/ })).toHaveValue("en");
  expect(calls).toEqual([]);
});

test("A failed settings read offers a retry instead of claiming the AI is not set up", async ({ page, lumo }) => {
  await uploadPdf(lumo.api, "unread.pdf", 2, "unread");
  const calls = watchModelCalls(page);
  await page.route(SETTINGS_READ, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "HTTP_ERROR", message: "injected" } }),
        })
      : route.fallback(),
  );
  await openTranslatedPage(page, lumo.url, "unread.pdf");

  const retry = page.getByRole("button", { name: "Retry reading AI settings" });
  await expect(retry).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Could not read the AI settings" })).toBeVisible();
  await expect(page.getByText("AI translation is not set up yet.")).toHaveCount(0);

  // Only a read that works can say the server has no AI.
  await page.unroute(SETTINGS_READ);
  await retry.click();
  await expect(page.getByRole("button", { name: "Configure AI to translate" })).toBeVisible();
  await expect(page.getByText("AI translation is not set up yet.")).toBeVisible();
  expect(calls).toEqual([]);
});

test("A settings read that finishes after the save never turns a ready AI back into not set up", async ({
  page,
  lumo,
}) => {
  await uploadPdf(lumo.api, "stale.pdf", 2, "stale");
  const release = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  let held = false;
  await page.route(SETTINGS_READ, async (route) => {
    if (route.request().method() !== "GET" || held) {
      await route.fallback();
      return;
    }
    held = true;
    // The answer is read before the save, so it says "not set up", and it reaches the page after the save.
    const stale = await route.fetch();
    await release.promise;
    await route.fulfill({ response: stale }).catch(() => {});
    settled.resolve();
  });
  await openTranslatedPage(page, lumo.url, "stale.pdf");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await saveCustomEndpoint(settings);
  await settings.getByRole("button", { name: "Done", exact: true }).click();
  const translate = page.getByRole("button", { name: "Translate this page" });
  await expect(translate).toBeEnabled();

  release.resolve();
  await settled.promise;
  await expect(translate).toBeEnabled();
  await expect(page.getByRole("button", { name: "Configure AI to translate" })).toHaveCount(0);
});

test("The advanced settings stay folded until a saved value uses them", async ({ page, lumo }) => {
  await openApp(page, lumo.url);
  const settings = page.getByRole("dialog", { name: "Settings" });
  const advanced = settings.locator("details.settings-advanced");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(advanced).toHaveJSProperty("open", false);
  await settings.getByRole("button", { name: "Close", exact: true }).click();

  const saved = await lumo.api.put("/api/ai/settings", {
    data: {
      provider: "custom",
      model: "smoke",
      baseUrl: "http://127.0.0.1:9/v1",
      contextWindow: 128000,
      maxTokens: 4096,
      reasoningEffort: "low",
    },
  });
  expect(saved.ok()).toBe(true);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(advanced).toHaveJSProperty("open", true);
  await expect(settings.getByRole("combobox", { name: /^Reasoning effort/ })).toHaveValue("low");
});

test("The batch panel leads to the AI setup, keeps its range and starts nothing until the AI is ready", async ({
  page,
  lumo,
}) => {
  await uploadPdf(lumo.api, "queue.pdf", 4, "queue");
  const calls = watchModelCalls(page);
  await openTranslatedPage(page, lumo.url, "queue.pdf");
  await page.getByRole("tab", { name: "Batch translation" }).click();
  const panel = page.locator(".batch-panel");
  await panel.locator("#batch-expression").fill("1-2");
  await panel.getByRole("button", { name: "Apply", exact: true }).click();

  await expect(panel.getByRole("button", { name: /^Start translation/ })).toHaveCount(0);
  await panel.getByRole("button", { name: "Configure AI to translate" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await saveCustomEndpoint(settings);
  await settings.getByRole("button", { name: "Done", exact: true }).click();

  await expect(panel.locator("#batch-expression")).toHaveValue("1-2");
  await expect(panel.getByRole("button", { name: /^Start translation/ })).toBeEnabled();
  expect(calls).toEqual([]);
});
