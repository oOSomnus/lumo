import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allInstallerNames, assertTagMatches, collectInstallers, collectUpdaterArtifact, finalizeRelease, installerNames } from "./release";
import { BUILD_TARGETS, getBuildTarget } from "./targets";

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "lumo-release-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function write(path: string, text = "x"): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

describe("installer names", () => {
  test("ten installers: two Windows, two macOS, six Linux", () => {
    const names = allInstallerNames("1.2.3");
    expect(names).toHaveLength(10);
    expect(new Set(names).size).toBe(10);
    expect(names).toContain("lumo-v1.2.3-windows-arm64-setup.exe");
    expect(names).toContain("lumo-v1.2.3-macos-x64.dmg");
    expect(names).toContain("lumo-v1.2.3-linux-arm64.AppImage");
  });

  test("a tag must be v plus the package version", () => {
    expect(() => assertTagMatches("v1.2.3", "1.2.3")).not.toThrow();
    expect(() => assertTagMatches("1.2.3", "1.2.3")).toThrow(/does not match/);
    expect(() => assertTagMatches("v1.2.4", "1.2.3")).toThrow(/does not match/);
  });
});

describe("collectInstallers", () => {
  const linux = getBuildTarget("x86_64-unknown-linux-gnu");

  function bundles(): string {
    const root = join(work, "bundle");
    write(join(root, "deb", "Lumo_1.2.3_amd64.deb"), "deb");
    write(join(root, "rpm", "Lumo-1.2.3-1.x86_64.rpm"), "rpm");
    write(join(root, "appimage", "Lumo_1.2.3_amd64.AppImage"), "appimage");
    return root;
  }

  test("copies each bundle to its release name with the original bytes", () => {
    const out = join(work, "out");
    const names = collectInstallers(bundles(), linux, "1.2.3", out);
    expect(names.sort()).toEqual(installerNames(linux, "1.2.3").sort());
    expect(readFileSync(join(out, "lumo-v1.2.3-linux-x64.rpm"), "utf8")).toBe("rpm");
  });

  test("a missing format fails instead of shipping fewer files", () => {
    const root = bundles();
    rmSync(join(root, "rpm"), { recursive: true });
    expect(() => collectInstallers(root, linux, "1.2.3", join(work, "out"))).toThrow(/rpm.*found 0/);
  });

  test("a leftover bundle of another version is never picked up, and two candidates are ambiguous", () => {
    const root = bundles();
    write(join(root, "deb", "Lumo_1.2.2_amd64.deb"), "old");
    expect(readFileSync(join(work, "out", collectInstallers(root, linux, "1.2.3", join(work, "out"))[0]!), "utf8")).toBe("deb");
    write(join(root, "deb", "Lumo_1.2.3_other.deb"), "second");
    expect(() => collectInstallers(root, linux, "1.2.3", join(work, "out2"))).toThrow(/found 2/);
  });
});

describe("collectUpdaterArtifact", () => {
  function macos(): string {
    const root = join(work, "bundle");
    write(join(root, "macos", "Lumo.app.tar.gz"), "archive");
    write(join(root, "macos", "Lumo.app.tar.gz.sig"), "signature\n");
    return root;
  }

  test("copies the signed macOS update package and describes its manifest entry", () => {
    const out = join(work, "out");
    const target = getBuildTarget("aarch64-apple-darwin");
    const fragment = collectUpdaterArtifact(macos(), target, "1.2.3", out);
    expect(fragment.platform).toBe("darwin-aarch64");
    expect(fragment.signature).toBe("signature");
    expect(fragment.url).toBe(
      "https://github.com/oOSomnus/lumo/releases/download/v1.2.3/lumo-v1.2.3-macos-arm64.app.tar.gz",
    );
    expect(readFileSync(join(out, "lumo-v1.2.3-macos-arm64.app.tar.gz"), "utf8")).toBe("archive");
    expect(readFileSync(join(out, "lumo-v1.2.3-macos-arm64.app.tar.gz.sig"), "utf8")).toBe("signature\n");
  });

  test("refuses an update package without its signature", () => {
    const root = macos();
    rmSync(join(root, "macos", "Lumo.app.tar.gz.sig"));
    expect(() => collectUpdaterArtifact(root, getBuildTarget("aarch64-apple-darwin"), "1.2.3", join(work, "out"))).toThrow(
      /no updater signature/,
    );
  });

  test("a Windows updater entry points at the NSIS installer", () => {
    const root = join(work, "bundle");
    write(join(root, "nsis", "Lumo_1.2.3_x64-setup.exe"), "setup");
    write(join(root, "nsis", "Lumo_1.2.3_x64-setup.exe.sig"), "signature");
    const fragment = collectUpdaterArtifact(root, getBuildTarget("x86_64-pc-windows-msvc"), "1.2.3", join(work, "out"));
    expect(fragment.platform).toBe("windows-x86_64");
    expect(fragment.url).toBe(
      "https://github.com/oOSomnus/lumo/releases/download/v1.2.3/lumo-v1.2.3-windows-x64-setup.exe",
    );
  });

  test("a Linux updater entry points at the signed AppImage itself", () => {
    const root = join(work, "bundle");
    write(join(root, "appimage", "Lumo_1.2.3_amd64.AppImage"), "appimage");
    write(join(root, "appimage", "Lumo_1.2.3_amd64.AppImage.sig"), "signature");
    const fragment = collectUpdaterArtifact(
      root,
      getBuildTarget("x86_64-unknown-linux-gnu"),
      "1.2.3",
      join(work, "out"),
    );
    expect(fragment.platform).toBe("linux-x86_64");
    expect(fragment.url).toBe(
      "https://github.com/oOSomnus/lumo/releases/download/v1.2.3/lumo-v1.2.3-linux-x64.AppImage",
    );
    expect(readFileSync(join(work, "out", "lumo-v1.2.3-linux-x64.AppImage.sig"), "utf8")).toBe(
      "signature\n",
    );
  });
});

