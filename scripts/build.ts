import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const vendorPdfjs = join(root, "vendor", "pdfjs");
const vendorTypst = join(root, "vendor", "typst");
const outfile = join(root, "dist", "lumo");

mkdirSync(join(root, "dist"), { recursive: true });

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
    target: "bun-linux-x64",
    outfile,
    assets: [vendorPdfjs, vendorTypst],
    autoloadDotenv: false,
    autoloadBunfig: false,
    autoloadTsconfig: false,
    autoloadPackageJson: false,
  },
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log(`Built ${outfile}`);
