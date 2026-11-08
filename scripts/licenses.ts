import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

const root = resolve(import.meta.dir, "..");
const LICENSE_FILE = /^(licen[sc]e|copying|notice|unlicense)([._-].*)?$/i;

export interface NoticeEntry {
  ecosystem: "npm" | "cargo" | "bundled";
  name: string;
  version: string;
  /** SPDX expression or description as declared; "unknown" when the package declares none. */
  license: string;
  /** Upstream location for entries that carry no license text of their own. */
  source: string | null;
  texts: { file: string; text: string }[];
}

function licenseTexts(directory: string): NoticeEntry["texts"] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name))
    .map((entry) => ({
      file: entry.name,
      text: readFileSync(join(directory, entry.name), "utf8").trim(),
    }))
    .filter((entry) => entry.text !== "")
    .sort((a, b) => a.file.localeCompare(b.file));
}

const packageJsonSchema = z.object({
  name: z.string(),
  version: z.string(),
  license: z.union([z.string(), z.object({ type: z.string() })]).optional(),
  licenses: z.array(z.object({ type: z.string() })).optional(),
  repository: z.union([z.string(), z.object({ url: z.string().optional() })]).optional(),
  homepage: z.string().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
});

function declaredLicense(pkg: z.infer<typeof packageJsonSchema>): string {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license) return pkg.license.type;
  if (pkg.licenses?.length) return pkg.licenses.map((entry) => entry.type).join(" OR ");
  return "unknown";
}

function sourceLink(pkg: z.infer<typeof packageJsonSchema>): string | null {
  const repository = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  return repository ?? pkg.homepage ?? `https://www.npmjs.com/package/${pkg.name}`;
}

/** Node resolution: this package's own node_modules, then every ancestor directory's. */
function locate(from: string, name: string): string | null {
  for (let directory = from; ; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(directory) === directory) return null;
  }
}

/**
 * Every installed package a production install of `projectDirectory` would load: its
 * `dependencies`, and theirs recursively. Dev tools are not shipped and are left out.
 */
export function collectNpmEntries(projectDirectory: string): NoticeEntry[] {
  const project = packageJsonSchema.parse(
    JSON.parse(readFileSync(join(projectDirectory, "package.json"), "utf8")),
  );
  const seen = new Map<string, NoticeEntry>();
  const queue: Array<{ from: string; names: string[] }> = [
    { from: projectDirectory, names: Object.keys(project.dependencies ?? {}) },
  ];
  while (queue.length > 0) {
    const { from, names } = queue.shift()!;
    for (const name of names) {
      const directory = locate(from, name);
      if (!directory || seen.has(directory)) continue;
      const pkg = packageJsonSchema.parse(
        JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
      );
      seen.set(directory, {
        ecosystem: "npm",
        name: pkg.name,
        version: pkg.version,
        license: declaredLicense(pkg),
        source: sourceLink(pkg),
        texts: licenseTexts(directory),
      });
      queue.push({
        from: directory,
        names: [
          ...Object.keys(pkg.dependencies ?? {}),
          // Optional and peer packages only when they were installed.
          ...Object.keys(pkg.optionalDependencies ?? {}),
          ...Object.keys(pkg.peerDependencies ?? {}),
        ],
      });
    }
  }
  return [...seen.values()];
}

const cargoMetadataSchema = z.object({
  packages: z.array(
    z.object({
      name: z.string(),
      version: z.string(),
      license: z.string().nullable(),
      license_file: z.string().nullable(),
      repository: z.string().nullable(),
      source: z.string().nullable(),
      manifest_path: z.string(),
    }),
  ),
});