describe("finalizeRelease", () => {
  const license = () => {
    const file = join(work, "LICENSE");
    write(file, "MIT");
    return file;
  };

  function downloads(skip?: string): string {
    const input = join(work, "in");
    for (const target of BUILD_TARGETS) {
      for (const name of installerNames(target, "1.2.3")) {
        if (name !== skip) write(join(input, `release-${target.triple}`, name), name);
      }
      const platform = `${target.platform === "macos" ? "darwin" : target.platform}-${target.arch === "x64" ? "x86_64" : "aarch64"}`;
      const files =
        target.platform === "windows"
          ? [installerNames(target, "1.2.3")[0]!]
          : target.platform === "macos"
            ? [`lumo-v1.2.3-macos-${target.arch}.app.tar.gz`]
            : [`lumo-v1.2.3-linux-${target.arch}.AppImage`];
      const signature = `signature-${target.triple}`;
      for (const name of files) {
        if (name !== skip) {
          write(join(input, `release-${target.triple}`, name), name);
          write(join(input, `release-${target.triple}`, `${name}.sig`), signature);
        }
      }
      write(
        join(input, `release-${target.triple}`, `update-${target.triple}.json`),
        JSON.stringify({
          platform,
          url: `https://github.com/oOSomnus/lumo/releases/download/v1.2.3/${files[0]}`,
          signature,
          files: [...files, `${files[0]}.sig`],
        }),
      );
      write(join(input, `release-${target.triple}`, "THIRD_PARTY_NOTICES.txt"), "notices");
      write(join(input, `release-${target.triple}`, `signing-${target.triple}.txt`), "unsigned");
    }
    return input;
  }

  test("publishes all ten installers with checksums that match the files", () => {
    const out = join(work, "out");
    const listed = finalizeRelease(downloads(), out, "1.2.3", license());
    expect(listed).toContain("SHA256SUMS");
    expect(readdirSync(out)).toHaveLength(23);
    for (const line of readFileSync(join(out, "SHA256SUMS"), "utf8").trim().split("\n")) {
      const [hash, name] = line.split("  ");
      expect(hash).toBe(createHash("sha256").update(readFileSync(join(out, name!))).digest("hex"));
    }
    const manifest = JSON.parse(readFileSync(join(out, "latest.json"), "utf8"));
    expect(manifest.version).toBe("1.2.3");
    expect(Object.keys(manifest.platforms).sort()).toEqual([
      "darwin-aarch64",
      "darwin-x86_64",
      "linux-aarch64",
      "linux-x86_64",
      "windows-aarch64",
      "windows-x86_64",
    ]);
    expect(readFileSync(join(out, "SIGNING.txt"), "utf8")).toContain("windows x64: unsigned");
  });

  test("a missing update signature never becomes a release", () => {
    const input = downloads();
    rmSync(join(input, "release-aarch64-apple-darwin", "lumo-v1.2.3-macos-arm64.app.tar.gz.sig"));
    expect(() => finalizeRelease(input, join(work, "out"), "1.2.3", license())).toThrow(
      /update file lumo-v1\.2\.3-macos-arm64\.app\.tar\.gz\.sig.*found 0/,
    );
  });

  test("an incomplete set never becomes a release", () => {
    expect(() => finalizeRelease(downloads("lumo-v1.2.3-macos-arm64.dmg"), join(work, "out"), "1.2.3", license())).toThrow(
      /macos-arm64\.dmg.*found 0/,
    );
  });

  test("targets must agree on the notices", () => {
    const input = downloads();
    write(join(input, "release-aarch64-apple-darwin", "THIRD_PARTY_NOTICES.txt"), "different");
    expect(() => finalizeRelease(input, join(work, "out"), "1.2.3", license())).toThrow(/different third-party notices/);
  });
});
