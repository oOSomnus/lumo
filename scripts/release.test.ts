import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allInstallerNames, assertTagMatches, collectInstallers, finalizeRelease, installerNames } from "./release";
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
      write(join(input, `release-${target.triple}`, "THIRD_PARTY_NOTICES.txt"), "notices");
      write(join(input, `release-${target.triple}`, `signing-${target.triple}.txt`), "unsigned");
    }
    return input;
  }

  test("publishes all ten installers with checksums that match the files", () => {
    const out = join(work, "out");
    const listed = finalizeRelease(downloads(), out, "1.2.3", license());
    expect(listed).toContain("SHA256SUMS");
    expect(readdirSync(out)).toHaveLength(14);
    for (const line of readFileSync(join(out, "SHA256SUMS"), "utf8").trim().split("\n")) {
      const [hash, name] = line.split("  ");
      expect(hash).toBe(createHash("sha256").update(readFileSync(join(out, name!))).digest("hex"));
    }
    expect(readFileSync(join(out, "SIGNING.txt"), "utf8")).toContain("windows x64: unsigned");
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
