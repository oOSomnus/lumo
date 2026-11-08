/**
 * Release plumbing around the Tauri bundles.
 *   bun scripts/release.ts check-tag <tag>
 *   bun scripts/release.ts collect --target <triple>      -> dist/release/<triple>/
 *   bun scripts/release.ts finalize <inputDir> <outputDir> -> installers, notices, SHA256SUMS
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import packageJson from "../package.json";
import { BUILD_TARGETS, getBuildTarget, type BuildTarget } from "./targets";

const root = resolve(import.meta.dir, "..");

interface Installer {
  /** Tauri's bundle subdirectory and the extension of the file inside it. */
  directory: string;
  extension: string;
  name: (version: string, target: BuildTarget) => string;
}

const INSTALLERS: Record<BuildTarget["platform"], Installer[]> = {
  windows: [
    {
      directory: "nsis",
      extension: "-setup.exe",
      name: (version, target) => `lumo-v${version}-windows-${target.arch}-setup.exe`,
    },
  ],
  macos: [
    {
      directory: "dmg",
      extension: ".dmg",
      name: (version, target) => `lumo-v${version}-macos-${target.arch}.dmg`,
    },
  ],
  linux: [
    { directory: "deb", extension: ".deb", name: (v, t) => `lumo-v${v}-linux-${t.arch}.deb` },
    { directory: "rpm", extension: ".rpm", name: (v, t) => `lumo-v${v}-linux-${t.arch}.rpm` },
    { directory: "appimage", extension: ".AppImage", name: (v, t) => `lumo-v${v}-linux-${t.arch}.AppImage` },
  ],
};

export function installerNames(target: BuildTarget, version: string): string[] {
  return INSTALLERS[target.platform].map((installer) => installer.name(version, target));
}

export function allInstallerNames(version: string): string[] {
  return BUILD_TARGETS.flatMap((target) => installerNames(target, version));
}

export function assertTagMatches(tag: string, version: string): void {
  if (tag !== `v${version}`) {
    throw new Error(`tag ${tag} does not match package.json version ${version} (expected v${version})`);
  }
}

/** Copies exactly one bundle per format to its release name; a missing or ambiguous source fails. */
export function collectInstallers(bundleRoot: string, target: BuildTarget, version: string, outputDir: string): string[] {
  mkdirSync(outputDir, { recursive: true });
  return INSTALLERS[target.platform].map((installer) => {
    const directory = join(bundleRoot, installer.directory);
    const matches = existsSync(directory)
      ? readdirSync(directory).filter((file) => file.includes(version) && file.endsWith(installer.extension))
      : [];
    if (matches.length !== 1) {
      throw new Error(
        `${target.triple}: expected exactly one *${version}*${installer.extension} in ${directory}, found ${matches.length}${matches.length ? `: ${matches.join(", ")}` : ""}`,
      );
    }
    const name = installer.name(version, target);
    copyFileSync(join(directory, matches[0]!), join(outputDir, name));
    return name;
  });
}

function filesBelow(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * Gathers the per-target downloads into one release folder: every installer exactly once, one
 * notices file (all targets must agree), the license, signing status and `SHA256SUMS`.
 */
export function finalizeRelease(inputDir: string, outputDir: string, version: string, license: string): string[] {
  const files = filesBelow(inputDir);
  const named = (name: string): string[] => files.filter((file) => basename(file) === name);
  mkdirSync(outputDir, { recursive: true });

  const assets: string[] = [];
  for (const name of allInstallerNames(version)) {
    const found = named(name);
    if (found.length !== 1) throw new Error(`expected exactly one ${name}, found ${found.length}`);
    copyFileSync(found[0]!, join(outputDir, name));
    assets.push(name);
  }

  const notices = named("THIRD_PARTY_NOTICES.txt");
  if (notices.length === 0) throw new Error("no THIRD_PARTY_NOTICES.txt among the downloads");
  if (new Set(notices.map(sha256)).size !== 1) throw new Error("the targets produced different third-party notices");
  copyFileSync(notices[0]!, join(outputDir, "THIRD_PARTY_NOTICES.txt"));
  copyFileSync(license, join(outputDir, "LICENSE"));

  const signing = BUILD_TARGETS.map((target) => {
    const status = named(`signing-${target.triple}.txt`);
    if (status.length !== 1) throw new Error(`expected exactly one signing status for ${target.triple}, found ${status.length}`);
    return `${target.platform} ${target.arch}: ${readFileSync(status[0]!, "utf8").trim()}`;
  });
  writeFileSync(join(outputDir, "SIGNING.txt"), `${signing.join("\n")}\n`);

  const listed = [...assets, "THIRD_PARTY_NOTICES.txt", "LICENSE", "SIGNING.txt"];
  writeFileSync(
    join(outputDir, "SHA256SUMS"),
    `${listed.map((name) => `${sha256(join(outputDir, name))}  ${name}`).join("\n")}\n`,
  );
  return [...listed, "SHA256SUMS"];
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  const version = packageJson.version;
  if (command === "check-tag" && rest.length === 1) {
    assertTagMatches(rest[0]!, version);
  } else if (command === "collect" && rest[0] === "--target" && rest[1]) {
    const target = getBuildTarget(rest[1]);
    const output = join(root, "dist", "release", target.triple);
    const bundles = join(root, "src-tauri", "target", target.triple, "release", "bundle");
    const names = collectInstallers(bundles, target, version, output);
    for (const [source, name] of [
      [join(root, "dist", "notices", "THIRD_PARTY_NOTICES.txt"), "THIRD_PARTY_NOTICES.txt"],
      [join(root, "dist", "signing-status.txt"), `signing-${target.triple}.txt`],
    ] as const) {
      if (!existsSync(source)) throw new Error(`${source} is missing; run \`bun run build --target ${target.triple}\` first`);
      copyFileSync(source, join(output, name));
    }
    console.log(`Collected ${names.join(", ")} in ${output}`);
  } else if (command === "finalize" && rest.length === 2) {
    const names = finalizeRelease(resolve(rest[0]!), resolve(rest[1]!), version, join(root, "LICENSE"));
    console.log(`Release folder ${resolve(rest[1]!)}: ${names.join(", ")}`);
  } else {
    throw new Error("usage: bun scripts/release.ts check-tag <tag> | collect --target <triple> | finalize <inputDir> <outputDir>");
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
