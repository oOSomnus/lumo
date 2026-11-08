import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import packageJson from "../package.json";
import { getBuildTarget } from "./targets";

const root = resolve(import.meta.dir, "..");
const vendorPdfjs = join(root, "vendor", "pdfjs");
const vendorTypst = join(root, "vendor", "typst");

const targetFlag = process.argv.indexOf("--target");
const requested = targetFlag === -1 ? undefined : process.argv[targetFlag + 1];
if (targetFlag !== -1 && !requested) {
  console.error("--target needs a Rust target triple");
  process.exit(1);
}
const target = getBuildTarget(requested);
const outfile = join(root, target.serverPath);

// Windows resources need exactly four numeric parts.
const windowsVersion = [...packageJson.version.split(/[-+]/)[0]!.split("."), "0", "0", "0", "0"]
  .slice(0, 4)
  .join(".");

mkdirSync(dirname(outfile), { recursive: true });

const result = await Bun.build({
  entrypoints: [join(root, "src", "server", "index.ts")],
  target: "bun",
  format: "esm",
  minify: true,
  splitting: false,
  env: "disable",
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  compile: {
    target: target.bunTarget as Bun.Build.CompileTarget,
    outfile,
    assets: [vendorPdfjs, vendorTypst],
    autoloadDotenv: false,
    autoloadBunfig: false,
    autoloadTsconfig: false,
    autoloadPackageJson: false,
    ...(target.platform === "windows"
      ? {
          windows: {
            icon: join(root, "src-tauri", "icons", "icon.ico"),
            title: "Lumo server",
            publisher: "Lumo",
            version: windowsVersion,
            description: "Lumo local server",
          },
        }
      : {}),
  },
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log(`Built ${outfile}`);
