/**
 * Runs the compiled `lumo-server --desktop` sidecar the way the launcher does (stdio only,
 * an empty temp directory as cwd, a temp data directory) and checks its observable contract.
 * Usage: bun scripts/smoke-desktop.ts [--target <triple>] [--binary <path to an installed sidecar>]
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { DESKTOP_FAILURE_CODES, DESKTOP_LOG_CODES, DESKTOP_SHUTDOWN_COMMAND, type DesktopEvent } from "../src/shared/desktop";
import { DB_FILENAME, SCHEMA_VERSION } from "../src/server/storage";
import { FIXTURE_JPEG, fixturePdf } from "../tests/e2e/fixtures";
import { getBuildTarget } from "./targets";

const eventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("log"), code: z.enum(DESKTOP_LOG_CODES) }),
  z.strictObject({ type: z.literal("ready"), dataDirectory: z.string(), uiLocale: z.enum(["en", "zh-CN"]) }),
  z.strictObject({ type: z.literal("failed"), code: z.enum(DESKTOP_FAILURE_CODES) }),
  z.strictObject({ type: z.literal("stopped") }),
]);

function parseEvent(line: string): DesktopEvent | null {
  try {
    const parsed = eventSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const idResponseSchema = z.object({ id: z.string() });
const libraryResponseSchema = z.object({ documents: z.array(z.unknown()) });

class Sidecar {
  readonly lines: string[] = [];
  readonly events: DesktopEvent[] = [];
  readonly #child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly #waiters = new Set<() => void>();
  exitCode: number | null = null;
  link: URL | null = null;

  constructor(binary: string, cwd: string, dataDirectory: string) {
    this.#child = Bun.spawn([binary, "--desktop"], {
      cwd,
      env: { ...process.env, NODE_ENV: "production", LUMO_DATA_DIR: dataDirectory },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    void this.#pump(this.#child.stdout, true);
    void this.#pump(this.#child.stderr, false);
    void this.#child.exited.then((code) => {
      this.exitCode = code;
      this.#notify();
    });
  }

  async #pump(stream: ReadableStream<Uint8Array>, stdout: boolean): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      for (let end = pending.indexOf("\n"); end !== -1; end = pending.indexOf("\n")) {
        this.#line(pending.slice(0, end).replace(/\r$/, ""), stdout);
        pending = pending.slice(end + 1);
      }
    }
    if (pending) this.#line(pending, stdout);
  }

  #line(line: string, stdout: boolean): void {
    this.lines.push(`${stdout ? "out" : "err"}: ${line}`);
    const link = /^Open in your browser: (\S+)$/.exec(line);
    if (stdout && link) this.link = new URL(link[1]!);
    const event = stdout ? parseEvent(line) : null;
    if (event) this.events.push(event);
    this.#notify();
  }

  #notify(): void {
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
  }

  get token(): string {
    const token = this.link?.searchParams.get("token");
    if (!token) throw new Error("the sidecar printed no access link");
    return token;
  }

  get origin(): string {
    if (!this.link) throw new Error("the sidecar printed no access link");
    return this.link.origin;
  }

  /** Output with the access code masked, safe to print. */
  transcript(): string {
    const token = this.link?.searchParams.get("token");
    const text = this.lines.join("\n");
    return token ? text.replaceAll(token, "<token>") : text;
  }

  async until(predicate: () => boolean, label: string, timeoutMs = 60_000): Promise<void> {
    const deadline = AbortSignal.timeout(timeoutMs);
    while (!predicate()) {
      if (deadline.aborted) throw new Error(`timed out waiting for ${label}\n${this.transcript()}`);
      const changed = Promise.withResolvers<void>();
      this.#waiters.add(changed.resolve);
      deadline.addEventListener("abort", () => changed.resolve(), { once: true });
      await changed.promise;
    }
  }

  ready(): Promise<void> {
    return this.until(
      () => this.events.some((event) => event.type === "ready" || event.type === "failed") || this.exitCode !== null,
      "the ready event",
    );
  }

  async exited(): Promise<number> {
    await this.until(() => this.exitCode !== null, "the process to exit", 40_000);
    return this.exitCode!;
  }

  send(text: string): void {
    this.#child.stdin.write(text);
    void this.#child.stdin.flush();
  }

  closeInput(): void {
    void this.#child.stdin.end();
  }

  kill(): void {
    if (this.exitCode === null) this.#child.kill();
  }

  authed(path: string, init: RequestInit = {}, origin = this.origin): Promise<Response> {
    return fetch(`${this.origin}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.token}`, Origin: origin, ...init.headers },
    });
  }
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const timeout = AbortSignal.timeout(ms);
  const expired = Promise.withResolvers<never>();
  timeout.addEventListener("abort", () => expired.reject(new Error(`timed out waiting for ${label}`)), { once: true });
  return Promise.race([promise, expired.promise]);
}

