import { join } from "node:path";
import type { BuildTarget } from "./targets";

export interface SigningPlan {
  /** True only when a real certificate signs the installer/app. Never true for ad-hoc. */
  signed: boolean;
  notarized: boolean;
  /** Extra Tauri configuration merged over `tauri.conf.json`; null when nothing changes. */
  config: Record<string, unknown> | null;
  /** The Windows certificate must be imported into the user's store before building. */
  importWindowsCertificate: boolean;
}

type Environment = Record<string, string | undefined>;

const WINDOWS = [
  "WINDOWS_CERTIFICATE",
  "WINDOWS_CERTIFICATE_PASSWORD",
  "WINDOWS_CERTIFICATE_THUMBPRINT",
  "WINDOWS_TIMESTAMP_URL",
] as const;
const MACOS_SIGNING = [
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
] as const;
const MACOS_NOTARIZATION = ["APPLE_API_ISSUER", "APPLE_API_KEY", "APPLE_API_KEY_PATH"] as const;
const UPDATER = [
  "LUMO_UPDATER_PUBLIC_KEY",
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
] as const;

export const UPDATER_ENDPOINT =
  "https://github.com/oOSomnus/lumo/releases/latest/download/latest.json";

/** All of a group or none of it: half a credential set is a configuration error, not "unsigned". */
function group(env: Environment, names: readonly string[]): "none" | "all" {
  const missing = names.filter((name) => !env[name]);
  if (missing.length === names.length) return "none";
  if (missing.length > 0) {
    throw new Error(`incomplete signing credentials: ${missing.join(", ")} missing`);
  }
  return "all";
}

export function signingPlan(platform: BuildTarget["platform"], env: Environment): SigningPlan {
  const plan: SigningPlan = { signed: false, notarized: false, config: null, importWindowsCertificate: false };

  if (platform === "windows") {
    if (group(env, WINDOWS) === "all") {
      plan.signed = true;
      plan.importWindowsCertificate = true;
      plan.config = {
        bundle: {
          windows: {
            certificateThumbprint: env.WINDOWS_CERTIFICATE_THUMBPRINT,
            digestAlgorithm: "sha256",
            timestampUrl: env.WINDOWS_TIMESTAMP_URL,
          },
        },
      };
    }
  } else if (platform === "macos") {
    const signing = group(env, MACOS_SIGNING);
    const notarization = group(env, MACOS_NOTARIZATION);
    if (notarization === "all" && signing === "none") {
      throw new Error("notarization needs the Developer ID signing credentials as well");
    }
    if (signing === "all") {
      plan.signed = true;
      plan.notarized = notarization === "all";
      plan.config = { bundle: { macOS: { signingIdentity: env.APPLE_SIGNING_IDENTITY } } };
    }
  }
  return plan;
}

/** The signed updater feed and its public key; all three inputs or none, never a half-configured feed. */
export function updaterPlan(env: Environment): Record<string, unknown> | null {
  if (group(env, UPDATER) === "none") return null;
  return {
    bundle: { createUpdaterArtifacts: true },
    plugins: {
      updater: {
        pubkey: env.LUMO_UPDATER_PUBLIC_KEY,
        endpoints: [UPDATER_ENDPOINT],
        // The manifest is not signed; bind its announced version to the signed package.
        requireSignedVersion: true,
      },
    },
  };
}

/** Merges the bundle/plugin sections of per-feature Tauri configs; other keys are replaced. */
export function mergeBuildConfigs(
  ...configs: (Record<string, unknown> | null | undefined)[]
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const config of configs) {
    for (const [key, value] of Object.entries(config ?? {})) {
      merged[key] =
        key === "bundle" || key === "plugins"
          ? { ...(merged[key] as object | undefined), ...(value as object) }
          : value;
    }
  }
  return merged;
}

/** `command` wrapped so the Windows certificate exists only while it runs (scripts/windows-signing.ps1). */
export function windowsSigningCommand(command: string[]): string[] {
  return [
    "powershell",
    "-NoProfile",
    "-NonInteractive",
    // Per process only: a fresh ps1 must run under the default execution policy too.
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(import.meta.dir, "windows-signing.ps1"),
    "-CommandJson",
    JSON.stringify(command),
  ];
}

/** `env` without PowerShell 7's module path, which Windows PowerShell 5.1 cannot load modules from. */
export function windowsSigningEnvironment(env: Environment): Environment {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name.toUpperCase() !== "PSMODULEPATH"));
}

/** What users are told about a build, from the credentials it was made with. */
export function signingStatus(platform: BuildTarget["platform"], plan: SigningPlan): string {
  if (platform === "windows") {
    return plan.signed ? "signed" : "unsigned (Windows SmartScreen will warn)";
  }
  if (platform === "macos") {
    if (plan.notarized) return "Developer ID signed and notarized";
    return plan.signed ? "Developer ID signed, not notarized" : "ad-hoc signed, not notarized (Gatekeeper will warn)";
  }
  return "not applicable";
}
