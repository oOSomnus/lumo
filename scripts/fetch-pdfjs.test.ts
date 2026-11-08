import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { extractPdfjsArchive } from "./fetch-pdfjs";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "lumo-extract-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

async function archive(files: Record<string, Uint8Array | string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: "uint8array" });
}

test("extracts nested files with their original bytes", async () => {
  const binary = new Uint8Array([0, 255, 1, 254, 10, 13]);
  const destination = join(workspace, "out");
  await extractPdfjsArchive(
    await archive({
      "web/viewer.html": "<html></html>",
      "build/pdf.mjs": binary,
      "web/images/empty.svg": "",
    }),
    destination,
  );
  expect(readFileSync(join(destination, "web", "viewer.html"), "utf8")).toBe("<html></html>");
  expect(new Uint8Array(readFileSync(join(destination, "build", "pdf.mjs")))).toEqual(binary);
  expect(existsSync(join(destination, "web", "images", "empty.svg"))).toBe(true);
});

test.each([
  ["parent traversal", "../escape.txt"],
  ["nested traversal", "web/../../escape.txt"],
  ["absolute path", "/tmp/lumo-escape.txt"],
  ["drive letter", "C:/escape.txt"],
  ["backslash separator", "web\\..\\escape.txt"],
])("rejects %s without writing outside the destination", async (_label, name) => {
  const destination = join(workspace, "out");
  await expect(
    extractPdfjsArchive(await archive({ "ok.txt": "fine", [name]: "payload" }), destination),
  ).rejects.toThrow(/unsafe archive member/);
  expect(existsSync(join(workspace, "escape.txt"))).toBe(false);
  expect(existsSync(join(destination, "ok.txt"))).toBe(false);
});
