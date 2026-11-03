import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLibrary } from "./library";
import {
  DocumentNotFoundError,
  openReaderDb,
  PageOutOfRangeError,
} from "./storage";

const directories: string[] = [];
const databases: Database[] = [];
const origin = "http://127.0.0.1:1234";

function setup(): { db: Database; dataDirectory: string } {
  const directory = mkdtempSync(join(tmpdir(), "lumo-library-"));
  directories.push(directory);
  const db = openReaderDb(directory);
  databases.push(db);
  return { db, dataDirectory: directory };
}

function call(
  ctx: { db: Database; dataDirectory: string },
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return handleLibrary(
    new Request(`${origin}${path}`, init),
    new URL(`${origin}${path}`),
    ctx,
  );
}

const pdfBytes = new TextEncoder().encode("%PDF-1.7\nfixture\n%%EOF\n");

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("handleLibrary", () => {
  test("uploads a PDF once, serves its bytes, and deletes it", async () => {
    const ctx = setup();
    const upload = await call(
      ctx,
      "/api/documents?name=fixture.pdf&pageCount=2",
      { method: "POST", headers: { "content-type": "application/pdf" }, body: pdfBytes },
    );
    const document = (await upload.json()) as { id: string; name: string };
    expect(upload.status).toBe(200);
    expect(document.name).toBe("fixture.pdf");

    const duplicate = await call(
      ctx,
      "/api/documents?name=again.pdf&pageCount=2",
      { method: "POST", headers: { "content-type": "application/pdf" }, body: pdfBytes },
    );
    const second = (await duplicate.json()) as { id: string; name: string };
    expect(second.id).toBe(document.id);
    expect(second.name).toBe("fixture.pdf");

    const file = await call(ctx, `/api/documents/${document.id}/file`);
    expect(file.headers.get("content-type")).toBe("application/pdf");
    expect(file.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(pdfBytes);

    const remove = await call(ctx, `/api/documents/${document.id}`, { method: "DELETE" });
    expect(remove.status).toBe(204);
    await expect(
      call(ctx, `/api/documents/${document.id}/file`),
    ).rejects.toMatchObject({ status: 404, code: "DOCUMENT_NOT_FOUND" });
  });

  test("rejects non-PDF bodies and invalid upload metadata", async () => {
    const ctx = setup();
    await expect(
      call(ctx, "/api/documents?name=x.pdf&pageCount=1", {
        method: "POST",
        headers: { "content-type": "application/pdf" },
        body: "not a pdf",
      }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });

    await expect(
      call(ctx, "/api/documents?name=x.pdf&pageCount=0", {
        method: "POST",
        headers: { "content-type": "application/pdf" },
        body: pdfBytes,
      }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });

    await expect(
      call(ctx, "/api/documents?name=x.pdf&pageCount=1", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: pdfBytes,
      }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });
  });

  test("updates reader settings and reads translations for a language", async () => {
    const ctx = setup();
    const upload = await call(
      ctx,
      "/api/documents?name=fixture.pdf&pageCount=2",
      { method: "POST", headers: { "content-type": "application/pdf" }, body: pdfBytes },
    );
    const document = (await upload.json()) as { id: string };

    const update = await call(ctx, "/api/reader", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ documentId: document.id, pageNumber: 2, targetLanguage: "en" }),
    });
    expect(await update.json()).toEqual({ lastDocumentId: document.id, targetLanguage: "en" });

    const saved = await call(ctx, `/api/documents/${document.id}/translations/1/en`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown: "# Page", provider: "mock", model: "vision" }),
    });
    expect(saved.status).toBe(200);

    const pages = await call(
      ctx,
      `/api/documents/${document.id}/translation-pages?targetLanguage=en`,
    );
    expect(await pages.json()).toEqual({ pages: [1] });

    const list = await call(
      ctx,
      `/api/documents/${document.id}/translations?targetLanguage=en`,
    );
    expect(await list.json()).toEqual([
      expect.objectContaining({ pageNumber: 1, markdown: "# Page" }),
    ]);
  });

  test("stores reading views per document and removes them with the document", async () => {
    const ctx = setup();
    const first = (await (
      await call(ctx, "/api/documents?name=first.pdf&pageCount=3", {
        method: "POST",
        headers: { "content-type": "application/pdf" },
        body: pdfBytes,
      })
    ).json()) as { id: string };
    const secondBytes = new TextEncoder().encode("%PDF-1.7\nsecond\n%%EOF\n");
    const second = (await (
      await call(ctx, "/api/documents?name=second.pdf&pageCount=2", {
        method: "POST",
        headers: { "content-type": "application/pdf" },
        body: secondBytes,
      })
    ).json()) as { id: string };

    const missing = await call(ctx, `/api/documents/${first.id}/view`);
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ view: null });

    const firstView = {
      scaleValue: "page-width",
      rotation: 90,
      scrollMode: 0,
      spreadMode: 2,
    };
    const secondView = {
      scaleValue: "1.25",
      rotation: 0,
      scrollMode: 3,
      spreadMode: 0,
    };
    const putView = (documentId: string, body: string) =>
      call(ctx, `/api/documents/${documentId}/view`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
      });

    const savedFirst = await putView(first.id, JSON.stringify(firstView));
    expect(savedFirst.status).toBe(200);
    expect(await savedFirst.json()).toEqual({ view: firstView });
    await putView(second.id, JSON.stringify(secondView));

    expect(
      await (await call(ctx, `/api/documents/${first.id}/view`)).json(),
    ).toEqual({ view: firstView });
    expect(
      await (await call(ctx, `/api/documents/${second.id}/view`)).json(),
    ).toEqual({ view: secondView });

    await expect(
      putView(first.id, JSON.stringify({ ...firstView, scaleValue: "125" })),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });
    expect(
      await (await call(ctx, `/api/documents/${first.id}/view`)).json(),
    ).toEqual({ view: firstView });

    await expect(
      putView(
        first.id,
        JSON.stringify({ ...firstView, padding: "x".repeat(2048) }),
      ),
    ).rejects.toMatchObject({ status: 413, code: "PAYLOAD_TOO_LARGE" });

    await expect(
      call(ctx, `/api/documents/${"c".repeat(64)}/view`),
    ).rejects.toBeInstanceOf(DocumentNotFoundError);
    await expect(
      putView("c".repeat(64), JSON.stringify(firstView)),
    ).rejects.toBeInstanceOf(DocumentNotFoundError);
    await expect(
      call(ctx, "/api/documents/not-a-digest/view"),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });

    const removed = await call(ctx, `/api/documents/${first.id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(204);
    await expect(
      call(ctx, `/api/documents/${first.id}/view`),
    ).rejects.toBeInstanceOf(DocumentNotFoundError);
    expect(
      await (await call(ctx, `/api/documents/${second.id}/view`)).json(),
    ).toEqual({ view: secondView });
  });
});

describe("generated outline route", () => {
  const outline = [
    { title: "A", level: 1, pageNumber: 1 },
    { title: "A.1", level: 2, pageNumber: 2 },
    { title: "B", level: 1, pageNumber: 3 },
  ];

  test("reads, saves and removes an outline with its document", async () => {
    const ctx = setup();
    const upload = await call(
      ctx,
      "/api/documents?name=outline.pdf&pageCount=3",
      { method: "POST", headers: { "content-type": "application/pdf" }, body: pdfBytes },
    );
    const document = (await upload.json()) as { id: string };

    const empty = await call(ctx, `/api/documents/${document.id}/outline`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ outline: null });

    const put = await call(ctx, `/api/documents/${document.id}/outline`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(outline),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ outline });

    const read = await call(ctx, `/api/documents/${document.id}/outline`);
    expect(await read.json()).toEqual({ outline });

    await expect(
      call(ctx, `/api/documents/${document.id}/outline`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([]),
      }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });
    await expect(
      call(ctx, `/api/documents/${document.id}/outline`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([{ title: "Outside", level: 1, pageNumber: 4 }]),
      }),
    ).rejects.toBeInstanceOf(PageOutOfRangeError);
    expect(
      await (await call(ctx, `/api/documents/${document.id}/outline`)).json(),
    ).toEqual({ outline });

    await expect(
      call(ctx, `/api/documents/${document.id}/outline`, { method: "DELETE" }),
    ).rejects.toMatchObject({ status: 405, code: "METHOD_NOT_ALLOWED" });
    await expect(
      call(ctx, `/api/documents/${"c".repeat(64)}/outline`),
    ).rejects.toBeInstanceOf(DocumentNotFoundError);

    await call(ctx, `/api/documents/${document.id}`, { method: "DELETE" });
    await expect(
      call(ctx, `/api/documents/${document.id}/outline`),
    ).rejects.toBeInstanceOf(DocumentNotFoundError);
  });
});
