import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  aiConfigSchema,
  documentNameSchema,
  outlineEntriesSchema,
  pageNumberSchema,
  readerViewSchema,
  targetLanguageSchema,
  uiLocaleSchema,
  type AiConfig,
  type DocumentRecord,
  type OutlineEntry,
  type ReaderSettings,
  type ReaderView,
  type TargetLanguage,
  type TranslationContent,
  type TranslationRecord,
  type UiLocale,
} from "../shared/contracts";

export const DB_FILENAME = "reader.sqlite";
export const SCHEMA_VERSION = 4;

const BUSINESS_TABLES = [
  "documents",
  "files",
  "translations",
  "settings",
  "app_settings",
] as const;

export class StoredAiConfigError extends Error {
  constructor(message = "the stored AI configuration is invalid") {
    super(message);
    this.name = "StoredAiConfigError";
  }
}

export function resolveDataDirectory(
  env: Record<string, string | undefined>,
  homeDirectory: string,
): string {
  const explicit = env.LUMO_DATA_DIR?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) {
      throw new Error(
        `LUMO_DATA_DIR must be an absolute path, got ${JSON.stringify(env.LUMO_DATA_DIR)}`,
      );
    }
    return explicit;
  }

  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg && isAbsolute(xdg)) {
    return join(xdg, "lumo");
  }

  return join(homeDirectory || homedir(), ".local", "share", "lumo");
}

type UserVersionRow = { user_version: number };

function readUserVersion(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as UserVersionRow | null;
  return row?.user_version ?? 0;
}

function existingBusinessTables(db: Database): string[] {
  const rows = db
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('documents','files','translations','settings','app_settings')",
    )
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

function insertAppSettingsRow(db: Database): void {
  db.query(
    "INSERT INTO app_settings (key, uiLocale, aiConfig, deviceId) VALUES ('app', 'en', NULL, ?)",
  ).run(crypto.randomUUID());
}

const SCHEMA_SQL = `
CREATE TABLE documents (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  pageCount INTEGER NOT NULL,
  currentPage INTEGER NOT NULL,
  createdAt INTEGER NOT NULL,
  lastOpenedAt INTEGER NOT NULL,
  readerView TEXT,
  generatedOutline TEXT
) STRICT;
CREATE INDEX documents_last_opened_at ON documents(lastOpenedAt);

CREATE TABLE files (
  documentId TEXT PRIMARY KEY NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  data BLOB NOT NULL
) STRICT;

CREATE TABLE translations (
  documentId TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  pageNumber INTEGER NOT NULL,
  targetLanguage TEXT NOT NULL,
  markdown TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  translatedAt INTEGER NOT NULL,
  PRIMARY KEY (documentId, pageNumber, targetLanguage)
) STRICT;
CREATE INDEX translations_document_language ON translations(documentId, targetLanguage, pageNumber);

CREATE TABLE settings (
  key TEXT PRIMARY KEY NOT NULL CHECK (key = 'reader'),
  lastDocumentId TEXT REFERENCES documents(id) ON DELETE SET NULL,
  targetLanguage TEXT NOT NULL
) STRICT;
INSERT INTO settings (key, lastDocumentId, targetLanguage) VALUES ('reader', NULL, 'zh-CN');

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY NOT NULL CHECK (key = 'app'),
  uiLocale TEXT NOT NULL CHECK (uiLocale IN ('en', 'zh-CN')),
  aiConfig TEXT,
  deviceId TEXT NOT NULL
) STRICT;
PRAGMA user_version = ${SCHEMA_VERSION};
`;

export function openReaderDb(dataDirectory: string): Database {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const dbPath = join(dataDirectory, DB_FILENAME);
  const db = new Database(dbPath, { create: true, readwrite: true, strict: true });

  try {
    db.exec("PRAGMA busy_timeout = 10000");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA synchronous = FULL");

    const initialize = db.transaction(() => {
      const version = readUserVersion(db);
      const tables = existingBusinessTables(db);

      if (version === 0) {
        if (tables.length > 0) {
          throw new Error(
            `database ${dbPath} has tables but no schema version; refusing to open`,
          );
        }
        db.exec(SCHEMA_SQL);
        insertAppSettingsRow(db);
        return;
      }

      if (version !== SCHEMA_VERSION) {
        throw new Error(
          `database ${dbPath} uses schema version ${version}; this build supports ${SCHEMA_VERSION}`,
        );
      }

      const missing = BUSINESS_TABLES.filter((name) => !tables.includes(name));
      if (missing.length > 0) {
        throw new Error(
          `database ${dbPath} is missing tables: ${missing.join(", ")}`,
        );
      }
    });
    initialize.immediate();

    const journal = db.query("PRAGMA journal_mode = WAL").get() as {
      journal_mode?: string;
    } | null;
    if (journal?.journal_mode?.toLowerCase() !== "wal") {
      throw new Error(
        `could not enable WAL on ${dbPath} (journal_mode=${journal?.journal_mode ?? "unknown"})`,
      );
    }
    db.exec("PRAGMA journal_size_limit = 0");
  } catch (error) {
    db.close();
    throw error;
  }

  return db;
}

