import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
  DocumentMetadataConflictError,
  DocumentNotFoundError,
  ReaderViewFormatError,
  getAppSettings,
  getDocument,
  getDocumentFile,
  clearImportedOutline,
  getImportedOutline,
  getReaderView,
  getSettings,
  getTranslation,
  getTheme,
  getUiLocale,
  listDocuments,
  listTranslationLocations,
  listTranslations,
  openReaderDb,
  ReaderUpgradeRequiredError,
  removeDocument,
  resolveDataDirectory,
  saveAiConfig,
  saveImportedOutline,
  saveReaderView,
  saveTheme,
  saveTranslation,
  saveUiLocale,
  SCHEMA_VERSION,
  UPGRADABLE_SCHEMA_VERSION,
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

function content(typst: string): TranslationContent {
  return { typst, provider: "mock", model: "vision" };
}

/** Every file of a data directory by name, except SQLite's shared-memory index, which is rebuilt on every open. */
function snapshot(directory: string): Map<string, Buffer> {
  return new Map(
    readdirSync(directory)
      .filter((name) => !name.endsWith("-shm"))
      .sort()
      .map((name) => [name, readFileSync(join(directory, name))]),
  );
}

/** A copy of the data directory of an instance that was still running: its newest pages exist only in the WAL file. */
function liveWalCopy(version: number): string {
  const live = mkdtempSync(join(tmpdir(), "lumo-storage-"));
  const copy = mkdtempSync(join(tmpdir(), "lumo-storage-"));
  directories.push(live, copy);
  const db = openReaderDb(live);
  try {
    db.exec("PRAGMA wal_autocheckpoint = 0");
    storeDocument(
      db,
      { name: "kept.pdf", pageCount: 1, format: "pdf" },
      new TextEncoder().encode("%PDF-1.7 kept intact"),
    );
    db.exec(`PRAGMA user_version = ${version}`);
    for (const name of readdirSync(live)) copyFileSync(join(live, name), join(copy, name));
  } finally {
    db.close();
  }
  expect(readdirSync(copy)).toContain(`${DB_FILENAME}-wal`);
  return copy;
}

const previousOutline: OutlineEntry[] = [
  { title: "Kept", level: 1, pageNumber: 1 },
];

/** The previous schema's EPUB view, which still carried a per-book colour theme. */
const previousEpubView = {
  format: "epub",
  cfi: "epubcfi(/6/4!/4/2/2)",
  fontSize: 20,
  fontFamily: "sans-serif",
  lineHeight: 1.8,
  theme: "sepia",
};

/** Rewrites app_settings as the previous schema had it, with no theme column; `uiLocale: false` also drops the language. */
function previousAppSettings(raw: Database, { uiLocale = true }: { uiLocale?: boolean } = {}): void {
  const locale = uiLocale ? "uiLocale TEXT NOT NULL CHECK (uiLocale IN ('en', 'zh-CN'))," : "";
  raw.exec(`
    ALTER TABLE app_settings RENAME TO app_settings_current;
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY NOT NULL CHECK (key = 'app'),
      ${locale}
      aiConfig TEXT,
      deviceId TEXT NOT NULL
    ) STRICT;
    INSERT INTO app_settings SELECT key, ${uiLocale ? "uiLocale, " : ""}aiConfig, deviceId FROM app_settings_current;
    DROP TABLE app_settings_current;
  `);
}

/**
 * A data directory holding a database of the previous schema, with a PDF and its translation and
 * outline, an EPUB whose view still names a theme, and the interface language set to `uiLocale`.
 */
function previousSchemaDirectory(uiLocale: "en" | "zh-CN" = "zh-CN"): string {
  const directory = mkdtempSync(join(tmpdir(), "lumo-storage-"));
  directories.push(directory);
  const db = openReaderDb(directory);
  const document = storeDocument(
    db,
    { name: "kept.pdf", pageCount: 1, format: "pdf" },
    new TextEncoder().encode("%PDF-1.7 kept for the upgrade"),
  );
  saveTranslation(db, { documentId: document.id, pageNumber: 1, targetLanguage: "en" }, content("= Kept"));
  saveImportedOutline(db, document.id, previousOutline);
  const book = storeDocument(
    db,
    { name: "kept.epub", pageCount: 3, format: "epub" },
    new TextEncoder().encode("PK kept epub for the upgrade"),
  );
  saveUiLocale(db, uiLocale);
  db.close();
  const raw = new Database(join(directory, DB_FILENAME));
  previousAppSettings(raw);
  raw.query("UPDATE documents SET readerView = ? WHERE id = ?").run(JSON.stringify(previousEpubView), book.id);
  raw.exec(`PRAGMA user_version = ${UPGRADABLE_SCHEMA_VERSION}`);
  raw.exec("PRAGMA journal_mode = DELETE");
  raw.close();
  return directory;
}

