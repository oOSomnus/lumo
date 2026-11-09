import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import JSZip from "jszip";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { epubTranslationUnit } from "../shared/epub";
import { handleLibrary } from "./library";
import {
  DocumentNotFoundError,
  openReaderDb,
  PageOutOfRangeError,
  storeDocument,
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
      "/api/documents?name=fixture.pdf&pageCount=2&format=pdf",
      { method: "POST", headers: { "content-type": "application/pdf" }, body: pdfBytes },
    );
    const document = (await upload.json()) as { id: string; name: string };
    expect(upload.status).toBe(200);
    expect(document.name).toBe("fixture.pdf");

    const duplicate = await call(
      ctx,
      "/api/documents?name=again.pdf&pageCount=2&format=pdf",
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

  test("uploads EPUB files with their own MIME type and rejects mismatches", async () => {
    const ctx = setup();
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    zip.file(
      "META-INF/container.xml",
      '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      { compression: "STORE" },
    );
    zip.file(
      "OEBPS/content.opf",
      '<?xml version="1.0"?><package><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>',
      { compression: "STORE" },
    );
    const epubBytes = await zip.generateAsync({ type: "uint8array" });

    const upload = await call(
      ctx,
      "/api/documents?name=book.epub&pageCount=3&format=epub",
      {
        method: "POST",
        headers: { "content-type": "application/epub+zip" },
        body: epubBytes.buffer as ArrayBuffer,
      },
    );
    expect(upload.status).toBe(200);
    const document = (await upload.json()) as {
      id: string;
      format: string;
      pageCount: number;
    };
    expect(document.format).toBe("epub");
    expect(document.pageCount).toBe(1);

    const file = await call(ctx, `/api/documents/${document.id}/file`);
    expect(file.headers.get("content-type")).toBe("application/epub+zip");
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual(
      Array.from(epubBytes),
    );

    await expect(
      call(ctx, "/api/documents?name=book.pdf&pageCount=3&format=pdf", {
        method: "POST",
        headers: { "content-type": "application/pdf" },
        body: epubBytes.buffer as ArrayBuffer,
      }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });

    await expect(
      call(ctx, "/api/documents?name=book.epub&pageCount=3&format=epub", {
        method: "POST",
        headers: { "content-type": "application/pdf" },
        body: epubBytes.buffer as ArrayBuffer,
      }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });

    await expect(
      call(ctx, "/api/documents?name=book.epub&pageCount=3&format=epub", {
        method: "POST",
        headers: { "content-type": "application/epub+zip" },
        body: new TextEncoder().encode("PK\u0003\u0004 not a real epub"),
      }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });
  });

  describe("EPUB package metadata", () => {
    const CONTAINER =
      '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
    const OPF =
      '<?xml version="1.0"?><package><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>';
    // The documented ceiling of a container or package XML file: 2 MiB counted as JavaScript string length, not bytes.
    const MAX_XML_CHARS = 2 * 1024 * 1024;

    async function epubBytes(
      parts: { mimetype?: string; container?: string; opf?: string } = {},
    ): Promise<Uint8Array> {
      const zip = new JSZip();
      // The upload's magic check wants a stored `mimetype` as the first entry.
      zip.file("mimetype", parts.mimetype ?? "application/epub+zip", { compression: "STORE" });
      zip.file("META-INF/container.xml", parts.container ?? CONTAINER, { compression: "DEFLATE" });
      zip.file("OEBPS/content.opf", parts.opf ?? OPF, { compression: "DEFLATE" });
      return zip.generateAsync({ type: "uint8array" });
    }

    /** The magic check reads only the first `mimetype`; the entry the reader finds under that name (the later one wins) is oversized. */
    async function epubWithOversizedMimetype(): Promise<Uint8Array> {
      const zip = new JSZip();
      zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
      zip.file("mimetypf", `application/epub+zip${" ".repeat(1_000_000)}`, { compression: "DEFLATE" });
      zip.file("META-INF/container.xml", CONTAINER, { compression: "DEFLATE" });
      zip.file("OEBPS/content.opf", OPF, { compression: "DEFLATE" });
      const bytes = await zip.generateAsync({ type: "uint8array" });
      // JSZip names entries by their local header, so renaming the second one makes it shadow the first.
      const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      buffer.write("mimetype", buffer.indexOf("mimetypf"));
      return bytes;
    }

    const upload = (ctx: { db: Database; dataDirectory: string }, bytes: Uint8Array) =>
      call(ctx, "/api/documents?name=book.epub&pageCount=1&format=epub", {
        method: "POST",
        headers: { "content-type": "application/epub+zip" },
        body: bytes.buffer as ArrayBuffer,
      });

    /** Appends a comment so the XML is exactly `chars` long; the XML itself may start with a BOM. */
    const padded = (xml: string, chars: number): string =>
      `${xml}<!--${"x".repeat(chars - xml.length - "<!---->".length)}-->`;

    async function storedBooks(ctx: { db: Database; dataDirectory: string }): Promise<number> {
      const library = await call(ctx, "/api/library");
      return ((await library.json()) as { documents: unknown[] }).documents.length;
    }

    test("reads a package whose elements carry namespace prefixes", async () => {
      const ctx = setup();
      const container =
        '<?xml version="1.0"?><ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container"><ocf:rootfiles><ocf:rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></ocf:rootfiles></ocf:container>';
      const opf =
        '<?xml version="1.0"?><opf:package xmlns:opf="http://www.idpf.org/2007/opf"><opf:manifest><opf:item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><opf:item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></opf:manifest><opf:spine><opf:itemref idref="c1"/><opf:itemref idref="c2" linear="no"/></opf:spine></opf:package>';

      const response = await upload(ctx, await epubBytes({ container, opf }));

      expect(response.status).toBe(200);
      expect(((await response.json()) as { pageCount: number }).pageCount).toBe(2);
    });

    test("a prefixed spine entry still has to name a manifest item", async () => {
      const ctx = setup();
      const opf = OPF.replace("</spine>", '<opf:itemref xmlns:opf="http://www.idpf.org/2007/opf" idref="missing"/></spine>');
      await expect(upload(ctx, await epubBytes({ opf }))).rejects.toMatchObject({
        status: 400,
        code: "INVALID_REQUEST",
      });
      expect(await storedBooks(ctx)).toBe(0);
    });

    test("a corrupt compressed metadata entry is a bad request rather than a server error", async () => {
      const ctx = setup();
      const bytes = await epubBytes();
      // The local header precedes the central directory, so the first hit is the entry's own data.
      const start = Buffer.from(bytes).indexOf("META-INF/container.xml") + "META-INF/container.xml".length;
      bytes.fill(0xff, start, start + 8);

      await expect(upload(ctx, bytes)).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });
      expect(await storedBooks(ctx)).toBe(0);
    });

    test("an oversized metadata XML or mimetype is refused and the book is not stored", async () => {
      const ctx = setup();
      for (const bytes of [
        await epubBytes({ opf: padded(OPF, MAX_XML_CHARS + 1) }),
        await epubBytes({ container: padded(CONTAINER, MAX_XML_CHARS + 1) }),
        await epubWithOversizedMimetype(),
      ]) {
        await expect(upload(ctx, bytes)).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });
      }
      expect(await storedBooks(ctx)).toBe(0);
    });

    test("the XML limit counts characters including a BOM", async () => {
      const ctx = setup();
      const accepted = await upload(ctx, await epubBytes({ opf: padded(`\uFEFF${OPF}`, MAX_XML_CHARS) }));
      expect(accepted.status).toBe(200);
      await expect(
        upload(ctx, await epubBytes({ opf: padded(`\uFEFF${OPF}`, MAX_XML_CHARS + 1) })),
      ).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });
    });

    test("the mimetype must match exactly: a leading BOM or whitespace is refused", async () => {
      const ctx = setup();
      // The upload's magic check decodes with a BOM-stripping TextDecoder, so a BOM-prefixed mimetype reaches the package reader.
      for (const mimetype of ["\uFEFFapplication/epub+zip", " application/epub+zip", "application/epub+zip\n"]) {
        await expect(upload(ctx, await epubBytes({ mimetype }))).rejects.toMatchObject({
          status: 400,
          code: "INVALID_REQUEST",
        });
      }
      expect(await storedBooks(ctx)).toBe(0);
    });

    test("accepts CJK metadata that is over 2 MiB in bytes but within the character limit", async () => {
      const ctx = setup();
      const opf = `${OPF}<!--${"字".repeat(900_000)}-->`;
      expect(Buffer.byteLength(opf)).toBeGreaterThan(MAX_XML_CHARS);
      expect(opf.length).toBeLessThan(MAX_XML_CHARS);

      const response = await upload(ctx, await epubBytes({ opf }));

      expect(response.status).toBe(200);
      expect(((await response.json()) as { pageCount: number }).pageCount).toBe(1);
    });
  });

  test("uploads and retrieves a PDF larger than 100 MiB without truncation", async () => {
    const ctx = setup();
    const bytes = new Uint8Array(100 * 1024 * 1024 + 1);
    bytes.set(pdfBytes);
    bytes[bytes.length - 1] = 0x7f;
    const upload = await call(
      ctx,
      "/api/documents?name=large.pdf&pageCount=1&format=pdf",
      { method: "POST", headers: { "content-type": "application/pdf" }, body: bytes },
    );
    expect(upload.status).toBe(200);
    const document = (await upload.json()) as { id: string };
    const file = await call(ctx, `/api/documents/${document.id}/file`);
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).equals(Buffer.from(bytes.buffer))).toBe(true);
  }, 60_000);

  test("rejects non-PDF bodies and invalid upload metadata", async () => {
    const ctx = setup();
    await expect(
      call(ctx, "/api/documents?name=x.pdf&pageCount=1&format=pdf", {
        method: "POST",
        headers: { "content-type": "application/pdf" },
        body: "not a pdf",
      }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });

    await expect(
      call(ctx, "/api/documents?name=x.pdf&pageCount=0&format=pdf", {
        method: "POST",
        headers: { "content-type": "application/pdf" },
        body: pdfBytes,
      }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });

    await expect(
      call(ctx, "/api/documents?name=x.pdf&pageCount=1&format=pdf", {
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
      "/api/documents?name=fixture.pdf&pageCount=2&format=pdf",
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
      body: JSON.stringify({ typst: "# Page", provider: "mock", model: "vision" }),
    });
    expect(saved.status).toBe(200);
    const selection = await call(
      ctx,
      `/api/documents/${document.id}/translations/1/en?unit=sel-a1`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          typst: "# Selection",
          provider: "mock",
          model: "vision",
        }),
      },
    );
    expect(selection.status).toBe(200);
    expect(
      await (
        await call(
          ctx,
          `/api/documents/${document.id}/translations/1/en?unit=sel-a1`,
        )
      ).json(),
    ).toEqual(expect.objectContaining({ unit: "sel-a1", typst: "# Selection" }));
    expect(
      await (
        await call(ctx, `/api/documents/${document.id}/translations/1/en`)
      ).json(),
    ).toEqual(expect.objectContaining({ unit: "", typst: "# Page" }));

    const locations = await call(
      ctx,
      `/api/documents/${document.id}/translation-locations?targetLanguage=en`,
    );
    expect(await locations.json()).toEqual({
      locations: [
        { pageNumber: 1, unit: "" },
        { pageNumber: 1, unit: "sel-a1" },
      ],
    });

    const list = await call(
      ctx,
      `/api/documents/${document.id}/translations?targetLanguage=en`,
    );
    expect(await list.json()).toEqual([
      expect.objectContaining({ pageNumber: 1, unit: "", typst: "# Page" }),
      expect.objectContaining({ pageNumber: 1, unit: "sel-a1", typst: "# Selection" }),
    ]);
  });

  test("saves EPUB translations only under the source range their unit names", async () => {
    const ctx = setup();
    const document = storeDocument(
      ctx.db,
      { name: "book.epub", pageCount: 2, format: "epub" },
      new TextEncoder().encode("PK\u0003\u0004fixture"),
    );
    const sourceCfi = "epubcfi(/6/4!/4/2,/1:0,/1:9)";
    const otherCfi = "epubcfi(/6/8!/4/2,/1:0,/1:9)";
    const unit = await epubTranslationUnit("page", sourceCfi);
    const content = { typst: "# Page", provider: "mock", model: "vision" };
    const save = (query: string, body: object) =>
      call(ctx, `/api/documents/${document.id}/translations/2/en?unit=${query}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const refused = { status: 400, code: "INVALID_REQUEST" };
    await expect(save(unit, content)).rejects.toMatchObject(refused);
    await expect(save(unit, { ...content, sourceCfi: otherCfi })).rejects.toMatchObject(refused);
    await expect(save("", { ...content, sourceCfi })).rejects.toMatchObject(refused);
    expect((await save(unit, { ...content, sourceCfi })).status).toBe(200);

    const read = await call(ctx, `/api/documents/${document.id}/translations/2/en?unit=${unit}`);
    expect(await read.json()).toEqual(expect.objectContaining({ unit, sourceCfi, typst: "# Page" }));
    const locations = await call(
      ctx,
      `/api/documents/${document.id}/translation-locations?targetLanguage=en`,
    );
    expect(await locations.json()).toEqual({ locations: [{ pageNumber: 2, unit, sourceCfi }] });

    const pdf = storeDocument(ctx.db, { name: "doc.pdf", pageCount: 1, format: "pdf" }, pdfBytes);
    await expect(
      call(ctx, `/api/documents/${pdf.id}/translations/1/en`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...content, sourceCfi }),
      }),
    ).rejects.toMatchObject(refused);
  });

  test("stores reading views per document and removes them with the document", async () => {
    const ctx = setup();
    const first = (await (
      await call(ctx, "/api/documents?name=first.pdf&pageCount=3&format=pdf", {
        method: "POST",
        headers: { "content-type": "application/pdf" },
        body: pdfBytes,
      })
    ).json()) as { id: string };
    const secondBytes = new TextEncoder().encode("%PDF-1.7\nsecond\n%%EOF\n");
    const second = (await (
      await call(ctx, "/api/documents?name=second.pdf&pageCount=2&format=pdf", {
        method: "POST",
        headers: { "content-type": "application/pdf" },
        body: secondBytes,
      })
    ).json()) as { id: string };

    const missing = await call(ctx, `/api/documents/${first.id}/view`);
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ view: null });

    const firstView = {
      format: "pdf",
      scaleValue: "page-width",
      rotation: 90,
      scrollMode: 0,
      spreadMode: 2,
    };
    const secondView = {
      format: "pdf",
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
        JSON.stringify({ ...firstView, padding: "x".repeat(20000) }),
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
      "/api/documents?name=outline.pdf&pageCount=3&format=pdf",
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
    ).rejects.toMatchObject({ status: 404, code: "DOCUMENT_NOT_FOUND" });

    await call(ctx, `/api/documents/${document.id}`, { method: "DELETE" });
    await expect(
      call(ctx, `/api/documents/${document.id}/outline`),
    ).rejects.toMatchObject({ status: 404, code: "DOCUMENT_NOT_FOUND" });
  });
});
