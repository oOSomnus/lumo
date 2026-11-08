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
