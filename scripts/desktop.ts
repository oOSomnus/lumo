import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { signingPlan, signingStatus, windowsSigningCommand } from "./signing";
import { getBuildTarget } from "./targets";

const root = resolve(import.meta.dir, "..");

const BUNDLES = {
  windows: "nsis",
  macos: "app,dmg",
  linux: "deb,rpm,appimage",
} as const;

async function run(label: string, command: string[]): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${label} failed with exit code ${code}`);
}

async function buildPanel(): Promise<void> {
  const outdir = join(root, "dist", "desktop");
  rmSync(outdir, { recursive: true, force: true });
  const result = await Bun.build({
    entrypoints: [join(root, "src", "desktop", "index.html")],
    target: "browser",
    minify: true,
    env: "disable",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    outdir,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("desktop panel build failed");
  }
}

async function main(): Promise<void> {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode !== "dev" && mode !== "build") {
    throw new Error("usage: bun scripts/desktop.ts <dev|build> [--target <triple>]");
  }
  const flag = rest.indexOf("--target");
  const requested = flag === -1 ? undefined : rest[flag + 1];
  if (flag !== -1 && !requested) throw new Error("--target needs a Rust target triple");
  if (rest.length !== (flag === -1 ? 0 : 2)) {
    throw new Error(`unexpected arguments: ${rest.join(" ")}`);
  }
  const target = getBuildTarget(requested);
  const bun = process.execPath;
  // Half a credential set must stop the build before any slow step runs.
  const signing = mode === "build" ? signingPlan(target.platform, process.env) : null;

  await run("PDF.js preparation", [bun, "scripts/fetch-pdfjs.ts"]);
  await run("Typst preparation", [bun, "scripts/prepare-typst.ts"]);
  await run("third-party notices", [bun, "scripts/licenses.ts"]);
  await run("server build", [bun, "scripts/build.ts", "--target", target.triple]);
  await buildPanel();

  const statusFile = join(root, "dist", "signing-status.txt");
  rmSync(statusFile, { force: true });
  const tauri = [bun, "run", "tauri", mode, "--target", target.triple];
  if (mode === "build" && signing) {
    tauri.push("--bundles", BUNDLES[target.platform]);
    if (signing.config) {
      const configPath = join(root, "dist", "tauri-signing.json");
      writeFileSync(configPath, JSON.stringify(signing.config));
      tauri.push("--config", configPath);
    }
  }
  // Windows imports the certificate for exactly the duration of this command and removes it, key included, afterwards.
  await run("Tauri", signing?.importWindowsCertificate ? windowsSigningCommand(tauri) : tauri);
  if (signing) {
    // Written only after Tauri succeeded: a failed signing step never leaves a "signed" claim behind.
    const status = signingStatus(target.platform, signing);
    writeFileSync(statusFile, `${status}\n`);
    console.log(`Signing: ${status}`);
  }
}

try {
  await main();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
