import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AiConfig,
  OutlineEntry,
  ReaderView,
  TargetLanguage,
  TranslationContent,
} from "../shared/contracts";
import {
  DB_FILENAME,
  DocumentNotFoundError,
  getAppSettings,
  getDocument,
  getDocumentFile,
  getGeneratedOutline,
  getReaderView,
  getSettings,
  getTranslation,
  getUiLocale,
  listDocuments,
  listTranslatedPages,
  listTranslations,
  openReaderDb,
  removeDocument,
  resolveDataDirectory,
  saveAiConfig,
  saveGeneratedOutline,
  saveReaderView,
  saveTranslation,
  saveUiLocale,
  SCHEMA_VERSION,
  storeDocument,
  StoredAiConfigError,
  updateReaderSettings,
} from "./storage";

const directories: string[] = [];
const databases: Database[] = [];

function tempDb(): Database {
  const directory = mkdtempSync(join(tmpdir(), "lumo-storage-"));
  directories.push(directory);
  const db = openReaderDb(directory);
  databases.push(db);
  return db;
}

function content(markdown: string): TranslationContent {
  return { markdown, provider: "mock", model: "vision" };
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("resolveDataDirectory", () => {
  test("prefers an absolute LUMO_DATA_DIR, then absolute XDG_DATA_HOME, then the home fallback", () => {
    expect(resolveDataDirectory({ LUMO_DATA_DIR: "/data/lumo" }, "/home/me")).toBe("/data/lumo");
    expect(
      resolveDataDirectory({ XDG_DATA_HOME: "/home/me/.xdg" }, "/home/me"),
    ).toBe("/home/me/.xdg/lumo");
    expect(resolveDataDirectory({}, "/home/me")).toBe("/home/me/.local/share/lumo");
    expect(
      resolveDataDirectory({ XDG_DATA_HOME: "relative/dir" }, "/home/me"),
    ).toBe("/home/me/.local/share/lumo");
  });

  test("rejects a relative explicit data directory", () => {
    expect(() => resolveDataDirectory({ LUMO_DATA_DIR: "relative" }, "/home/me")).toThrow(
      "must be an absolute path",
    );
  });
});

describe("storage", () => {
  test("stores documents once, deduplicating identical bytes", () => {
    const db = tempDb();
    const bytes = new TextEncoder().encode("%PDF-1.7 sample");
    const first = storeDocument(db, { name: "first.pdf", pageCount: 2 }, bytes);
    const second = storeDocument(db, { name: "renamed.pdf", pageCount: 2 }, bytes);

    expect(second.id).toBe(first.id);
    expect(second.name).toBe("first.pdf");
    expect(second.size).toBe(bytes.byteLength);
    expect(listDocuments(db)).toHaveLength(1);
    expect(getDocumentFile(db, first.id)).toEqual({ name: "first.pdf", data: bytes });
  });

  test("saves translations and rejects pages outside the document", () => {
    const db = tempDb();
    const document = storeDocument(
      db,
      { name: "doc.pdf", pageCount: 2 },
      new TextEncoder().encode("%PDF-1.7 two pages"),
    );

    saveTranslation(db, { documentId: document.id, pageNumber: 1, targetLanguage: "en" }, content("# one"));
    saveTranslation(db, { documentId: document.id, pageNumber: 2, targetLanguage: "en" }, content("# two"));
    saveTranslation(db, { documentId: document.id, pageNumber: 1, targetLanguage: "ja" }, content("# 一"));

    expect(getTranslation(db, { documentId: document.id, pageNumber: 1, targetLanguage: "en" })?.markdown).toBe("# one");
    expect(listTranslations(db, document.id, "en").map((item) => item.pageNumber)).toEqual([1, 2]);
    expect(listTranslatedPages(db, document.id, "ja")).toEqual([1]);

    expect(() =>
      saveTranslation(db, { documentId: document.id, pageNumber: 3, targetLanguage: "en" }, content("# three")),
    ).toThrow();
  });

  test("refuses foreign tables without a schema version", () => {
    const directory = mkdtempSync(join(tmpdir(), "lumo-storage-"));
    directories.push(directory);
    const raw = new Database(join(directory, DB_FILENAME));
    raw.exec("CREATE TABLE documents (id TEXT)");
    raw.close();

    expect(() => openReaderDb(directory)).toThrow();
  });

  test("refuses schema version 3 and unknown versions without touching their data", () => {
    const bytes = new TextEncoder().encode("%PDF-1.7 kept intact");
    for (const version of [3, SCHEMA_VERSION + 1]) {
      const directory = mkdtempSync(join(tmpdir(), "lumo-storage-"));
      directories.push(directory);
      const path = join(directory, DB_FILENAME);
      const db = openReaderDb(directory);
      const document = storeDocument(
        db,
        { name: "kept.pdf", pageCount: 1 },
        bytes,
      );
      db.close();

      const raw = new Database(path);
      raw.exec(`PRAGMA user_version = ${version}`);
      raw.close();

      expect(() => openReaderDb(directory)).toThrow();

      const check = new Database(path);
      expect(check.query("PRAGMA user_version").get()).toEqual({
        user_version: version,
      });
      expect(check.query("SELECT id, name FROM documents").get()).toEqual({
        id: document.id,
        name: "kept.pdf",
      });
      expect(check.query("SELECT hex(data) AS data FROM files").get()).toEqual({
        data: Buffer.from(bytes).toString("hex").toUpperCase(),
      });
      check.close();
    }
  });

  test("keeps the device id stable after reopening a current-format database", () => {
    const directory = mkdtempSync(join(tmpdir(), "lumo-storage-"));
    directories.push(directory);
    const db = openReaderDb(directory);
    databases.push(db);
    const firstId = getAppSettings(db).deviceId;
    db.close();
    databases.splice(databases.indexOf(db), 1);

    const reopened = openReaderDb(directory);
    databases.push(reopened);
    expect(getAppSettings(reopened).deviceId).toBe(firstId);
  });

  test("rejects a malformed stored language without rewriting it", () => {
    const db = tempDb();
    db.exec("UPDATE settings SET targetLanguage = 'not-a-language' WHERE key = 'reader'");

    expect(() => getSettings(db)).toThrow("stored target language is invalid");
    expect(() =>
      updateReaderSettings(db, {
        documentId: null,
        pageNumber: null,
        targetLanguage: "not-a-language" as TargetLanguage,
      }),
    ).toThrow();
    expect(
      db.query("SELECT targetLanguage FROM settings WHERE key = 'reader'").get(),
    ).toEqual({ targetLanguage: "not-a-language" });
  });

  test("serializes locale, AI config and reader writes without losing fields", () => {
    const db = tempDb();
    const config: AiConfig = {
      provider: "openai",
      model: "gpt-5.4-mini",
      reasoningEffort: "high",
    };
    saveUiLocale(db, "zh-CN");
    saveAiConfig(db, config);
    updateReaderSettings(db, { documentId: null, pageNumber: 1, targetLanguage: "ja" });
    expect(getUiLocale(db)).toBe("zh-CN");
    expect(getSettings(db).targetLanguage).toBe("ja");

    const settings = getAppSettings(db);
    expect(settings.aiConfig).toEqual(config);
  });

  test("reports a malformed stored AI config without hiding the library", () => {
    const db = tempDb();
    db.exec("UPDATE app_settings SET aiConfig = '{broken' WHERE key = 'app'");
    expect(() => getAppSettings(db)).toThrow(StoredAiConfigError);
    expect(listDocuments(db)).toEqual([]);
    expect(getUiLocale(db)).toBe("en");
  });

  test("reports a busy writer instead of pretending the write succeeded", () => {
    const directory = mkdtempSync(join(tmpdir(), "lumo-storage-"));
    directories.push(directory);
    const db = openReaderDb(directory);
    databases.push(db);
    const second = openReaderDb(directory);
    databases.push(second);
    const document = storeDocument(
      db,
      { name: "doc.pdf", pageCount: 1 },
      new TextEncoder().encode("%PDF-1.7 locked writer"),
    );
    second.exec("PRAGMA busy_timeout = 20");
    db.exec("BEGIN IMMEDIATE");
    try {
      expect(() =>
        updateReaderSettings(second, {
          documentId: document.id,
          pageNumber: 1,
          targetLanguage: "en",
        }),
      ).toThrow();
    } finally {
      db.exec("ROLLBACK");
    }
    expect(
      updateReaderSettings(second, {
        documentId: document.id,
        pageNumber: 1,
        targetLanguage: "en",
      }).lastDocumentId,
    ).toBe(document.id);
  });

  test("stores a reading view with its document across reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "lumo-storage-"));
    directories.push(directory);
    const db = openReaderDb(directory);
    databases.push(db);
    const document = storeDocument(
      db,
      { name: "doc.pdf", pageCount: 2 },
      new TextEncoder().encode("%PDF-1.7 view persistence"),
    );
    expect(getReaderView(db, document.id)).toBeNull();

    const view: ReaderView = {
      scaleValue: "page-width",
      rotation: 90,
      scrollMode: 0,
      spreadMode: 2,
    };
    expect(saveReaderView(db, document.id, view)).toEqual(view);

    db.close();
    databases.splice(databases.indexOf(db), 1);
    const reopened = openReaderDb(directory);
    databases.push(reopened);
    expect(getReaderView(reopened, document.id)).toEqual(view);
  });

  test("rejects invalid or failed reading view writes without replacing the stored value", () => {
    const db = tempDb();
    const document = storeDocument(
      db,
      { name: "doc.pdf", pageCount: 2 },
      new TextEncoder().encode("%PDF-1.7 view failures"),
    );
    const view: ReaderView = {
      scaleValue: "page-width",
      rotation: 90,
      scrollMode: 0,
      spreadMode: 2,
    };
    saveReaderView(db, document.id, view);

    expect(() =>
      saveReaderView(db, document.id, { ...view, scaleValue: "125" }),
    ).toThrow();
    db.exec("PRAGMA query_only = ON");
    try {
      expect(() =>
        saveReaderView(db, document.id, { ...view, rotation: 180 }),
      ).toThrow();
    } finally {
      db.exec("PRAGMA query_only = OFF");
    }
    expect(getReaderView(db, document.id)).toEqual(view);
  });

  test("rejects a corrupted stored reading view without rewriting it", () => {
    const db = tempDb();
    const document = storeDocument(
      db,
      { name: "doc.pdf", pageCount: 2 },
      new TextEncoder().encode("%PDF-1.7 corrupted view"),
    );
    for (const stored of ["{broken", JSON.stringify({ rotation: 0 })]) {
      db.query("UPDATE documents SET readerView = ? WHERE id = ?").run(
        stored,
        document.id,
      );
      expect(() => getReaderView(db, document.id)).toThrow(
        "stored reading view is invalid",
      );
      expect(
        db
          .query("SELECT readerView FROM documents WHERE id = ?")
          .get(document.id),
      ).toEqual({ readerView: stored });
    }
  });

  test("updates reader settings and clears the pointer when a document is deleted", () => {
    const db = tempDb();
    const document = storeDocument(
      db,
      { name: "doc.pdf", pageCount: 3 },
      new TextEncoder().encode("%PDF-1.7 settings"),
    );

    const settings = updateReaderSettings(db, {
      documentId: document.id,
      pageNumber: 3,
      targetLanguage: "ja",
    });
    expect(settings).toEqual({ lastDocumentId: document.id, targetLanguage: "ja" });
    expect(getDocument(db, document.id)?.currentPage).toBe(3);

    saveTranslation(db, { documentId: document.id, pageNumber: 1, targetLanguage: "ja" }, content("# 一"));
    expect(removeDocument(db, document.id)).toBe(true);
    expect(getDocument(db, document.id)).toBeNull();
    expect(getTranslation(db, { documentId: document.id, pageNumber: 1, targetLanguage: "ja" })).toBeNull();
    expect(getSettings(db)).toEqual({ lastDocumentId: null, targetLanguage: "ja" });
  });
});