async function collectCargoEntries(): Promise<NoticeEntry[]> {
  const child = Bun.spawn(
    [
      "cargo",
      "metadata",
      "--locked",
      "--format-version",
      "1",
      "--manifest-path",
      join(root, "src-tauri", "Cargo.toml"),
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw new Error("cargo metadata failed");
  const metadata = cargoMetadataSchema.parse(JSON.parse(output));
  return metadata.packages
    .filter((pkg) => pkg.source !== null) // the launcher itself is Lumo's own MIT code
    .map((pkg) => {
      const directory = dirname(pkg.manifest_path);
      const texts = licenseTexts(directory);
      if (texts.length === 0 && pkg.license_file) {
        const file = join(directory, pkg.license_file);
        if (existsSync(file)) texts.push({ file: pkg.license_file, text: readFileSync(file, "utf8").trim() });
      }
      return {
        ecosystem: "cargo" as const,
        name: pkg.name,
        version: pkg.version,
        license: pkg.license ?? "see license file",
        source: pkg.repository ?? `https://crates.io/crates/${pkg.name}`,
        texts,
      };
    });
}

function vendoredEntries(): NoticeEntry[] {
  const entries: NoticeEntry[] = [];
  const pdfjs = join(root, "vendor", "pdfjs", "LICENSE");
  if (!existsSync(pdfjs)) throw new Error("vendor/pdfjs/LICENSE is missing; run `bun run prepare:pdfjs`");
  entries.push({
    ecosystem: "bundled",
    name: "PDF.js",
    version: "vendored viewer",
    license: "Apache-2.0",
    source: "https://github.com/mozilla/pdf.js",
    texts: [{ file: "LICENSE", text: readFileSync(pdfjs, "utf8").trim() }],
  });
  const typstLicenses = join(root, "vendor", "typst", "licenses");
  if (!existsSync(typstLicenses)) throw new Error("vendor/typst/licenses is missing; run `bun run prepare:typst`");
  for (const name of readdirSync(typstLicenses).sort()) {
    const file = join(typstLicenses, name);
    if (!statSync(file).isFile()) continue;
    entries.push({
      ecosystem: "bundled",
      name: `Bundled license file ${name}`,
      version: "vendored",
      license: "see text",
      source: null,
      texts: [{ file: name, text: readFileSync(file, "utf8").trim() }],
    });
  }
  return entries;
}

async function bunEntry(): Promise<NoticeEntry> {
  const cache = join(root, "dist", "notices", "cache");
  const cached = join(cache, `bun-${Bun.revision}-LICENSE.md`);
  if (!existsSync(cached)) {
    const url = `https://raw.githubusercontent.com/oven-sh/bun/${Bun.revision}/LICENSE.md`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Bun license download failed with HTTP ${response.status}: ${url}`);
    mkdirSync(cache, { recursive: true });
    writeFileSync(cached, await response.text());
  }
  return {
    ecosystem: "bundled",
    name: "Bun runtime",
    version: `${Bun.version} (${Bun.revision.slice(0, 9)})`,
    license: "MIT, with statically linked libraries under their own licenses (listed in the text)",
    source: "https://github.com/oven-sh/bun",
    texts: [{ file: "LICENSE.md", text: readFileSync(cached, "utf8").trim() }],
  };
}

export function renderNotices(entries: NoticeEntry[]): string {
  const sorted = [...entries].sort(
    (a, b) =>
      a.ecosystem.localeCompare(b.ecosystem) ||
      a.name.localeCompare(b.name) ||
      a.version.localeCompare(b.version),
  );
  // Identical texts are printed once and referenced by number.
  const texts = new Map<string, { id: number; text: string }>();
  const lines: string[] = [];
  for (const entry of sorted) {
    const ids = entry.texts.map(({ text }) => {
      const key = createHash("sha256").update(text).digest("hex");
      let known = texts.get(key);
      if (!known) {
        known = { id: texts.size + 1, text };
        texts.set(key, known);
      }
      return known.id;
    });
    const where = ids.length > 0
      ? `license text ${[...new Set(ids)].map((id) => `[${id}]`).join(", ")}`
      : `metadata only, the package ships no license text; see ${entry.source ?? "its upstream project"}`;
    lines.push(`- ${entry.name} ${entry.version} (${entry.ecosystem}) — ${entry.license} — ${where}`);
  }
  const header = [
    "Lumo third-party notices",
    "",
    "Lumo is MIT licensed (see LICENSE). The desktop app bundles the components below.",
    "Entries are grouped by where they come from; each license text is printed once.",
    "",
    "Components",
    "----------",
  ];
  const body = [...texts.values()].flatMap(({ id, text }) => [
    "",
    `[${id}] ${"=".repeat(70)}`,
    text,
  ]);
  return [...header, ...lines, ...body, ""].join("\n");
}

async function main(): Promise<void> {
  const entries = [
    await bunEntry(),
    ...vendoredEntries(),
    ...collectNpmEntries(root),
    ...(await collectCargoEntries()),
  ];
  const output = join(root, "dist", "notices", "THIRD_PARTY_NOTICES.txt");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, renderNotices(entries));
  console.log(`Wrote ${output} (${entries.length} components)`);
}

if (import.meta.main) await main();
