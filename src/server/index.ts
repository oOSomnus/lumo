import { homedir } from "node:os";
import type { Database } from "bun:sqlite";
import indexHtml from "../client/index.html";
import {
  DESKTOP_SHUTDOWN_TIMEOUT_MS,
  type DesktopEvent,
  type DesktopFailureCode,
} from "../shared/desktop";
import { createLoginRegistry, handleAiAuth } from "./ai-auth";
import { openAiCredentialStore, type SqliteCredentialStore } from "./ai-credentials";
import { createAiManager } from "./ai-settings";
import {
  loadPdfjsAssets,
  loadTypstAssets,
  resolvePdfjsDirectory,
  resolveTypstDirectory,
} from "./assets";
import { emitDesktopEvent, watchDesktopControl } from "./desktop";
import {
  errorResponse,
  guardRequest,
  httpErrorFromUnknown,
  type GateConfig,
} from "./http";
import { handleLibrary } from "./library";
import { handleOutlinePage } from "./outline";
import { handleSettings } from "./settings";
import { getUiLocale, openReaderDb, resolveDataDirectory } from "./storage";
import { handleTranslate } from "./translate";

// Windows has no POSIX modes; the per-user profile directory is its boundary.
if (process.platform !== "win32") process.umask(0o077);

const desktop = process.argv.includes("--desktop");

function emit(event: DesktopEvent): void {
  if (desktop) emitDesktopEvent(event);
}

class StartupError extends Error {
  constructor(
    readonly code: DesktopFailureCode,
    message: string,
  ) {
    super(message);
  }
}

function step<T>(code: DesktopFailureCode, what: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw new StartupError(code, `${what}: ${(error as Error).message}`);
  }
}

let db: Database | undefined;
let credentials: SqliteCredentialStore | undefined;
let server: Bun.Server<undefined> | undefined;
let stopping = false;
let shutdownRun: Promise<void> | undefined;

const stopController = new AbortController();
const logins = createLoginRegistry();
const inflight = new Set<Promise<unknown>>();

async function start(): Promise<void> {
  emit({ type: "log", code: "starting" });

  const dataDirectory = step(
    "DATA_DIRECTORY_INVALID",
    "Cannot determine data directory",
    () => resolveDataDirectory(process.env, homedir()),
  );
  const reader = step(
    "READER_DATABASE_FAILED",
    `Cannot open reader database in ${dataDirectory}`,
    () => openReaderDb(dataDirectory),
  );
  db = reader;
  const uiLocale = step(
    "READER_DATABASE_FAILED",
    `Cannot read reader database in ${dataDirectory}`,
    () => getUiLocale(reader),
  );
  emit({ type: "log", code: "reader_ready" });

  const assets = step("PDFJS_ASSETS_FAILED", "Cannot load PDF.js assets", loadPdfjsAssets);
  const typstAssets = step("TYPST_ASSETS_FAILED", "Cannot load Typst assets", loadTypstAssets);
  emit({ type: "log", code: "assets_ready" });

  try {
    credentials = await openAiCredentialStore(dataDirectory);
  } catch (error) {
    throw new StartupError(
      "CREDENTIALS_DATABASE_FAILED",
      `Cannot open AI credential store in ${dataDirectory}: ${(error as Error).message}`,
    );
  }
  emit({ type: "log", code: "credentials_ready" });
  // A stop request that arrived while the credential store opened closes what is open.
  if (stopping) return;

  const token = crypto.randomUUID();
  const ai = createAiManager(reader, credentials);
  const gate: GateConfig = { token, origin: "", host: "" };
  const ctx = { db: reader, dataDirectory, ai };

  const isDevelopment =
    !Bun.isStandaloneExecutable && process.env.NODE_ENV === "development";

  async function handleApi(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/translate") {
        return await handleTranslate(request, ctx);
      }
      if (url.pathname === "/api/outline-page") {
        return await handleOutlinePage(request, ctx);
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

  function apiHandler(request: Request): Promise<Response> | Response {
    const rejected = guardRequest(request, gate);
    if (rejected) return rejected;
    if (stopping) {
      return errorResponse(503, "SERVER_STOPPING", "the server is shutting down");
    }

    // Handlers watch request.signal; also tie it to the shutdown signal so a stop
    // cancels provider calls instead of relying on the connection closing.
    const work = handleApi(
      new Request(request, {
        signal: AbortSignal.any([request.signal, stopController.signal]),
      }),
    );
    inflight.add(work);
    void work.finally(() => inflight.delete(work));
    return work;
  }

  server = step("SERVER_LISTEN_FAILED", "Cannot start the local server", () =>
    Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 150,
      maxRequestBodySize: Infinity,
      development: isDevelopment,
      routes: {
        "/": indexHtml,
        "/api/*": apiHandler,
        "/pdfjs/*": (request: Request) =>
          assets.serve(new URL(request.url)) ??
          errorResponse(404, "NOT_FOUND", "not found"),
        "/typst/*": (request: Request) =>
          typstAssets.serve(new URL(request.url)) ??
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
    }),
  );

  gate.origin = server.url.origin;
  gate.host = server.url.host;

  console.log(`Lumo data directory: ${dataDirectory}`);
  console.log(`PDF.js assets: ${resolvePdfjsDirectory()}`);
  console.log(`Typst assets: ${resolveTypstDirectory()}`);
  console.log("AI translation: configure a provider, model and credentials in Settings.");
  console.log(`Open in your browser: ${server.url.href}?token=${token}`);
  emit({ type: "ready", dataDirectory, uiLocale });
}

async function closeResources(): Promise<void> {
  const store = credentials;
  const reader = db;
  credentials = undefined;
  db = undefined;
  // Queued credential writes finish before the file closes.
  await store?.close();
  reader?.close();
}

const startup = (async () => {
  try {
    await start();
  } catch (error) {
    if (!(error instanceof StartupError)) throw error;
    console.error(error.message);
    emit({ type: "failed", code: error.code });
    await closeResources();
    process.exit(1);
  }
})();

/** Idempotent; the one path for IPC, SIGINT and SIGTERM. */
function shutdown(): Promise<void> {
  shutdownRun ??= (async () => {
    stopping = true;
    emit({ type: "log", code: "stopping" });
    // Past this, exit non-zero and let SQLite roll back whatever was unfinished.
    const watchdog = setTimeout(() => {
      console.error("Shutdown did not finish in time; exiting");
      process.exit(1);
    }, DESKTOP_SHUTDOWN_TIMEOUT_MS);

    await startup;
    stopController.abort(new DOMException("the server is shutting down", "AbortError"));
    await Promise.all([server?.stop(true), logins.shutdown()]);
    await Promise.allSettled([...inflight]);
    await closeResources();
    clearTimeout(watchdog);
    emit({ type: "stopped" });
  })();
  return shutdownRun;
}

function stopAndExit(code: number): void {
  shutdown().then(
    () => process.exit(code),
    () => process.exit(1),
  );
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => stopAndExit(0));
}

if (desktop) {
  void watchDesktopControl(Bun.stdin.stream(), {
    onShutdown: () => stopAndExit(0),
    onInvalid: () => {
      emit({ type: "failed", code: "CONTROL_PROTOCOL_INVALID" });
      stopAndExit(1);
    },
  });
}

await startup;
