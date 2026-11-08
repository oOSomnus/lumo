import { useCallback, useEffect, useState } from "react";
import { ModalDialog } from "../client/components/ModalDialog";
import iconUrl from "../client/favicon.svg";
import { en } from "../client/locales/en";
import { zhCN } from "../client/locales/zh-CN";
import type { UiLocale } from "../shared/contracts";
import type { LauncherLogCode, LauncherLogEntry, LauncherSnapshot } from "../shared/desktop";
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
  const [ipcFailed, setIpcFailed] = useState(false);

  const locale = panelLocale(snapshot, navigator.language);
  const t = catalogs[locale].launcher;
  const phase = snapshot?.phase ?? "starting";

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = "Lumo";
  }, [locale]);

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

  return (
    <main className="launcher">
      <header className="launcher-header">
        <img src={iconUrl} alt="" width="48" height="48" />
        <div>
          <h1>Lumo</h1>
          {snapshot && <p className="muted">{t.version(snapshot.version)}</p>}
        </div>
      </header>

      <section className="launcher-status" data-phase={phase} aria-live="polite">
        <p className="launcher-state">{status}</p>
        {snapshot?.failureCode && (
          <p className="launcher-failure">{t.logs[snapshot.failureCode]}</p>
        )}
        {ipcFailed && <p className="launcher-failure">{t.ipcFailed}</p>}
      </section>

      {/* A new node per outcome, so pressing the same button twice is announced twice. */}
      <p className="sr-only" role="status" aria-atomic="true">
        {outcome && <span key={`${outcome.at}-${logs.length}`}>{t.logs[outcome.code]}</span>}
      </p>

      <section aria-labelledby="launcher-address-label">
        <h2 id="launcher-address-label">{t.addressLabel}</h2>
        <p className="launcher-address">
          {snapshot?.webUiUrl ? <code>{snapshot.webUiUrl}</code> : <span className="muted">{t.addressPending}</span>}
        </p>
        <p className="muted launcher-note">{t.addressNote}</p>
      </section>

      <div className="launcher-actions">
        {phase === "failed" ? (
          <button
            type="button"
            className="primary"
            disabled={!snapshot?.canRetry}
            onClick={() => run(launcher.retry)}
          >
            {t.retry}
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={phase !== "running"}
            onClick={() => run(launcher.open)}
          >
            {t.open}
          </button>
        )}
        <button type="button" disabled={phase !== "running"} onClick={() => run(launcher.copy)}>
          {t.copy}
        </button>
        <button type="button" className="danger" disabled={phase === "stopping"} onClick={requestQuit}>
          {t.quit}
        </button>
      </div>
      <p className="muted launcher-note">{t.copyNote}</p>

      <section aria-labelledby="launcher-recent-label">
        <h2 id="launcher-recent-label">{t.recent}</h2>
        <LogList entries={logs.slice(-RECENT_LOGS)} locale={locale} empty={t.noActivity} />
      </section>

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