async function step(name: string, body: () => Promise<void>): Promise<void> {
  await body();
  console.log(`ok - ${name}`);
}

function directoryDigest(directory: string): string {
  const hash = createHash("sha256");
  for (const name of readdirSync(directory).sort()) {
    hash.update(name).update(readFileSync(join(directory, name)));
  }
  return hash.digest("hex");
}

async function main(): Promise<void> {
  const flagValue = (name: string): string | undefined => {
    const at = process.argv.indexOf(name);
    return at === -1 ? undefined : process.argv[at + 1];
  };
  const target = getBuildTarget(flagValue("--target"));
  // `--binary` points the same checks at an installed or bundled copy instead of dist/sidecar.
  const binary = resolve(flagValue("--binary") ?? target.serverPath);
  expect(existsSync(binary), `${binary} is missing; run \`bun scripts/build.ts --target ${target.triple}\``);

  const work = mkdtempSync(join(tmpdir(), "lumo-smoke-"));
  // A cwd with no vendor/ or node_modules/: the compiled binary must carry everything itself.
  const cwd = join(work, "cwd");
  mkdirSync(cwd);
  const running: Sidecar[] = [];
  const start = (dataDirectory: string): Sidecar => {
    const sidecar = new Sidecar(binary, cwd, dataDirectory);
    running.push(sidecar);
    return sidecar;
  };

  try {
    const data = join(work, "data");

    // Cancellation: a model request in flight when the launcher asks for shutdown.
    const modelSeen = Promise.withResolvers<void>();
    const modelAborted = Promise.withResolvers<void>();
    const model = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        modelSeen.resolve();
        request.signal.addEventListener("abort", () => modelAborted.resolve());
        // Headers sent, body never finished: a model that is still thinking.
        return new Response(new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode(": wait\n\n")) }), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    try {
      const first = start(data);
      await step("starts, reports its phases and prints a loopback access link", async () => {
        await first.ready();
        expect(first.events.at(-1)?.type === "ready", `startup did not reach ready\n${first.transcript()}`);
        const codes = first.events.flatMap((event) => (event.type === "log" ? [event.code] : []));
        expect(JSON.stringify(codes) === JSON.stringify(["starting", "reader_ready", "assets_ready", "credentials_ready"]), `unexpected phases ${codes}`);
        expect(first.link?.hostname === "127.0.0.1" && first.link.pathname === "/", `unexpected link ${first.link?.origin}${first.link?.pathname}`);
        const ready = first.events.at(-1);
        expect(ready?.type === "ready" && isAbsolute(ready.dataDirectory), "ready must carry an absolute data directory");
        expect(!first.events.some((event) => JSON.stringify(event).includes(first.token)), "an event carries the access code");
      });

      await step("rejects requests without the access code and cross-origin writes", async () => {
        expect((await fetch(`${first.origin}/api/library`)).status === 401, "a request without the code must get 401");
        const library = await first.authed("/api/library");
        expect(library.ok, `GET /api/library gave ${library.status}`);
        const foreign = await first.authed(
          "/api/settings",
          { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uiLocale: "zh-CN" }) },
          "http://evil.example",
        );
        expect(foreign.status === 403, `a cross-origin write gave ${foreign.status}`);
      });

      await step("serves the embedded app, PDF.js and Typst assets from an empty working directory", async () => {
        const page = await fetch(`${first.origin}/?token=${first.token}`);
        expect(page.ok && (page.headers.get("content-type") ?? "").includes("text/html"), `the app page gave ${page.status}`);
        for (const path of [
          "/pdfjs/web/viewer.html",
          "/pdfjs/build/pdf.worker.mjs",
          "/typst/compiler.wasm",
          "/typst/renderer.wasm",
          "/typst/epub-viewer.html",
          "/typst/fonts/NotoSerifCJK.ttc",
        ]) {
          const response = await fetch(`${first.origin}${path}`);
          expect(response.ok && (await response.arrayBuffer()).byteLength > 0, `${path} gave ${response.status}`);
        }
      });

      let documentId = "";
      await step("saves data through the API", async () => {
        const locale = await first.authed("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uiLocale: "zh-CN" }),
        });
        expect(locale.ok, `saving the locale gave ${locale.status}`);
        const upload = await first.authed("/api/documents?name=smoke.pdf&pageCount=1&format=pdf", {
          method: "POST",
          headers: { "Content-Type": "application/pdf" },
          body: Buffer.from(fixturePdf("smoke", 1)),
        });
        expect(upload.ok, `the upload gave ${upload.status}`);
        documentId = idResponseSchema.parse(await upload.json()).id;
      });

      await step("shutdown cancels an in-flight model request, exits 0 and leaves a healthy database", async () => {
        const settings = await first.authed("/api/ai/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "custom",
            model: "smoke",
            baseUrl: `http://127.0.0.1:${model.port}/v1`,
            contextWindow: 128000,
            maxTokens: 4096,
          }),
        });
        expect(settings.ok, `saving the AI settings gave ${settings.status}`);
        let translateOutcome = "no answer";
        const translating = first
          .authed("/api/translate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              documentId,
              pageNumber: 1,
              targetLanguage: "en",
              format: "pdf",
              force: true,
              text: "hello",
              imageBase64: FIXTURE_JPEG.toString("base64"),
            }),
          })
          .then(async (response) => {
            translateOutcome = `${response.status} ${(await response.text()).slice(0, 300)}`;
          })
          .catch(() => {});
        await within(modelSeen.promise, 30_000, "the model request to arrive").catch((error: Error) => {
          throw new Error(`${error.message}; /api/translate answered ${translateOutcome}`);
        });
        expect(first.exitCode === null, "the server exited before the model was called");

        first.send(`${DESKTOP_SHUTDOWN_COMMAND}\n`);
        expect((await first.exited()) === 0, `shutdown exited with ${first.exitCode}\n${first.transcript()}`);
        await within(modelAborted.promise, 5_000, "the model request to be aborted");
        await translating;
        expect(first.events.at(-1)?.type === "stopped", "the last event must be `stopped`");
        expect(first.events.some((event) => event.type === "log" && event.code === "stopping"), "no `stopping` event");
        await fetch(first.origin).then(
          () => expect(false, "the port still answers after shutdown"),
          () => {},
        );
        const db = new Database(join(data, DB_FILENAME), { readonly: true });
        try {
          expect(JSON.stringify(db.query("PRAGMA integrity_check").get()) === '{"integrity_check":"ok"}', "the database is damaged");
          expect(JSON.stringify(db.query("PRAGMA user_version").get()) === `{"user_version":${SCHEMA_VERSION}}`, "unexpected schema version");
        } finally {
          db.close();
        }
      });

      const second = start(data);
      await step("restarts on the same data and exits 0 when the launcher disappears (end of input)", async () => {
        await second.ready();
        const ready = second.events.at(-1);
        expect(ready?.type === "ready" && ready.uiLocale === "zh-CN", `the saved locale was lost\n${second.transcript()}`);
        const library = libraryResponseSchema.parse(await (await second.authed("/api/library")).json());
        expect(library.documents.length === 1, "the saved document is gone");
        second.closeInput();
        expect((await second.exited()) === 0, `end of input exited with ${second.exitCode}`);
        expect(second.events.at(-1)?.type === "stopped", "the last event must be `stopped`");
      });
    } finally {
      model.stop(true);
    }

    const failure = async (name: string, dataDirectory: string, code: string, input = ""): Promise<void> => {
      await step(name, async () => {
        const sidecar = start(dataDirectory);
        if (input) sidecar.send(input);
        expect((await sidecar.exited()) === 1, `expected exit 1, got ${sidecar.exitCode}\n${sidecar.transcript()}`);
        const failed = sidecar.events.find((event) => event.type === "failed");
        expect(failed?.type === "failed" && failed.code === code, `expected ${code}\n${sidecar.transcript()}`);
        // A bad command races with startup, so only startup failures promise "never ready".
        if (input) return;
        expect(!sidecar.events.some((event) => event.type === "ready"), "a failed start must never report ready");
        expect(sidecar.link === null, "a failed start must not print an access link");
      });
    };

    await failure("a relative data directory is DATA_DIRECTORY_INVALID", "relative-data", "DATA_DIRECTORY_INVALID");
    const notADirectory = join(work, "file");
    writeFileSync(notADirectory, "x");
    await failure("a data directory that is a file is READER_DATABASE_FAILED", notADirectory, "READER_DATABASE_FAILED");

    // A database of another schema is rejected and left byte for byte as it was.
    const old = join(work, "old");
    mkdirSync(old);
    const legacy = new Database(join(old, DB_FILENAME));
    legacy.exec("CREATE TABLE documents (id TEXT PRIMARY KEY); PRAGMA user_version = 3;");
    legacy.close();
    const before = directoryDigest(old);
    await failure("an old-schema database is rejected", old, "READER_DATABASE_FAILED");
    expect(directoryDigest(old) === before, "the rejected database was modified");

    await failure("a malformed launcher command is CONTROL_PROTOCOL_INVALID", join(work, "control"), "CONTROL_PROTOCOL_INVALID", "not json\n");
  } finally {
    for (const sidecar of running) sidecar.kill();
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`desktop sidecar smoke passed for ${target.triple}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
