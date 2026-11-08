import { useI18n, type UiError } from "../i18n";

/** Failures that the AI settings fix; a plain retry would fail the same way. */
export const AI_SETTINGS_CODES: Record<string, true> = {
  AI_NOT_CONFIGURED: true,
  AI_MODEL_UNSUPPORTED: true,
  AI_AUTH_FAILED: true,
  AI_CONFIG_INVALID: true,
};

/** The raw code and server detail behind an error sentence, folded away until asked for. */
export function ErrorDetails({ error }: { error: Pick<UiError, "code" | "detail"> }) {
  const { t } = useI18n();
  return (
    <details className="error-details">
      <summary>{t.common.technicalDetails}</summary>
      <p>
        <code>{error.code}</code>
        {error.detail ? ` ${error.detail}` : ""}
      </p>
    </details>
  );
}
