import type { TypstRepairProgress } from "../../shared/contracts";
import { errorText, useI18n, type Messages } from "../i18n";
import type { TranslationTask, TypstRepairRound } from "../translation-queue";

function progressText(progress: TypstRepairProgress, t: Messages): string {
  switch (progress.phase) {
    case "requesting":
      return t.repair.requesting(progress.replyAttempt);
    case "rejected":
      return t.repair.rejected(progress.replyAttempt, progress.error.message);
    case "applied":
      return progress.change.mode === "rewrite"
        ? t.repair.appliedRewrite(progress.replyAttempt)
        : t.repair.appliedEdits(progress.replyAttempt, progress.change.count);
  }
}

function RoundDetails({ round }: { round: TypstRepairRound }) {
  const { locale, t } = useI18n();
  return (
    <>
      <p className="typst-repair-label">{t.repair.diagnostics}</p>
      <pre className="typst-source">{round.diagnostics}</pre>
      {round.events.length > 0 && (
        <ul className="typst-repair-events">
          {round.events.map((progress, index) => (
            <li key={index}>{progressText(progress, t)}</li>
          ))}
        </ul>
      )}
      {round.change && (
        <div className="typst-repair-change">
          <p className="muted">
            {t.repair.changeAt(round.change.startLine)} · {t.repair.rangeNote}
          </p>
          <div className="typst-repair-pair">
            <figure>
              <figcaption>{t.repair.before}</figcaption>
              <pre className="typst-source typst-repair-before" tabIndex={0}>
                {round.change.before}
              </pre>
            </figure>
            <figure>
              <figcaption>{t.repair.after}</figcaption>
              <pre className="typst-source typst-repair-after" tabIndex={0}>
                {round.change.after}
              </pre>
            </figure>
          </div>
        </div>
      )}
      {round.resultDiagnostics && (
        <>
          <p className="typst-repair-label">{t.repair.resultDiagnostics}</p>
          <pre className="typst-source">{round.resultDiagnostics}</pre>
        </>
      )}
      {round.error && (
        <p className="field-error">{errorText(round.error, locale)}</p>
      )}
    </>
  );
}

// A retry save can compile and store a draft after the last round ended.
function latestStatusIsCurrent(task: TranslationTask): boolean {
  return (
    task.stage !== "saving" &&
    task.stage !== "saved" &&
    task.error?.stage !== "saving"
  );
}

export function TypstRepairPanel({ task }: { task: TranslationTask }) {
  const { t } = useI18n();
  const rounds = task.repairRounds ?? [];
  const latest = rounds[rounds.length - 1];
  if (!latest) return null;
  const omitted = rounds[0]!.round - 1;
  const outcome =
    task.stage === "saved"
      ? t.repair.saved
      : task.stage === "cancelled"
        ? t.repair.cancelledDraftKept
        : task.error?.stage === "saving"
          ? t.repair.savedFailedAfterCompile
          : null;
  return (
    <section className="typst-repair" aria-label={t.repair.title}>
      <p className="typst-repair-summary" aria-live="polite">
        <strong>{t.repair.title}</strong>{" "}
        {t.repair.round(latest.round)}
        {latestStatusIsCurrent(task) && (
          <> · {t.repair.status[latest.status]}</>
        )}
      </p>
      {omitted > 0 && (
        <p className="typst-repair-omitted muted">{t.repair.earlierRoundsOmitted(omitted)}</p>
      )}
      {rounds.map((round) => (
        <details
          key={round.round}
          className="typst-repair-round"
          open={task.stage !== "saved" && round === latest}
        >
          <summary>
            {t.repair.round(round.round)} ·{" "}
            {t.repair.status[round.status]}
          </summary>
          <RoundDetails round={round} />
        </details>
      ))}
      {outcome && <p className="typst-repair-outcome">{outcome}</p>}
    </section>
  );
}

export function TypstRepairSummary({ task }: { task: TranslationTask }) {
  const { t } = useI18n();
  const rounds = task.repairRounds ?? [];
  const latest = rounds[rounds.length - 1];
  if (!latest) return null;
  return (
    <span className="muted">
      {t.repair.round(latest.round)}
      {latestStatusIsCurrent(task) && (
        <> · {t.repair.status[latest.status]}</>
      )}
    </span>
  );
}
