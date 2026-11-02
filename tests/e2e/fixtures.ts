import {
  expect,
  request as playwrightRequest,
  test as base,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface DocumentRecord {
  id: string;
  name: string;
  pageCount: number;
}

export interface LumoApp {
  url: string;
  api: APIRequestContext;
}

const STARTUP_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;

function redact(text: string): string {
  return text
    .replace(/([?&]token=)[^\s&]+/g, "$1***")
    .replace(/Bearer\s+\S+/g, "Bearer ***");
}

export function fixturePdf(label: string, pageCount = 2): Uint8Array {
  const pageIds = [
    3,
    ...Array.from({ length: pageCount - 1 }, (_, i) => i + 7),
  ];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /AcroForm 6 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /Helv 4 0 R >> >> /Annots [5 0 R] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Type /Annot /Subtype /Widget /FT /Tx /T (note) /V (${label}) /Rect [40 300 300 330] /P 3 0 R /F 4 /DA (/Helv 12 Tf 0 g) >>`,
    "<< /Fields [5 0 R] /DR << /Font << /Helv 4 0 R >> >> /DA (/Helv 12 Tf 0 g) /NeedAppearances true >>",
  ];
  for (let i = 1; i < pageCount; i++) {
    objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << >> >>");
  }
  let pdf = "%PDF-1.7\n";
  const offsets: number[] = [];
  for (const [i, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

export async function uploadPdf(
  api: APIRequestContext,
  name: string,
  pageCount: number,
  label = name,
): Promise<DocumentRecord> {
  const query = new URLSearchParams({ name, pageCount: String(pageCount) });
  const response = await api.post(`/api/documents?${query}`, {
    headers: { "Content-Type": "application/pdf" },
    data: Buffer.from(fixturePdf(label, pageCount)),
  });
  expect(response.ok(), `upload ${name} failed with HTTP ${response.status()}`).toBe(true);
  return (await response.json()) as DocumentRecord;
}

export async function openApp(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url);
  } catch (error) {
    throw new Error(redact(error instanceof Error ? error.message : String(error)));
  }
}

export function noteField(page: Page): Locator {
  return page
    .frameLocator("iframe.pdf-frame")
    .locator('input[name="note"]');
}

export function saveCopyButton(page: Page): Locator {
  return page.getByRole("button", {
    name: /^(?:Save edited copy|Saving copy…)$/,
  });
}

export async function openFromLibrary(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Library" });
  await library.getByRole("button").filter({ hasText: name }).first().click();
}

export const test = base.extend<{ lumo: LumoApp }>({
  lumo: async ({}, use, testInfo) => {
    const directory = mkdtempSync(join(tmpdir(), "lumo-major-"));
    const standalone = testInfo.project.name === "standalone";
    const command = standalone ? resolve("dist/lumo") : "bun";
    const args = standalone ? [] : [resolve("src/server/index.ts")];
    const child = spawn(command, args, {
      cwd: resolve("."),
      env: {
        ...process.env,
        NODE_ENV: standalone ? "production" : "development",
        LUMO_DATA_DIR: directory,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let log = "";
    let exited = false;
    const closedReady = Promise.withResolvers<void>();
    const closed = closedReady.promise;
    child.once("close", () => {
      exited = true;
      closedReady.resolve();
    });

    const ready = Promise.withResolvers<string>();
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      callback();
    };
    const inspect = (chunk: Buffer): void => {
      log += chunk.toString("utf8");
      const match = /Open in your browser: (\S+)/.exec(log);
      if (match) settle(() => ready.resolve(match[1]!));
    };
    child.stdout?.on("data", inspect);
    child.stderr?.on("data", inspect);
    const startupTimer = setTimeout(() => {
      settle(() =>
        ready.reject(
          new Error(
            `Lumo did not print its startup URL within ${STARTUP_TIMEOUT_MS}ms.\n${redact(log)}`,
          ),
        ),
      );
    }, STARTUP_TIMEOUT_MS);
    void closed.then(() => {
      settle(() =>
        ready.reject(
          new Error(`Lumo exited before it was ready.\n${redact(log)}`),
        ),
      );
    });

    let api: APIRequestContext | undefined;
    try {
      let url: string;
      try {
        url = await ready.promise;
      } finally {
        clearTimeout(startupTimer);
      }
      const parsed = new URL(url);
      const token = parsed.searchParams.get("token");
      if (!token) throw new Error("startup URL has no access code");
      api = await playwrightRequest.newContext({
        baseURL: parsed.origin,
        extraHTTPHeaders: {
          Authorization: `Bearer ${token}`,
          Origin: parsed.origin,
        },
      });
      const library = await api.get("/api/library");
      if (!library.ok()) {
        throw new Error(
          `GET /api/library failed with HTTP ${library.status()}: ${redact(await library.text())}`,
        );
      }
      await use({ url, api });
    } finally {
      await api?.dispose().catch(() => {});
      if (!exited) {
        child.kill("SIGTERM");
        let stopTimer: NodeJS.Timeout | undefined;
        const stopTimeout = new Promise<"timeout">((resolveTimeout) => {
          stopTimer = setTimeout(() => resolveTimeout("timeout"), STOP_TIMEOUT_MS);
        });
        const result = await Promise.race([
          closed.then(() => "closed" as const),
          stopTimeout,
        ]);
        clearTimeout(stopTimer);
        if (result === "timeout") {
          child.kill("SIGKILL");
          await closed;
        }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
});

export { expect };
