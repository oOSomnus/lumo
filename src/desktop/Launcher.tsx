import { useCallback, useEffect, useState } from "react";
import { Brand } from "../client/components/Brand";
import { ModalDialog } from "../client/components/ModalDialog";
import {
  AlertCircleIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  InfoIcon,
  PowerIcon,
  RetryIcon,
} from "../client/icons";
import { en } from "../client/locales/en";
import { zhCN } from "../client/locales/zh-CN";
import type { UiLocale } from "../shared/contracts";
import type { LauncherLogCode, LauncherLogEntry, LauncherSnapshot } from "../shared/desktop";
import { setThemePreference } from "../client/theme";
import { launcher, newerSnapshot, panelLocale } from "./ipc";

const catalogs = { en, "zh-CN": zhCN } satisfies Record<UiLocale, typeof en>;
const RECENT_LOGS = 4;
// What a button press reports back; the screen reader hears only these, not the whole activity list.
const ACTION_RESULTS: readonly LauncherLogCode[] = [
  "browser_opened",
  "browser_open_failed",
  "link_copied",
  "clipboard_failed",
];

function LogList({
  entries,
  locale,
  empty,
}: {
  entries: LauncherLogEntry[];
  locale: UiLocale;
  empty: string;
}) {
  const t = catalogs[locale].launcher;
  const time = new Intl.DateTimeFormat(locale, { timeStyle: "medium" });
  if (entries.length === 0) return <p className="muted">{empty}</p>;
  return (
    <ol className="launcher-log">
      {entries.map((entry, index) => (
        <li key={`${entry.at}-${index}`} data-level={entry.level}>
          <time dateTime={new Date(entry.at).toISOString()}>{time.format(entry.at)}</time>
          <span>{t.logs[entry.code]}</span>
        </li>
      ))}
    </ol>
  );
}

