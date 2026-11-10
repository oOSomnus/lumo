import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { UiLocale } from "../shared/contracts";
import type { LauncherSnapshot } from "../shared/desktop";

/** The panel keeps the newest snapshot it has seen; the initial fetch can arrive after an event. */
export function newerSnapshot(
  current: LauncherSnapshot | null,
  incoming: LauncherSnapshot,
): LauncherSnapshot {
  return current && incoming.revision < current.revision ? current : incoming;
}

/** The library's locale once the server reported it; before that, the system language. */
export function panelLocale(
  snapshot: LauncherSnapshot | null,
  systemLanguage: string,
): UiLocale {
  if (snapshot?.uiLocale) return snapshot.uiLocale;
  return systemLanguage.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export const launcher = {
  snapshot: () => invoke<LauncherSnapshot>("get_snapshot"),
  open: () => invoke<void>("open_webui"),
  copy: () => invoke<void>("copy_webui_url"),
  retry: () => invoke<void>("retry_start"),
  quit: () => invoke<void>("confirm_exit"),
  checkUpdates: () => invoke<void>("check_updates"),
  downloadUpdate: () => invoke<void>("download_update"),
  installUpdate: () => invoke<void>("install_update"),
  openUpdateDownload: () => invoke<void>("open_update_download"),
  onState: (handler: (snapshot: LauncherSnapshot) => void): Promise<UnlistenFn> =>
    listen<LauncherSnapshot>("launcher-state", (event) => handler(event.payload)),
  onQuitRequested: (handler: () => void): Promise<UnlistenFn> =>
    listen("quit-requested", handler),
};