const DOCUMENT_COLUMNS =
  "id, name, size, pageCount, currentPage, createdAt, lastOpenedAt";

export function listDocuments(db: Database): DocumentRecord[] {
  return db
    .query(
      `SELECT ${DOCUMENT_COLUMNS} FROM documents ORDER BY lastOpenedAt DESC, createdAt DESC`,
    )
    .all() as DocumentRecord[];
}

export function getDocument(
  db: Database,
  documentId: string,
): DocumentRecord | null {
  return db
    .query(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = ?`)
    .get(documentId) as DocumentRecord | null;
}

export function getReaderView(
  db: Database,
  documentId: string,
): ReaderView | null {
  const row = db
    .query("SELECT readerView FROM documents WHERE id = ?")
    .get(documentId) as { readerView: string | null } | null;
  if (!row) throw new DocumentNotFoundError(documentId);
  if (row.readerView === null) return null;
  try {
    return readerViewSchema.parse(JSON.parse(row.readerView));
  } catch {
    throw new Error("stored reading view is invalid");
  }
}

export function saveReaderView(
  db: Database,
  documentId: string,
  view: ReaderView,
): ReaderView {
  const parsed = readerViewSchema.parse(view);
  const result = db
    .query("UPDATE documents SET readerView = ? WHERE id = ?")
    .run(JSON.stringify(parsed), documentId);
  if (result.changes === 0) throw new DocumentNotFoundError(documentId);
  return parsed;
}

export function getGeneratedOutline(
  db: Database,
  documentId: string,
): OutlineEntry[] | null {
  const row = db
    .query("SELECT pageCount, generatedOutline FROM documents WHERE id = ?")
    .get(documentId) as {
    pageCount: number;
    generatedOutline: string | null;
  } | null;
  if (!row) throw new DocumentNotFoundError(documentId);
  if (row.generatedOutline === null) return null;

  let value: unknown;
  try {
    value = JSON.parse(row.generatedOutline);
  } catch {
    throw new Error("stored generated outline is invalid");
  }
  const parsed = outlineEntriesSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.some((entry) => entry.pageNumber > row.pageCount)
  ) {
    throw new Error("stored generated outline is invalid");
  }
  return parsed.data;
}

export function saveGeneratedOutline(
  db: Database,
  documentId: string,
  entries: OutlineEntry[],
): OutlineEntry[] {
  const parsed = outlineEntriesSchema.parse(entries);
  const write = db.transaction(() => {
    const document = getDocument(db, documentId);
    if (!document) throw new DocumentNotFoundError(documentId);
    const outside = parsed.find(
      (entry) => entry.pageNumber > document.pageCount,
    );
    if (outside) {
      throw new PageOutOfRangeError(outside.pageNumber, document.pageCount);
    }
    db.query("UPDATE documents SET generatedOutline = ? WHERE id = ?").run(
      JSON.stringify(parsed),
      documentId,
    );
    return parsed;
  });
  return write.immediate();
}

export function getDocumentFile(
  db: Database,
  documentId: string,
): { name: string; data: Uint8Array } | null {
  const row = db
    .query(
      "SELECT d.name, f.data FROM files f JOIN documents d ON d.id = f.documentId WHERE f.documentId = ?",
    )
    .get(documentId) as { name: string; data: Uint8Array } | null;
  return row;
}

export function getSettings(db: Database): ReaderSettings {
  const row = db
    .query("SELECT lastDocumentId, targetLanguage FROM settings WHERE key = 'reader'")
    .get() as { lastDocumentId: string | null; targetLanguage: string } | null;
  if (!row) {
    throw new Error("reader settings row is missing");
  }
  const parsedLanguage = targetLanguageSchema.safeParse(row.targetLanguage);
  if (!parsedLanguage.success) {
    throw new Error("stored target language is invalid");
  }
  return {
    lastDocumentId: row.lastDocumentId,
    targetLanguage: parsedLanguage.data,
  };
}

export interface AppSettings {
  uiLocale: UiLocale;
  aiConfig: AiConfig | null;
  deviceId: string;
}

export function getAppSettings(db: Database): AppSettings {
  const row = db
    .query("SELECT uiLocale, aiConfig, deviceId FROM app_settings WHERE key = 'app'")
    .get() as { uiLocale: string; aiConfig: string | null; deviceId: string } | null;
  if (!row) throw new Error("app settings row is missing");

  const locale = uiLocaleSchema.safeParse(row.uiLocale);
  if (!locale.success) throw new Error("stored UI locale is invalid");
  if (typeof row.deviceId !== "string" || row.deviceId.length === 0) {
    throw new Error("stored device id is invalid");
  }

  let aiConfig: AiConfig | null = null;
  if (row.aiConfig !== null) {
    let value: unknown;
    try {
      value = JSON.parse(row.aiConfig);
    } catch {
      throw new StoredAiConfigError();
    }
    const parsed = aiConfigSchema.safeParse(value);
    if (!parsed.success) throw new StoredAiConfigError();
    aiConfig = parsed.data;
  }

  return { uiLocale: locale.data, aiConfig, deviceId: row.deviceId };
}

export function getUiLocale(db: Database): UiLocale {
  const row = db
    .query("SELECT uiLocale FROM app_settings WHERE key = 'app'")
    .get() as { uiLocale: string } | null;
  if (!row) throw new Error("app settings row is missing");
  return uiLocaleSchema.parse(row.uiLocale);
}

export function saveUiLocale(db: Database, locale: UiLocale): UiLocale {
  const parsed = uiLocaleSchema.parse(locale);
  const result = db
    .query("UPDATE app_settings SET uiLocale = ? WHERE key = 'app'")
    .run(parsed);
  if (result.changes === 0) throw new Error("app settings row is missing");
  return parsed;
}

export function saveAiConfig(db: Database, config: AiConfig): AiConfig {
  const parsed = aiConfigSchema.parse(config);
  const serialized = JSON.stringify(parsed);
  const result = db
    .query("UPDATE app_settings SET aiConfig = ? WHERE key = 'app'")
    .run(serialized);
  if (result.changes === 0) throw new Error("app settings row is missing");
  return parsed;
}

export function hashDocumentBytes(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export function storeDocument(
  db: Database,
  input: { name: string; pageCount: number },
  bytes: Uint8Array,
): DocumentRecord {
  const name = documentNameSchema.parse(input.name);
  const pageCount = pageNumberSchema.parse(input.pageCount);
  if (bytes.byteLength === 0) {
    throw new Error("cannot store an empty document");
  }

  const id = hashDocumentBytes(bytes);
  const size = bytes.byteLength;

  const write = db.transaction(() => {
    const existing = getDocument(db, id);
    const now = Date.now();
    if (existing) {
      db.query("UPDATE documents SET lastOpenedAt = ? WHERE id = ?").run(now, id);
      return { ...existing, lastOpenedAt: now };
    }
    db.query(
      "INSERT INTO documents (id, name, size, pageCount, currentPage, createdAt, lastOpenedAt) VALUES (?, ?, ?, ?, 1, ?, ?)",
    ).run(id, name, size, pageCount, now, now);
    db.query("INSERT INTO files (documentId, data) VALUES (?, ?)").run(id, bytes);
    return {
      id,
      name,
      size,
      pageCount,
      currentPage: 1,
      createdAt: now,
      lastOpenedAt: now,
    } satisfies DocumentRecord;
  });

  return write.immediate();
}

export function removeDocument(db: Database, documentId: string): boolean {
  const result = db.query("DELETE FROM documents WHERE id = ?").run(documentId);
  return result.changes > 0;
}

export interface TranslationLocation {
  documentId: string;
  pageNumber: number;
  targetLanguage: TargetLanguage;
}

function toTranslation(row: {
  documentId: string;
  pageNumber: number;
  targetLanguage: string;
  markdown: string;
  provider: string;
  model: string;
  translatedAt: number;
}): TranslationRecord {
  return {
    documentId: row.documentId,
    pageNumber: row.pageNumber,
    targetLanguage: targetLanguageSchema.parse(row.targetLanguage),
    markdown: row.markdown,
    provider: row.provider,
    model: row.model,
    translatedAt: row.translatedAt,
  };
}

const TRANSLATION_COLUMNS =
  "documentId, pageNumber, targetLanguage, markdown, provider, model, translatedAt";

export function getTranslation(
  db: Database,
  location: TranslationLocation,
): TranslationRecord | null {
  const row = db
    .query(
      `SELECT ${TRANSLATION_COLUMNS} FROM translations WHERE documentId = ? AND pageNumber = ? AND targetLanguage = ?`,
    )
    .get(
      location.documentId,
      location.pageNumber,
      location.targetLanguage,
    ) as Parameters<typeof toTranslation>[0] | null;
  return row ? toTranslation(row) : null;
}

export function listTranslations(
  db: Database,
  documentId: string,
  targetLanguage: TargetLanguage,
): TranslationRecord[] {
  const rows = db
    .query(
      `SELECT ${TRANSLATION_COLUMNS} FROM translations WHERE documentId = ? AND targetLanguage = ? ORDER BY pageNumber ASC`,
    )
    .all(documentId, targetLanguage) as Parameters<typeof toTranslation>[0][];
  return rows.map(toTranslation);
}

export function listTranslatedPages(
  db: Database,
  documentId: string,
  targetLanguage: TargetLanguage,
): number[] {
  const rows = db
    .query(
      "SELECT pageNumber FROM translations WHERE documentId = ? AND targetLanguage = ? ORDER BY pageNumber ASC",
    )
    .all(documentId, targetLanguage) as { pageNumber: number }[];
  return rows.map((row) => row.pageNumber);
}

export function saveTranslation(
  db: Database,
  location: TranslationLocation,
  content: TranslationContent,
): TranslationRecord {
  const pageNumber = pageNumberSchema.parse(location.pageNumber);
  const targetLanguage = targetLanguageSchema.parse(location.targetLanguage);
  const translatedAt = Date.now();

  const write = db.transaction(() => {
    const document = getDocument(db, location.documentId);
    if (!document) {
      throw new DocumentNotFoundError(location.documentId);
    }
    if (pageNumber > document.pageCount) {
      throw new PageOutOfRangeError(pageNumber, document.pageCount);
    }
    db.query(
      `INSERT INTO translations (documentId, pageNumber, targetLanguage, markdown, provider, model, translatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (documentId, pageNumber, targetLanguage) DO UPDATE SET
         markdown = excluded.markdown,
         provider = excluded.provider,
         model = excluded.model,
         translatedAt = excluded.translatedAt`,
    ).run(
      location.documentId,
      pageNumber,
      targetLanguage,
      content.markdown,
      content.provider,
      content.model,
      translatedAt,
    );
    return {
      documentId: location.documentId,
      pageNumber,
      targetLanguage,
      markdown: content.markdown,
      provider: content.provider,
      model: content.model,
      translatedAt,
    };
  });

  return write.immediate();
}

export function updateReaderSettings(
  db: Database,
  update: {
    documentId: string | null;
    pageNumber: number | null;
    targetLanguage: TargetLanguage;
  },
): ReaderSettings {
  const targetLanguage = targetLanguageSchema.parse(update.targetLanguage);
  const write = db.transaction(() => {
    if (update.documentId !== null && update.pageNumber !== null) {
      const document = getDocument(db, update.documentId);
      if (!document) {
        throw new DocumentNotFoundError(update.documentId);
      }
      if (update.pageNumber > document.pageCount) {
        throw new PageOutOfRangeError(update.pageNumber, document.pageCount);
      }
      db.query(
        "UPDATE documents SET currentPage = ?, lastOpenedAt = ? WHERE id = ?",
      ).run(update.pageNumber, Date.now(), update.documentId);
    }
    db.query(
      "UPDATE settings SET lastDocumentId = ?, targetLanguage = ? WHERE key = 'reader'",
    ).run(update.documentId, targetLanguage);
    return getSettings(db);
  });
  return write.immediate();
}

export class DocumentNotFoundError extends Error {
  constructor(documentId: string) {
    super(`document ${documentId} does not exist`);
    this.name = "DocumentNotFoundError";
  }
}

export class PageOutOfRangeError extends Error {
  constructor(pageNumber: number, pageCount: number) {
    super(`page ${pageNumber} is outside 1..${pageCount}`);
    this.name = "PageOutOfRangeError";
  }
}
