import {
  expect,
  noteField,
  openApp,
  openFromLibrary,
  saveCopyButton,
  test,
  uploadPdf,
} from "./fixtures";

test("the shelf is the default screen and restores page and view", async ({
  page,
  lumo,
}) => {
  const first = await uploadPdf(lumo.api, "first.pdf", 2, "first");
  await uploadPdf(lumo.api, "second.pdf", 2, "second");
  const update = await lumo.api.patch("/api/reader", {
    data: { documentId: first.id, pageNumber: 2, targetLanguage: "zh-CN" },
  });
  expect(update.ok()).toBe(true);

  await openApp(page, lumo.url);
  const library = page.getByRole("main", { name: "Library" });
  await expect(library).toBeVisible();
  await expect(page.locator("iframe.pdf-frame")).toHaveCount(0);

  const firstCard = library.getByRole("listitem").filter({ hasText: "first.pdf" });
  await expect(
    firstCard.getByRole("button", { name: "first.pdf", exact: true }),
  ).toBeVisible();
  await expect(firstCard.getByText("Page 2 / 2")).toBeVisible();

  await firstCard.getByRole("button", { name: "first.pdf", exact: true }).click();
  const viewer = page.frameLocator("iframe.pdf-frame");
  await expect(viewer.locator("#pageNumber")).toHaveValue("2");

  const viewSave = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname === `/api/documents/${first.id}/view`,
  );
  await viewer.locator("#scaleSelect").selectOption("1.5");
  await expect(viewer.locator("#scaleSelect")).toHaveValue("1.5");
  await viewSave;

  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(library).toBeVisible();
  await firstCard.getByRole("button", { name: "first.pdf", exact: true }).click();
  await expect(viewer.locator("#pageNumber")).toHaveValue("2");
  await expect(viewer.locator("#scaleSelect")).toHaveValue("1.5");

  await openApp(page, lumo.url);
  await expect(page.getByRole("main", { name: "Library" })).toBeVisible();
  await expect(page.locator("iframe.pdf-frame")).toHaveCount(0);
  await openFromLibrary(page, "first.pdf");
  const reloaded = page.frameLocator("iframe.pdf-frame");
  await expect(reloaded.locator("#pageNumber")).toHaveValue("2");
  await expect(reloaded.locator("#scaleSelect")).toHaveValue("1.5");
});

for (const resumeVia of ["return-button", "same-book"] as const) {
  test(`late PDF page changes survive ${resumeVia}`, async ({ page, lumo }) => {
    const record = await uploadPdf(lumo.api, "late-page.pdf", 2, "late-page");
    await openApp(page, lumo.url);
    await openFromLibrary(page, "late-page.pdf");
    await expect(noteField(page)).toHaveValue("late-page");
    const viewer = page.frameLocator("iframe.pdf-frame");
    const pagePosition = page.locator(".page-position strong");
    await expect(viewer.locator("#pageNumber")).toHaveValue("1");
    await expect(pagePosition).toHaveText("Page 1 / 2");

    await page
      .getByRole("button", { name: "Library", exact: true })
      .evaluate((button) => {
        (button as HTMLButtonElement).click();
        const frame = document.querySelector("iframe.pdf-frame") as HTMLIFrameElement;
        // PDF.js exposes its app object on the viewer iframe window.
        const frameWindow = frame.contentWindow as unknown;
        if (
          !frameWindow ||
          typeof frameWindow !== "object" ||
          !("PDFViewerApplication" in frameWindow)
        ) {
          throw new Error("PDF.js viewer is not ready");
        }
        const pdfjs = frameWindow.PDFViewerApplication as { page: number };
        pdfjs.page = 2;
      });

    const library = page.getByRole("main", { name: "Library" });
    await expect(library).toBeVisible();
    await expect(viewer.locator("#pageNumber")).toHaveValue("2");

    if (resumeVia === "return-button") {
      await page
        .getByRole("button", { name: "Return to reading", exact: true })
        .click();
    } else {
      await openFromLibrary(page, "late-page.pdf");
    }

    await expect(library).toBeHidden();
    await expect(pagePosition).toHaveText("Page 2 / 2");
    await expect(viewer.locator("#pageNumber")).toHaveValue("2");

    await expect
      .poll(async () => {
        const response = await lumo.api.get("/api/library");
        expect(response.ok()).toBe(true);
        const body = (await response.json()) as {
          documents: { id: string; currentPage: number }[];
        };
        return body.documents.find((doc) => doc.id === record.id)?.currentPage;
      })
      .toBe(2);

    await openApp(page, lumo.url);
    await expect(page.getByRole("main", { name: "Library" })).toBeVisible();
    await openFromLibrary(page, "late-page.pdf");
    await expect(viewer.locator("#pageNumber")).toHaveValue("2");
    await expect(pagePosition).toHaveText("Page 2 / 2");
  });
}

