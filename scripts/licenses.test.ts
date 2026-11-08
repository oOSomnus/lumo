import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectNpmEntries, renderNotices } from "./licenses";

let project: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "lumo-licenses-"));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

function install(directory: string, manifest: Record<string, unknown>, files: Record<string, string> = {}): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text);
}

test("collects the production closure, resolving nested versions and skipping dev and missing packages", () => {
  install(project, {
    name: "app",
    version: "1.0.0",
    dependencies: { "@scope/a": "1", b: "1" },
    devDependencies: { devtool: "1" },
  });
  const modules = join(project, "node_modules");
  install(join(modules, "@scope", "a"), { name: "@scope/a", version: "1.0.0", license: "MIT", dependencies: { c: "2" } }, { LICENSE: "MIT text" });
  install(join(modules, "@scope", "a", "node_modules", "c"), { name: "c", version: "2.0.0", license: "ISC" });
  install(join(modules, "c"), { name: "c", version: "1.0.0", license: "ISC" });
  install(
    join(modules, "b"),
    { name: "b", version: "1.0.0", licenses: [{ type: "MIT" }], optionalDependencies: { "not-installed": "1" } },
    { "LICENSE.md": "MIT text", "README.md": "not a license" },
  );
  install(join(modules, "devtool"), { name: "devtool", version: "9.9.9", license: "MIT" });

  const entries = collectNpmEntries(project);
  expect(entries.map((entry) => `${entry.name}@${entry.version}`).sort()).toEqual([
    "@scope/a@1.0.0",
    "b@1.0.0",
    "c@2.0.0",
  ]);
  expect(entries.find((entry) => entry.name === "b")?.license).toBe("MIT");
  expect(entries.find((entry) => entry.name === "c")?.texts).toEqual([]);
  expect(entries.find((entry) => entry.name === "b")?.texts.map((text) => text.file)).toEqual(["LICENSE.md"]);
});

test("prints each distinct license text once and flags packages that ship none", () => {
  const text = "Permission is hereby granted";
  const notices = renderNotices([
    { ecosystem: "npm", name: "one", version: "1.0.0", license: "MIT", source: null, texts: [{ file: "LICENSE", text }] },
    { ecosystem: "cargo", name: "two", version: "2.0.0", license: "MIT", source: null, texts: [{ file: "LICENSE-MIT", text }] },
    { ecosystem: "cargo", name: "bare", version: "3.0.0", license: "Zlib", source: "https://example.test/bare", texts: [] },
  ]);
  expect(notices.split(text)).toHaveLength(2);
  expect(notices).toContain("one 1.0.0 (npm) — MIT — license text [1]");
  expect(notices).toContain("two 2.0.0 (cargo) — MIT — license text [1]");
  expect(notices).toContain("bare 3.0.0 (cargo) — Zlib — metadata only, the package ships no license text; see https://example.test/bare");
});
