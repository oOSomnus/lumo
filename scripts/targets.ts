export type BuildTarget = {
  /** Rust target triple; also the suffix Tauri expects on external binaries. */
  triple: string;
  bunTarget: string;
  platform: "windows" | "macos" | "linux";
  arch: "x64" | "arm64";
  /** `.exe` on Windows, empty elsewhere. */
  extension: string;
  /** Compiled sidecar, relative to the repository root. */
  serverPath: string;
};

const ROWS = [
  ["x86_64-pc-windows-msvc", "bun-windows-x64", "windows", "x64"],
  ["aarch64-pc-windows-msvc", "bun-windows-arm64", "windows", "arm64"],
  ["x86_64-apple-darwin", "bun-darwin-x64", "macos", "x64"],
  ["aarch64-apple-darwin", "bun-darwin-arm64", "macos", "arm64"],
  ["x86_64-unknown-linux-gnu", "bun-linux-x64", "linux", "x64"],
  ["aarch64-unknown-linux-gnu", "bun-linux-arm64", "linux", "arm64"],
] as const;

export const BUILD_TARGETS: readonly BuildTarget[] = ROWS.map(
  ([triple, bunTarget, platform, arch]) => {
    const extension = platform === "windows" ? ".exe" : "";
    return {
      triple,
      bunTarget,
      platform,
      arch,
      extension,
      serverPath: `dist/sidecar/lumo-server-${triple}${extension}`,
    };
  },
);

const HOST_PLATFORMS: Record<string, BuildTarget["platform"]> = {
  win32: "windows",
  darwin: "macos",
  linux: "linux",
};

/** Looks up `triple`, or the host's row when omitted; unknown input throws before any build work. */
export function getBuildTarget(triple?: string): BuildTarget {
  const wanted = triple
    ? BUILD_TARGETS.find((target) => target.triple === triple)
    : BUILD_TARGETS.find(
        (target) =>
          target.platform === HOST_PLATFORMS[process.platform] &&
          target.arch === process.arch,
      );
  if (!wanted) {
    throw new Error(
      triple
        ? `unsupported target ${triple}; expected one of ${BUILD_TARGETS.map((target) => target.triple).join(", ")}`
        : `unsupported host ${process.platform}/${process.arch}`,
    );
  }
  return wanted;
}