test("the shelf keeps unsaved edits and confirms a switch", async ({
  page,
  lumo,
}) => {
  await uploadPdf(lumo.api, "first.pdf", 2, "first");
  await uploadPdf(lumo.api, "second.pdf", 2, "second");

  await openApp(page, lumo.url);
  await openFromLibrary(page, "first.pdf");
  await expect(noteField(page)).toHaveValue("first");
  await noteField(page).fill("unsaved shelf edit");

  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("main", { name: "Library" });
  await expect(library).toBeVisible();
  await page
    .getByRole("button", { name: "Return to reading", exact: true })
    .click();
  await expect(noteField(page)).toHaveValue("unsaved shelf edit");
  await expect(saveCopyButton(page)).toBeEnabled();

  await page.getByRole("button", { name: "Library", exact: true }).click();
  await library.getByRole("button", { name: "second.pdf", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Switch documents?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(library).toBeVisible();
  await expect(noteField(page)).toHaveValue("unsaved shelf edit");

  await page
    .getByRole("button", { name: "Return to reading", exact: true })
    .click();
  await expect(noteField(page)).toHaveValue("unsaved shelf edit");

  await page.getByRole("button", { name: "Library", exact: true }).click();
  await library.getByRole("button", { name: "second.pdf", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Switch documents?" })
    .getByRole("button", { name: "Switch anyway" })
    .click();
  await expect(noteField(page)).toHaveValue("second");
});

test("an unreadable PDF shows a placeholder and can be deleted", async ({
  page,
  lumo,
}) => {
  const broken = await lumo.api.post(
    "/api/documents?name=broken.pdf&pageCount=1",
    {
      headers: { "Content-Type": "application/pdf" },
      data: Buffer.from("%PDF-1.7\nbroken"),
    },
  );
  expect(broken.ok()).toBe(true);
  await uploadPdf(lumo.api, "valid.pdf", 2, "valid");

  await openApp(page, lumo.url);
  const library = page.getByRole("main", { name: "Library" });
  await expect(library).toBeVisible();
  await expect(library.getByText("Cover unavailable")).toBeVisible();
  await expect(
    library.getByRole("button", { name: "valid.pdf", exact: true }),
  ).toBeVisible();
  const validCard = library.getByRole("listitem").filter({ hasText: "valid.pdf" });
  await expect(validCard.locator(".book-cover img")).toBeVisible();

  await library.getByRole("button", { name: "valid.pdf", exact: true }).click();
  await expect(noteField(page)).toHaveValue("valid");

  await page.getByRole("button", { name: "Library", exact: true }).click();
  const card = library.getByRole("listitem").filter({ hasText: "broken.pdf" });
  await card.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Delete document?" })
    .getByRole("button", { name: "Delete", exact: true })
    .click();

  await expect(
    library.getByRole("button", { name: "broken.pdf", exact: true }),
  ).toHaveCount(0);
  await expect(
    library.getByRole("button", { name: "valid.pdf", exact: true }),
  ).toBeVisible();
  await expect(library.getByText("Cover unavailable")).toHaveCount(0);

  const validBook = library
    .getByRole("listitem")
    .filter({ hasText: "valid.pdf" });
  await validBook.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Delete document?" })
    .getByRole("button", { name: "Delete", exact: true })
    .click();

  await expect(
    library.getByText("The library is empty. Open a PDF to start."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Return to reading", exact: true }),
  ).toHaveCount(0);
  await expect(library).toBeVisible();
});
