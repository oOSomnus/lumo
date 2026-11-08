import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";

export const CREDENTIAL_DB_FILENAME = "ai-credentials.sqlite";
const SCHEMA_VERSION = 1;
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_RETRY_MS = 50;

export class CredentialStorageError extends Error {
  readonly code = "STORAGE_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "CredentialStorageError";
  }
}

export class StorageBusyError extends Error {
  readonly code = "STORAGE_BUSY";
  constructor() {
    super("the credential database is busy; retry shortly");
    this.name = "StorageBusyError";
  }
}

const envSchema = z.record(z.string(), z.string());
const apiKeyCredentialSchema = z.looseObject({
  type: z.literal("api_key"),
  key: z.string().optional(),
  env: envSchema.optional(),
});
const oauthCredentialSchema = z.looseObject({
  type: z.literal("oauth"),
  refresh: z.string(),
  access: z.string(),
  expires: z.number(),
});
const credentialSchema = z.discriminatedUnion("type", [
  apiKeyCredentialSchema,
  oauthCredentialSchema,
]);

function parseCredential(providerId: string, raw: string): Credential {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CredentialStorageError(
      `stored credential for ${JSON.stringify(providerId)} is not valid JSON`,
    );
  }
  const parsed = credentialSchema.safeParse(value);
  if (!parsed.success) {
    throw new CredentialStorageError(
      `stored credential for ${JSON.stringify(providerId)} is malformed`,
    );
  }
  return parsed.data as Credential;
}

function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("aborted", "AbortError");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function beginImmediate(
  db: Database,
  signal?: AbortSignal,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (signal?.aborted) throw abortReason(signal);
    try {
      db.exec("BEGIN IMMEDIATE");
      return;
    } catch (error) {
      if (!isBusy(error)) throw error;
      if (Date.now() - started >= LOCK_TIMEOUT_MS) throw new StorageBusyError();
      await sleep(LOCK_RETRY_MS, signal);
    }
  }
}

function rollback(db: Database): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // SQLite already rolled back after an error.
  }
}

const SCHEMA_SQL = `
CREATE TABLE credentials (
  providerId TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('api_key','oauth')),
  data TEXT NOT NULL
) STRICT;
PRAGMA user_version = 1;
`;

interface CredentialRow {
  providerId: string;
  type: string;
  data: string;
}

export class SqliteCredentialStore implements CredentialStore {
  readonly #db: Database;
  readonly #path: string;
  #chain: Promise<unknown> = Promise.resolve();
  #closing: Promise<void> | undefined;

  constructor(db: Database, path: string) {
    this.#db = db;
    this.#path = path;
  }

  get path(): string {
    return this.#path;
  }

  async read(
    providerId: string,
    _options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    try {
      const row = this.#db
        .query("SELECT providerId, type, data FROM credentials WHERE providerId = ?")
        .get(providerId) as CredentialRow | null;
      return row ? parseCredential(row.providerId, row.data) : undefined;
    } catch (error) {
      if (isBusy(error)) throw new StorageBusyError();
      throw error;
    }
  }

  async list(
    _options?: AuthOperationOptions,
  ): Promise<readonly CredentialInfo[]> {
    try {
      const rows = this.#db
        .query("SELECT providerId, type FROM credentials ORDER BY providerId")
        .all() as { providerId: string; type: string }[];
      return rows.map((row) => {
        if (row.type !== "api_key" && row.type !== "oauth") {
          throw new CredentialStorageError(
            `stored credential for ${JSON.stringify(row.providerId)} has an unknown type`,
          );
        }
        return { providerId: row.providerId, type: row.type };
      });
    } catch (error) {
      if (isBusy(error)) throw new StorageBusyError();
      throw error;
    }
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.#enqueue(async () => {
      await beginImmediate(this.#db, options?.signal);
      let current: Credential | undefined;
      let next: Credential | undefined;
      try {
        const row = this.#db
          .query("SELECT providerId, type, data FROM credentials WHERE providerId = ?")
          .get(providerId) as CredentialRow | null;
        current = row ? parseCredential(row.providerId, row.data) : undefined;
        // The database lock is held while a refresh runs; the reader database
        // is a separate connection and never waits on this lock.
        next = await fn(current);
        if (next !== undefined) {
          const parsed = credentialSchema.safeParse(next);
          if (!parsed.success) {
            throw new CredentialStorageError(
              `refusing to store a malformed credential for ${JSON.stringify(providerId)}`,
            );
          }
          this.#db
            .query(
              `INSERT INTO credentials (providerId, type, data) VALUES (?, ?, ?)
               ON CONFLICT (providerId) DO UPDATE SET type = excluded.type, data = excluded.data`,
            )
            .run(providerId, next.type, JSON.stringify(next));
        }
        this.#db.exec("COMMIT");
      } catch (error) {
        rollback(this.#db);
        throw error;
      }
      return next === undefined ? current : next;
    });
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    await this.#enqueue(async () => {
      await beginImmediate(this.#db, options?.signal);
      try {
        this.#db.query("DELETE FROM credentials WHERE providerId = ?").run(providerId);
        this.#db.exec("COMMIT");
      } catch (error) {
        rollback(this.#db);
        throw error;
      }
    });
  }

  /** Rejects new writes at once, waits for queued ones, then closes. Repeat calls share the result. */
  close(): Promise<void> {
    this.#closing ??= this.#chain.then(() => this.#db.close());
    return this.#closing;
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.#closing) {
      return Promise.reject(new CredentialStorageError("credential store is closed"));
    }
    const run = this.#chain.then(task, task);
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export async function openAiCredentialStore(
  dataDirectory: string,
): Promise<SqliteCredentialStore> {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const path = join(dataDirectory, CREDENTIAL_DB_FILENAME);
  const db = new Database(path, { create: true, readwrite: true, strict: true });

  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("PRAGMA synchronous = FULL");
    const journal = db.query("PRAGMA journal_mode = DELETE").get() as {
      journal_mode?: string;
    } | null;
    if (journal?.journal_mode?.toLowerCase() !== "delete") {
      throw new Error(
        `could not enable rollback journal on ${path} (journal_mode=${journal?.journal_mode ?? "unknown"})`,
      );
    }

    await beginImmediate(db);
    try {
      const version = (
        db.query("PRAGMA user_version").get() as { user_version: number } | null
      )?.user_version ?? 0;
      const tables = (
        db
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('credentials')",
          )
          .all() as { name: string }[]
      ).map((row) => row.name);

      if (version === 0) {
        if (tables.length > 0) {
          throw new Error(
            `credential database ${path} has tables but no schema version; refusing to open`,
          );
        }
        db.exec(SCHEMA_SQL);
      } else if (version === SCHEMA_VERSION) {
        if (!tables.includes("credentials")) {
          throw new Error(`credential database ${path} is missing the credentials table`);
        }
      } else {
        throw new Error(
          `credential database ${path} uses schema version ${version}; this build supports ${SCHEMA_VERSION}`,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      rollback(db);
      throw error;
    }

    chmodSync(path, 0o600);
    return new SqliteCredentialStore(db, path);
  } catch (error) {
    db.close();
    throw error;
  }
}
