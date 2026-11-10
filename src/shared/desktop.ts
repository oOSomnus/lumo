import type { UiLocale } from "./contracts";

/**
 * Line protocol between the desktop launcher and the `--desktop` server, over the
 * child's stdio only. Every record is one JSON line and carries fixed codes, never
 * free-form error text, so it is safe to show and to log.
 */
export const DESKTOP_LOG_CODES = [
  "starting",
  "reader_ready",
  "assets_ready",
  "credentials_ready",
  "stopping",
] as const;

export const DESKTOP_FAILURE_CODES = [
  "DATA_DIRECTORY_INVALID",
  "READER_DATABASE_FAILED",
  "PDFJS_ASSETS_FAILED",
  "TYPST_ASSETS_FAILED",
  "CREDENTIALS_DATABASE_FAILED",
  "SERVER_LISTEN_FAILED",
  "CONTROL_PROTOCOL_INVALID",
] as const;

export type DesktopLogCode = (typeof DESKTOP_LOG_CODES)[number];
export type DesktopFailureCode = (typeof DESKTOP_FAILURE_CODES)[number];

export type DesktopEvent =
  | { type: "log"; code: DesktopLogCode }
  | { type: "ready"; dataDirectory: string; uiLocale: UiLocale }
  | { type: "failed"; code: DesktopFailureCode }
  | { type: "stopped" };

/** The launcher's only command, sent as one line on the server's stdin. */
export const DESKTOP_SHUTDOWN_COMMAND = '{"type":"shutdown"}';
export const DESKTOP_MAX_COMMAND_BYTES = 8 * 1024;
/** Upper bound for a graceful stop; past it the server exits non-zero and SQLite rolls back. */
export const DESKTOP_SHUTDOWN_TIMEOUT_MS = 35_000;

/**
 * What the launcher panel may show and do. The Rust launcher (`src-tauri/src/launcher.rs`)
 * produces these; the access code never appears in any of them.
 */
export const LAUNCHER_ONLY_LOG_CODES = [
  "ready",
  "browser_opened",
  "browser_open_failed",
  "link_copied",
  "clipboard_failed",
  "sidecar_missing",
  "protocol_failed",
  "startup_timeout",
  "server_exited",
  "shutdown_timeout",
] as const;

export type LauncherLogCode =
  | DesktopLogCode
  | DesktopFailureCode
  | (typeof LAUNCHER_ONLY_LOG_CODES)[number];

export type LauncherPhase = "starting" | "running" | "stopping" | "failed";

export type LauncherUpdatePhase =
  | "disabled"
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "failed";

export type LauncherUpdateError =
  | "check_failed"
  | "download_failed"
  | "shutdown_failed"
  | "install_failed";

export interface LauncherUpdateState {
  phase: LauncherUpdatePhase;
  /** The version the feed offered, or the running one while checking/current. */
  version: string | null;
  /** In-app installs on Windows, macOS and AppImage; deb/rpm open the release page. */
  installMode: "in-app" | "download";
  errorCode: LauncherUpdateError | null;
}

export interface LauncherLogEntry {
  at: number;
  level: "info" | "warn" | "error";
  code: LauncherLogCode;
}

export interface LauncherSnapshot {
  /** Rises with every change; a snapshot older than the one shown is ignored. */
  revision: number;
  version: string;
  phase: LauncherPhase;
  /** The local address without the access code. */
  webUiUrl: string | null;
  dataDirectory: string | null;
  uiLocale: UiLocale | null;
  failureCode: LauncherLogCode | null;
  canRetry: boolean;
  update: LauncherUpdateState;
  logs: LauncherLogEntry[];
}