export function Launcher() {
  const [snapshot, setSnapshot] = useState<LauncherSnapshot | null>(null);
  const [confirmingQuit, setConfirmingQuit] = useState(false);
  const [confirmingUpdate, setConfirmingUpdate] = useState(false);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const [ipcFailed, setIpcFailed] = useState(false);

  const locale = panelLocale(snapshot, navigator.language);
  const t = catalogs[locale].launcher;
  const phase = snapshot?.phase ?? "starting";

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = "Lumo";
  }, [locale]);

  // The library's theme once the server reported it; before that, the system's light or dark.
  const theme = snapshot?.theme ?? "system";
  useEffect(() => setThemePreference(theme), [theme]);

  useEffect(() => {
    let active = true;
    const unlisten: Array<() => void> = [];
    const apply = (next: LauncherSnapshot): void => {
      if (active) setSnapshot((current) => newerSnapshot(current, next));
    };
    const subscribe = async (pending: Promise<() => void>): Promise<void> => {
      const stop = await pending;
      if (active) unlisten.push(stop);
      else stop();
    };
    // Subscribe first, then fetch, so a change between the two is never lost.
    void (async () => {
      try {
        await subscribe(launcher.onState(apply));
        await subscribe(launcher.onQuitRequested(() => active && setConfirmingQuit(true)));
        apply(await launcher.snapshot());
      } catch {
        if (active) setIpcFailed(true);
      }
    })();
    return () => {
      active = false;
      for (const stop of unlisten) stop();
    };
  }, []);

  const run = useCallback((command: () => Promise<void>) => {
    command().then(
      () => setIpcFailed(false),
      () => setIpcFailed(true),
    );
  }, []);

  const requestQuit = (): void => {
    if (phase === "running") setConfirmingQuit(true);
    else run(launcher.quit);
  };

  const status = {
    starting: t.statusStarting,
    running: t.statusRunning,
    stopping: t.statusStopping,
    failed: t.statusFailed,
  }[phase];
  const logs = snapshot?.logs ?? [];
  const latest = logs.at(-1);
  const outcome = latest && ACTION_RESULTS.includes(latest.code) ? latest : null;
  const update = snapshot?.update ?? null;
  const updateShown =
    update !== null &&
    update.version !== null &&
    update.version !== dismissedVersion &&
    !["disabled", "idle", "checking", "current"].includes(update.phase);
  const updateError = update
    ? update.errorCode === "check_failed"
      ? t.update.checkFailed
      : update.errorCode === "download_failed"
        ? t.update.downloadFailed
        : update.errorCode === "shutdown_failed"
          ? t.update.shutdownFailed
          : update.errorCode === "install_failed"
            ? t.update.installFailed
            : null
    : null;
  const retryUpdate = (): void => {
    if (!update) return;
    if (update.errorCode === "shutdown_failed") setConfirmingUpdate(true);
    else if (update.errorCode === "download_failed" || update.errorCode === "install_failed") {
      run(launcher.downloadUpdate);
    } else {
      run(launcher.checkUpdates);
    }
  };

  return (
    <main className="launcher">
      <header className="launcher-header">
        <Brand size={36} />
        {snapshot && <span className="badge">{t.version(snapshot.version)}</span>}
      </header>

      <section className="launcher-card launcher-status" data-phase={phase} aria-live="polite">
        <p className="status-pill" data-phase={phase}>
          <span className="status-dot" aria-hidden="true" />
          {status}
        </p>
        {snapshot?.failureCode && (
          <p className="alert error launcher-failure">
            <AlertCircleIcon size={16} />
            <span>{t.logs[snapshot.failureCode]}</span>
          </p>
        )}
        {snapshot?.failureCode === "READER_DATABASE_UPGRADE_REQUIRED" && (
          <p className="muted launcher-note" id="launcher-upgrade-note">{t.upgradeNote}</p>
        )}
        {ipcFailed && (
          <p className="alert error launcher-failure">
            <AlertCircleIcon size={16} />
            <span>{t.ipcFailed}</span>
          </p>
        )}

        <div className="launcher-address" aria-labelledby="launcher-address-label" role="group">
          <h2 id="launcher-address-label">{t.addressLabel}</h2>
          {snapshot?.webUiUrl ? <code>{snapshot.webUiUrl}</code> : <span className="muted">{t.addressPending}</span>}
          <p className="muted launcher-note">{t.addressNote}</p>
        </div>

        <div className="launcher-actions">
          {phase === "failed" && snapshot?.failureCode === "READER_DATABASE_UPGRADE_REQUIRED" ? (
            <button
              type="button"
              className="primary"
              disabled={!snapshot.canUpgrade}
              onClick={() => run(launcher.upgrade)}
              aria-describedby="launcher-upgrade-note"
            >
              <DownloadIcon size={16} />
              {t.upgrade}
            </button>
          ) : phase === "failed" ? (
            <button
              type="button"
              className="primary"
              disabled={!snapshot?.canRetry}
              onClick={() => run(launcher.retry)}
            >
              <RetryIcon size={16} />
              {t.retry}
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={phase !== "running"}
              onClick={() => run(launcher.open)}
            >
              <ExternalLinkIcon size={16} />
              {t.open}
            </button>
          )}
          <button type="button" disabled={phase !== "running"} onClick={() => run(launcher.copy)}>
            <CopyIcon size={16} />
            {t.copy}
          </button>
        </div>
        <p className="muted launcher-note">{t.copyNote}</p>
      </section>

      {/* A new node per outcome, so pressing the same button twice is announced twice. */}
      <p className="sr-only" role="status" aria-atomic="true">
        {outcome && <span key={`${outcome.at}-${logs.length}`}>{t.logs[outcome.code]}</span>}
      </p>

      {updateShown && update && (
        <section className="alert info launcher-update" aria-labelledby="launcher-update-label" aria-live="polite">
          <InfoIcon size={16} />
          <div className="launcher-update-body">
            <h2 id="launcher-update-label">{t.update.title}</h2>
            <p>
              {update.phase === "available" && t.update.available(update.version ?? "")}
              {update.phase === "downloading" && t.update.downloading}
              {update.phase === "ready" && t.update.ready}
              {update.phase === "installing" && t.update.installing}
              {update.phase === "failed" && updateError}
            </p>
            {(update.phase === "available" ||
              update.phase === "ready" ||
              update.phase === "failed") && (
              <div className="launcher-update-actions">
                {update.phase === "available" && (
                  <button
                    type="button"
                    className="primary"
                    onClick={() =>
                      run(
                        update.installMode === "in-app"
                          ? launcher.downloadUpdate
                          : launcher.openUpdateDownload,
                      )
                    }
                  >
                    {update.installMode === "in-app"
                      ? t.update.downloadUpdate
                      : t.update.downloadInstaller}
                  </button>
                )}
                {update.phase === "ready" && (
                  <button
                    type="button"
                    className="primary"
                    onClick={() => setConfirmingUpdate(true)}
                  >
                    {t.update.installNow}
                  </button>
                )}
                {update.phase === "failed" && (
                  <button type="button" className="primary" onClick={retryUpdate}>
                    {update.errorCode === "check_failed"
                      ? t.update.retryCheck
                      : update.errorCode === "shutdown_failed"
                        ? t.update.retryInstall
                        : t.update.retryDownload}
                  </button>
                )}
                <button type="button" className="ghost" onClick={() => setDismissedVersion(update.version)}>
                  {t.update.later}
                </button>
              </div>
            )}
          </div>
        </section>
      )}

      <section className="launcher-card" aria-labelledby="launcher-recent-label">
        <h2 id="launcher-recent-label">{t.recent}</h2>
        <LogList entries={logs.slice(-RECENT_LOGS)} locale={locale} empty={t.noActivity} />
        <details className="launcher-details">
          <summary>{t.details}</summary>
          <dl>
            <dt>{t.dataDirectory}</dt>
            <dd>{snapshot?.dataDirectory ?? "—"}</dd>
            {snapshot?.failureCode && (
              <>
                <dt>{t.failureCode}</dt>
                <dd>
                  <code>{snapshot.failureCode}</code>
                </dd>
              </>
            )}
          </dl>
          <h3>{t.allActivity}</h3>
          <div className="launcher-log-scroll" tabIndex={0}>
            <LogList entries={logs} locale={locale} empty={t.noActivity} />
          </div>
        </details>
      </section>

      <footer className="launcher-footer">
        <button type="button" className="ghost danger" disabled={phase === "stopping"} onClick={requestQuit}>
          <PowerIcon size={16} />
          {t.quit}
        </button>
      </footer>

      <ModalDialog
        open={confirmingUpdate}
        onClose={() => setConfirmingUpdate(false)}
        label={t.update.installTitle}
      >
        <h2>{t.update.installTitle}</h2>
        <p>{t.update.installBody}</p>
        <div className="dialog-actions">
          <button type="button" autoFocus onClick={() => setConfirmingUpdate(false)}>
            {t.update.installBack}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => {
              setConfirmingUpdate(false);
              run(launcher.installUpdate);
            }}
          >
            {t.update.installConfirm}
          </button>
        </div>
      </ModalDialog>

      <ModalDialog open={confirmingQuit} onClose={() => setConfirmingQuit(false)} label={t.quitTitle}>
        <h2>{t.quitTitle}</h2>
        <p>{t.quitBody}</p>
        <div className="dialog-actions">
          <button type="button" autoFocus onClick={() => setConfirmingQuit(false)}>
            {t.quitBack}
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => {
              setConfirmingQuit(false);
              run(launcher.quit);
            }}
          >
            {t.quitConfirm}
          </button>
        </div>
      </ModalDialog>
    </main>
  );
}
