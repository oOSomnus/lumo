import { homedir } from "node:os";
import type { Database } from "bun:sqlite";
import indexHtml from "../client/index.html";
import { createLoginRegistry, handleAiAuth } from "./ai-auth";
import { openAiCredentialStore, type SqliteCredentialStore } from "./ai-credentials";
import { createAiManager } from "./ai-settings";
import {
  loadPdfjsAssets,
  resolvePdfjsDirectory,
  type PdfjsAssets,
} from "./assets";
import {
  errorResponse,
  guardRequest,
  httpErrorFromUnknown,
  type GateConfig,
} from "./http";
import { handleLibrary } from "./library";
import { handleSettings } from "./settings";
import { openReaderDb, resolveDataDirectory } from "./storage";
import { handleTranslate } from "./translate";

process.umask(0o077);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

let dataDirectory: string;
try {
  dataDirectory = resolveDataDirectory(process.env, homedir());
} catch (error) {
  fail(`Cannot determine data directory: ${(error as Error).message}`);
}

let db: Database;
try {
  db = openReaderDb(dataDirectory);
} catch (error) {
  fail(`Cannot open reader database in ${dataDirectory}: ${(error as Error).message}`);
}

let assets: PdfjsAssets;
try {
  assets = loadPdfjsAssets();
} catch (error) {
  fail(`Cannot load PDF.js assets: ${(error as Error).message}`);
}

let credentials: SqliteCredentialStore;
try {
  credentials = await openAiCredentialStore(dataDirectory);
} catch (error) {
  fail(
    `Cannot open AI credential store in ${dataDirectory}: ${(error as Error).message}`,
  );
}

const token = crypto.randomUUID();
const ai = createAiManager(db, credentials);
const logins = createLoginRegistry();

const gate: GateConfig = { token, origin: "", host: "" };
const ctx = { db, dataDirectory, ai };

const isDevelopment =
  !Bun.isStandaloneExecutable && process.env.NODE_ENV === "development";

async function apiHandler(request: Request): Promise<Response> {
  const rejected = guardRequest(request, gate);
  if (rejected) return rejected;

  try {
    const url = new URL(request.url);
    if (url.pathname === "/api/translate") {
      return await handleTranslate(request, ctx);
    }
    const settings = await handleSettings(request, url, ctx);
    if (settings) return settings;
    const auth = await handleAiAuth(request, url, { ai, logins });
    if (auth) return auth;
    return await handleLibrary(request, url, ctx);
  } catch (error) {
    return httpErrorFromUnknown(error);
  }
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 150,
  maxRequestBodySize: 101 * 1024 * 1024,
  development: isDevelopment,
  routes: {
    "/": indexHtml,
    "/api/*": apiHandler,
    "/pdfjs/*": (request: Request) =>
      assets.serve(new URL(request.url)) ??
      errorResponse(404, "NOT_FOUND", "not found"),
  },
  fetch() {
    return new Response("Not found", {
      status: 404,
      headers: {
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  },
});

gate.origin = server.url.origin;
gate.host = server.url.host;

process.once("exit", () => {
  try {
    db.close();
  } catch {
    // The process is exiting; SQLite already committed or rolled back.
  }
  try {
    credentials.close();
  } catch {
    // The process is exiting.
  }
});

console.log(`Lumo data directory: ${dataDirectory}`);
console.log(`PDF.js assets: ${resolvePdfjsDirectory()}`);
console.log("AI translation: configure a provider, model and credentials in Settings.");
console.log(`Open in your browser: ${server.url.href}?token=${token}`);