function schemaOf(db: Database): unknown[] {
  return db
    .query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
    .all();
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
    ).toBe(join("/home/me/.xdg", "lumo"));
    expect(resolveDataDirectory({}, "/home/me")).toBe(join("/home/me", ".local", "share", "lumo"));
    expect(
      resolveDataDirectory({ XDG_DATA_HOME: "relative/dir" }, "/home/me"),
    ).toBe(join("/home/me", ".local", "share", "lumo"));
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
    const first = storeDocument(db, { name: "first.pdf", pageCount: 2, format: "pdf" }, bytes);
    const second = storeDocument(db, { name: "renamed.pdf", pageCount: 2, format: "pdf" }, bytes);

    expect(second.id).toBe(first.id);
    expect(second.name).toBe("first.pdf");
    expect(second.size).toBe(bytes.byteLength);
    expect(listDocuments(db)).toHaveLength(1);
    expect(getDocumentFile(db, first.id)).toEqual({ name: "first.pdf", data: bytes, format: "pdf" });
  });

  test("stores EPUB documents and rejects conflicting metadata for the same bytes", () => {
    const db = tempDb();
    const bytes = new TextEncoder().encode("PK-epub-sample");
    const first = storeDocument(
      db,
      { name: "book.epub", pageCount: 3, format: "epub" },
      bytes,
    );
    expect(first.format).toBe("epub");
    expect(getDocumentFile(db, first.id)).toEqual({
      name: "book.epub",
      data: bytes,
      format: "epub",
    });

    expect(() =>
      storeDocument(
        db,
        { name: "book.pdf", pageCount: 3, format: "pdf" },
        bytes,
      ),
    ).toThrow(DocumentMetadataConflictError);
    expect(() =>
      storeDocument(
        db,
        { name: "book.epub", pageCount: 4, format: "epub" },
        bytes,
      ),
    ).toThrow(DocumentMetadataConflictError);

    expect(getDocument(db, first.id)).toMatchObject({
      format: "epub",
      pageCount: 3,
    });
  });

  test("saves translations and rejects pages outside the document", () => {
    const db = tempDb();
    const document = storeDocument(
      db,
      { name: "doc.pdf", pageCount: 2, format: "pdf" },
      new TextEncoder().encode("%PDF-1.7 two pages"),
    );

    saveTranslation(db, { documentId: document.id, pageNumber: 1, targetLanguage: "en" }, content("# one"));
    saveTranslation(db, { documentId: document.id, pageNumber: 2, targetLanguage: "en" }, content("# two"));
    saveTranslation(db, { documentId: document.id, pageNumber: 1, targetLanguage: "ja" }, content("# 一"));

    expect(getTranslation(db, { documentId: document.id, pageNumber: 1, targetLanguage: "en" })?.typst).toBe("# one");
    expect(listTranslations(db, document.id, "en").map((item) => item.pageNumber)).toEqual([1, 2]);
    expect(listTranslationLocations(db, document.id, "ja")).toEqual([{ pageNumber: 1, unit: "" }]);

    expect(() =>
      saveTranslation(db, { documentId: document.id, pageNumber: 3, targetLanguage: "en" }, content("# three")),
    ).toThrow();
  });

  test("stores section and selection translations for the same page separately", () => {
    const db = tempDb();
    const document = storeDocument(
      db,
      { name: "book.epub", pageCount: 2, format: "epub" },
      new TextEncoder().encode("PK\u0003\u0004fixture"),
    );
    const section = { documentId: document.id, pageNumber: 1, targetLanguage: "en" as const };
    saveTranslation(db, { ...section, unit: "" }, content("# section"));
    saveTranslation(db, { ...section, unit: "sel-a1" }, content("# selection"));

    expect(getTranslation(db, { ...section, unit: "" })?.typst).toBe("# section");
    expect(getTranslation(db, { ...section, unit: "sel-a1" })?.typst).toBe(
      "# selection",
    );
    expect(listTranslations(db, document.id, "en")).toHaveLength(2);
    expect(listTranslationLocations(db, document.id, "en")).toEqual([
      { pageNumber: 1, unit: "" },
      { pageNumber: 1, unit: "sel-a1" },
    ]);
  });

  test("keeps an EPUB translation's source range across reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "lumo-storage-"));
    directories.push(directory);
    const db = openReaderDb(directory);
    databases.push(db);
    const epub = storeDocument(
      db,
      { name: "book.epub", pageCount: 2, format: "epub" },
      new TextEncoder().encode("PK\u0003\u0004range"),
    );
    const pdf = storeDocument(
      db,
      { name: "doc.pdf", pageCount: 1, format: "pdf" },
      new TextEncoder().encode("%PDF-1.7 range"),
    );
    const unit = `page-${"a".repeat(64)}`;
    const sourceCfi = "epubcfi(/6/4!/4/2,/1:0,/1:9)";
    saveTranslation(
      db,
      { documentId: epub.id, pageNumber: 2, targetLanguage: "en", unit, sourceCfi },
      content("# range"),
    );
    saveTranslation(db, { documentId: pdf.id, pageNumber: 1, targetLanguage: "en" }, content("# page"));

    db.close();
    databases.splice(databases.indexOf(db), 1);
    const reopened = openReaderDb(directory);
    databases.push(reopened);
    expect(
      getTranslation(reopened, { documentId: epub.id, pageNumber: 2, targetLanguage: "en", unit }),
    ).toMatchObject({ sourceCfi });
    expect(listTranslationLocations(reopened, epub.id, "en")).toEqual([
      { pageNumber: 2, unit, sourceCfi },
    ]);
    expect(
      getTranslation(reopened, { documentId: pdf.id, pageNumber: 1, targetLanguage: "en" })?.sourceCfi,
    ).toBeUndefined();
    expect(listTranslationLocations(reopened, pdf.id, "en")).toEqual([{ pageNumber: 1, unit: "" }]);
  });

  test("refuses foreign tables without a schema version", () => {
    const directory = mkdtempSync(join(tmpdir(), "lumo-storage-"));
    directories.push(directory);
    const raw = new Database(join(directory, DB_FILENAME));
    raw.exec("CREATE TABLE documents (id TEXT)");
    raw.close();

    expect(() => openReaderDb(directory)).toThrow();
  });

  test("refuses older and unknown schema versions without touching their data", () => {
    const bytes = new TextEncoder().encode("%PDF-1.7 kept intact");
    for (const version of [3, 4, 5, 6, SCHEMA_VERSION + 1]) {
      const directory = mkdtempSync(join(tmpdir(), "lumo-storage-"));
      directories.push(directory);
      const path = join(directory, DB_FILENAME);
      const db = openReaderDb(directory);
      const document = storeDocument(
        db,
        { name: "kept.pdf", pageCount: 1, format: "pdf" },
        bytes,
      );
      db.close();

      const raw = new Database(path);
      raw.exec(`PRAGMA user_version = ${version}`);
      raw.close();

      const before = snapshot(directory);
      expect(() => openReaderDb(directory)).toThrow();
      expect(snapshot(directory)).toEqual(before);

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

  test("refuses an older database byte for byte untouched when its newest pages are still in the WAL", () => {
    for (const version of [UPGRADABLE_SCHEMA_VERSION - 1, UPGRADABLE_SCHEMA_VERSION]) {
      const copy = liveWalCopy(version);
      const before = snapshot(copy);

      expect(() => openReaderDb(copy)).toThrow();
      expect(snapshot(copy)).toEqual(before);
    }
  });

  test("recovers the pages a current database still has in its WAL", () => {
    const db = openReaderDb(liveWalCopy(SCHEMA_VERSION));
    databases.push(db);

    expect(listDocuments(db).map((document) => document.name)).toEqual(["kept.pdf"]);
  });

  test("asks before upgrading the previous schema and leaves it untouched until then", () => {
    const directory = previousSchemaDirectory();
    const before = snapshot(directory);

    expect(() => openReaderDb(directory)).toThrow(ReaderUpgradeRequiredError);
    expect(() => openReaderDb(directory, { upgrade: false })).toThrow(ReaderUpgradeRequiredError);
    expect(snapshot(directory)).toEqual(before);
  });

  test("reports the stored interface language when it asks for an upgrade, without writing", () => {
    for (const uiLocale of ["en", "zh-CN"] as const) {
      const directory = previousSchemaDirectory(uiLocale);
      const before = snapshot(directory);
      let caught: unknown;
      try {
        openReaderDb(directory);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ReaderUpgradeRequiredError);
      expect((caught as ReaderUpgradeRequiredError).uiLocale).toBe(uiLocale);
      expect(snapshot(directory)).toEqual(before);
    }
  });

  test("asks for an upgrade without a language when the stored one is unreadable", () => {
    const directory = previousSchemaDirectory();
    const raw = new Database(join(directory, DB_FILENAME));
    raw.exec("ALTER TABLE app_settings DROP COLUMN uiLocale");
    raw.close();

    let caught: unknown;
    try {
      openReaderDb(directory);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReaderUpgradeRequiredError);
    expect((caught as ReaderUpgradeRequiredError).uiLocale).toBeNull();
  });

  test("upgrades the previous schema after a backup, keeping every row", () => {
    const directory = previousSchemaDirectory();
    const backups: string[] = [];
    const db = openReaderDb(directory, {
      upgrade: true,
      onUpgraded: (path) => backups.push(path),
    });
    databases.push(db);

    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    const documents = listDocuments(db);
    const pdf = documents.find((document) => document.format === "pdf")!;
    const epub = documents.find((document) => document.format === "epub")!;
    expect(pdf.name).toBe("kept.pdf");
    expect(getImportedOutline(db, pdf.id)).toEqual(previousOutline);
    expect(getTranslation(db, { documentId: pdf.id, pageNumber: 1, targetLanguage: "en" })?.typst).toBe("= Kept");
    const { theme: _dropped, ...epubView } = previousEpubView;
    expect(getReaderView(db, epub.id)).toEqual(epubView as ReaderView);
    expect(getUiLocale(db)).toBe("zh-CN");
    expect(getTheme(db)).toBe("system");
    expect(schemaOf(db)).toEqual(schemaOf(tempDb()));

    expect(backups).toHaveLength(1);
    expect(backups[0]!.startsWith(join(directory, `${DB_FILENAME}.v${UPGRADABLE_SCHEMA_VERSION}-`))).toBe(true);
    const backup = new Database(backups[0]!, { readonly: true });
    try {
      expect(backup.query("PRAGMA user_version").get()).toEqual({
        user_version: UPGRADABLE_SCHEMA_VERSION,
      });
      expect(
        (backup.query("PRAGMA table_info(app_settings)").all() as { name: string }[]).map((column) => column.name),
      ).not.toContain("theme");
      expect(
        (backup.query("SELECT readerView FROM documents WHERE id = ?").get(epub.id) as { readerView: string })
          .readerView,
      ).toBe(JSON.stringify(previousEpubView));
    } finally {
      backup.close();
    }

    db.close();
    databases.splice(databases.indexOf(db), 1);
    const reopened = openReaderDb(directory);
    databases.push(reopened);
    expect(listDocuments(reopened)).toHaveLength(2);
  });

  test("rolls back an upgrade that fails part-way, keeping the backup and every row", () => {
    const directory = previousSchemaDirectory();
    // A language the new table's check refuses, so copying the row fails after the old table was renamed.
    const raw = new Database(join(directory, DB_FILENAME));
    const deviceId = (raw.query("SELECT deviceId FROM app_settings").get() as { deviceId: string }).deviceId;
    raw.exec(`
      ALTER TABLE app_settings RENAME TO app_settings_checked;
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY NOT NULL CHECK (key = 'app'),
        uiLocale TEXT NOT NULL,
        aiConfig TEXT,
        deviceId TEXT NOT NULL
      ) STRICT;
      INSERT INTO app_settings SELECT key, 'fr', aiConfig, deviceId FROM app_settings_checked;
      DROP TABLE app_settings_checked;
    `);
    raw.close();
    const schemaBefore = (() => {
      const check = new Database(join(directory, DB_FILENAME), { readonly: true });
      try {
        return schemaOf(check);
      } finally {
        check.close();
      }
    })();
    const backups: string[] = [];

    expect(() =>
      openReaderDb(directory, { upgrade: true, onUpgraded: (path) => backups.push(path) }),
    ).toThrow();
    expect(backups).toEqual([]);

    const check = new Database(join(directory, DB_FILENAME), { readonly: true });
    try {
      expect(check.query("PRAGMA user_version").get()).toEqual({
        user_version: UPGRADABLE_SCHEMA_VERSION,
      });
      expect(schemaOf(check)).toEqual(schemaBefore);
      expect(check.query("SELECT uiLocale, deviceId FROM app_settings").get()).toEqual({ uiLocale: "fr", deviceId });
      expect(
        (check.query("SELECT readerView FROM documents WHERE format = 'epub'").get() as { readerView: string })
          .readerView,
      ).toBe(JSON.stringify(previousEpubView));
    } finally {
      check.close();
    }
    const kept = readdirSync(directory).filter(
      (name) => name.startsWith(`${DB_FILENAME}.v${UPGRADABLE_SCHEMA_VERSION}-`) && name.endsWith(".bak"),
    );
    expect(kept).toHaveLength(1);
    const backup = new Database(join(directory, kept[0]!), { readonly: true });
    try {
      expect(backup.query("PRAGMA user_version").get()).toEqual({
        user_version: UPGRADABLE_SCHEMA_VERSION,
      });
    } finally {
      backup.close();
    }
  });

  test("rolls back an upgrade of a database that lacks a previous-schema column", () => {
    const directory = mkdtempSync(join(tmpdir(), "lumo-storage-"));
    directories.push(directory);
    openReaderDb(directory).close();
    // Claims the previous version but has no interface language to carry over.
    const raw = new Database(join(directory, DB_FILENAME));
    previousAppSettings(raw, { uiLocale: false });
    raw.exec(`PRAGMA user_version = ${UPGRADABLE_SCHEMA_VERSION}`);
    raw.close();

    expect(() => openReaderDb(directory, { upgrade: true })).toThrow();
    const check = new Database(join(directory, DB_FILENAME), { readonly: true });
    try {
      expect(check.query("PRAGMA user_version").get()).toEqual({
        user_version: UPGRADABLE_SCHEMA_VERSION,
      });
      expect(
        (check.query("PRAGMA table_info(app_settings)").all() as { name: string }[]).map((column) => column.name),
      ).toEqual(["key", "aiConfig", "deviceId"]);
    } finally {
      check.close();
    }
  });

  test("never upgrades any other schema version", () => {
    for (const version of [3, 6, SCHEMA_VERSION + 1]) {
      const directory = mkdtempSync(join(tmpdir(), "lumo-storage-"));
      directories.push(directory);
      openReaderDb(directory).close();
      const raw = new Database(join(directory, DB_FILENAME));
      raw.exec(`PRAGMA user_version = ${version}`);
      raw.close();
      const before = snapshot(directory);

      expect(() => openReaderDb(directory, { upgrade: true })).toThrow(
        `uses schema version ${version}`,
      );
      expect(snapshot(directory)).toEqual(before);
    }
  });

  test("starts a fresh database when a stale WAL is all that is left of a deleted one", () => {
    const copy = liveWalCopy(SCHEMA_VERSION - 1);
    rmSync(join(copy, DB_FILENAME));

    const db = openReaderDb(copy);
    databases.push(db);

    expect(listDocuments(db)).toEqual([]);
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

  test("starts a new library at the system theme and refuses an unknown one without writing", () => {
    const db = tempDb();
    expect(getTheme(db)).toBe("system");
    expect(getUiLocale(db)).toBe("en");
    expect(() => saveTheme(db, "blue" as never)).toThrow();
    expect(() => db.exec("UPDATE app_settings SET theme = 'blue'")).toThrow();
    expect(getAppSettings(db).theme).toBe("system");
  });

  test("serializes locale, AI config and reader writes without losing fields", () => {
    const db = tempDb();
    const config: AiConfig = {
      provider: "openai",
      model: "gpt-5.4-mini",
      reasoningEffort: "high",
    };
    saveUiLocale(db, "zh-CN");
    saveTheme(db, "night");
    saveAiConfig(db, config);
    updateReaderSettings(db, { documentId: null, pageNumber: 1, targetLanguage: "ja" });
    expect(getUiLocale(db)).toBe("zh-CN");
    expect(getTheme(db)).toBe("night");
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
      { name: "doc.pdf", pageCount: 1, format: "pdf" },
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
      { name: "doc.pdf", pageCount: 2, format: "pdf" },
      new TextEncoder().encode("%PDF-1.7 view persistence"),
    );
    expect(getReaderView(db, document.id)).toBeNull();

    const view: ReaderView = {
      format: "pdf",
      scaleValue: "page-width",
      rotation: 90,
      scrollMode: 0,
      spreadMode: 2,
    };
    expect(saveReaderView(db, document.id, view)).toEqual(view);

    const zoomed: ReaderView = { ...view, translationZoom: 1.25 };
    expect(saveReaderView(db, document.id, zoomed)).toEqual(zoomed);
    expect(getReaderView(db, document.id)).toEqual(zoomed);
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
      { name: "doc.pdf", pageCount: 2, format: "pdf" },
      new TextEncoder().encode("%PDF-1.7 view failures"),
    );
    const view: ReaderView = {
      format: "pdf",
      scaleValue: "page-width",
      rotation: 90,
      scrollMode: 0,
      spreadMode: 2,
    };
    saveReaderView(db, document.id, view);

    expect(() =>
      saveReaderView(db, document.id, { ...view, scaleValue: "125" }),
    ).toThrow();
    expect(() =>
      saveReaderView(db, document.id, { ...view, translationZoom: 0.33 } as unknown as ReaderView),
    ).toThrow();
    expect(() =>
      saveReaderView(db, document.id, { ...view, translationZoom: "huge" } as unknown as ReaderView),
    ).toThrow();
    expect(() =>
      saveReaderView(db, document.id, {
        format: "epub",
        cfi: null,
        fontSize: 18,
        fontFamily: "serif",
        lineHeight: 1.6,
      }),
    ).toThrow(ReaderViewFormatError);
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
      { name: "doc.pdf", pageCount: 2, format: "pdf" },
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
      { name: "doc.pdf", pageCount: 3, format: "pdf" },
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

describe("imported outline storage", () => {
  const outline: OutlineEntry[] = [
    { title: "A", level: 1, pageNumber: 2 },
    { title: "A.1", level: 2, pageNumber: 2 },
    { title: "B", level: 1, pageNumber: 4 },
  ];

  test("stores an imported outline across reopen and removes it with the document", () => {
    const directory = mkdtempSync(join(tmpdir(), "lumo-storage-"));
    directories.push(directory);
    const db = openReaderDb(directory);
    databases.push(db);
    const document = storeDocument(
      db,
      { name: "outline.pdf", pageCount: 5, format: "pdf" },
      new TextEncoder().encode("%PDF-1.7 imported outline"),
    );
    expect(getImportedOutline(db, document.id)).toBeNull();
    expect(saveImportedOutline(db, document.id, outline)).toEqual(outline);

    db.close();
    databases.splice(databases.indexOf(db), 1);
    const reopened = openReaderDb(directory);
    databases.push(reopened);
    expect(getImportedOutline(reopened, document.id)).toEqual(outline);
    clearImportedOutline(reopened, document.id);
    expect(getImportedOutline(reopened, document.id)).toBeNull();
    saveImportedOutline(reopened, document.id, outline);
    expect(removeDocument(reopened, document.id)).toBe(true);
    expect(() => getImportedOutline(reopened, document.id)).toThrow(
      DocumentNotFoundError,
    );
    expect(() => clearImportedOutline(reopened, document.id)).toThrow(
      DocumentNotFoundError,
    );
  });

  test("rejects invalid or failed writes without replacing the stored outline", () => {
    const db = tempDb();
    const document = storeDocument(
      db,
      { name: "outline.pdf", pageCount: 5, format: "pdf" },
      new TextEncoder().encode("%PDF-1.7 outline failures"),
    );
    saveImportedOutline(db, document.id, outline);

    expect(() => saveImportedOutline(db, document.id, [])).toThrow();
    expect(() =>
      saveImportedOutline(db, document.id, [
        { title: "Outside", level: 1, pageNumber: 6 },
      ]),
    ).toThrow();
    expect(() =>
      saveImportedOutline(db, document.id, [
        { title: "Skip", level: 2, pageNumber: 1 },
      ]),
    ).toThrow();
    expect(() =>
      saveImportedOutline(db, "b".repeat(64), outline),
    ).toThrow(DocumentNotFoundError);

    db.exec("PRAGMA query_only = ON");
    try {
      expect(() =>
        saveImportedOutline(db, document.id, [
          { title: "Changed", level: 1, pageNumber: 1 },
        ]),
      ).toThrow();
    } finally {
      db.exec("PRAGMA query_only = OFF");
    }
    expect(getImportedOutline(db, document.id)).toEqual(outline);
  });

  test("rejects a corrupted stored outline without rewriting it", () => {
    const db = tempDb();
    const document = storeDocument(
      db,
      { name: "outline.pdf", pageCount: 5, format: "pdf" },
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
      db.query("UPDATE documents SET importedOutline = ? WHERE id = ?").run(
        value,
        document.id,
      );
      expect(() => getImportedOutline(db, document.id)).toThrow(
        "stored imported outline is invalid",
      );
      expect(
        db
          .query("SELECT importedOutline FROM documents WHERE id = ?")
          .get(document.id),
      ).toEqual({ importedOutline: value });
    }
  });
});