describe("generated outline storage", () => {
  const outline: OutlineEntry[] = [
    { title: "A", level: 1, pageNumber: 2 },
    { title: "A.1", level: 2, pageNumber: 2 },
    { title: "B", level: 1, pageNumber: 4 },
  ];

  test("stores a generated outline across reopen and removes it with the document", () => {
    const directory = mkdtempSync(join(tmpdir(), "lumo-storage-"));
    directories.push(directory);
    const db = openReaderDb(directory);
    databases.push(db);
    const document = storeDocument(
      db,
      { name: "outline.pdf", pageCount: 5 },
      new TextEncoder().encode("%PDF-1.7 generated outline"),
    );
    expect(getGeneratedOutline(db, document.id)).toBeNull();
    expect(saveGeneratedOutline(db, document.id, outline)).toEqual(outline);

    db.close();
    databases.splice(databases.indexOf(db), 1);
    const reopened = openReaderDb(directory);
    databases.push(reopened);
    expect(getGeneratedOutline(reopened, document.id)).toEqual(outline);
    expect(removeDocument(reopened, document.id)).toBe(true);
    expect(() => getGeneratedOutline(reopened, document.id)).toThrow(
      DocumentNotFoundError,
    );
  });

  test("rejects invalid or failed writes without replacing the stored outline", () => {
    const db = tempDb();
    const document = storeDocument(
      db,
      { name: "outline.pdf", pageCount: 5 },
      new TextEncoder().encode("%PDF-1.7 outline failures"),
    );
    saveGeneratedOutline(db, document.id, outline);

    expect(() => saveGeneratedOutline(db, document.id, [])).toThrow();
    expect(() =>
      saveGeneratedOutline(db, document.id, [
        { title: "Outside", level: 1, pageNumber: 6 },
      ]),
    ).toThrow();
    expect(() =>
      saveGeneratedOutline(db, document.id, [
        { title: "Skip", level: 2, pageNumber: 1 },
      ]),
    ).toThrow();
    expect(() =>
      saveGeneratedOutline(db, "b".repeat(64), outline),
    ).toThrow(DocumentNotFoundError);

    db.exec("PRAGMA query_only = ON");
    try {
      expect(() =>
        saveGeneratedOutline(db, document.id, [
          { title: "Changed", level: 1, pageNumber: 1 },
        ]),
      ).toThrow();
    } finally {
      db.exec("PRAGMA query_only = OFF");
    }
    expect(getGeneratedOutline(db, document.id)).toEqual(outline);
  });

  test("rejects a corrupted stored outline without rewriting it", () => {
    const db = tempDb();
    const document = storeDocument(
      db,
      { name: "outline.pdf", pageCount: 5 },
      new TextEncoder().encode("%PDF-1.7 corrupted outline"),
    );
    const stored = [
      "{broken",
      JSON.stringify({ headings: [] }),
      JSON.stringify([{ title: "Outside", level: 1, pageNumber: 6 }]),
      JSON.stringify([
        { title: "A", level: 1, pageNumber: 2 },
        { title: "Back", level: 1, pageNumber: 1 },
      ]),
    ];
    for (const value of stored) {
      db.query("UPDATE documents SET generatedOutline = ? WHERE id = ?").run(
        value,
        document.id,
      );
      expect(() => getGeneratedOutline(db, document.id)).toThrow(
        "stored generated outline is invalid",
      );
      expect(
        db
          .query("SELECT generatedOutline FROM documents WHERE id = ?")
          .get(document.id),
      ).toEqual({ generatedOutline: value });
    }
  });
});
