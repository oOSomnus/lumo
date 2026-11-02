import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AI_REASONING_EFFORTS,
  type AiCatalog,
  type AiConfig,
  type AiCredentialKind,
  type AiLoginEvent,
  type AiReasoningEffort,
  type AiSettingsSnapshot,
  type UiLocale,
} from "../../shared/contracts";
import {
  answerAiLogin,
  cancelAiLogin,
  fetchAiCatalog,
  fetchAiSettings,
  isTerminalLoginEvent,
  refreshAiCatalog,
  removeAiCredential,
  saveAiSettings,
  startAiLogin,
} from "../api";
import { errorText, toUiError, useI18n, type UiError } from "../i18n";
import { ModalDialog } from "./ModalDialog";

type LoginNotification = Extract<AiLoginEvent, { type: "notification" }>["event"];
type LoginPrompt = Extract<AiLoginEvent, { type: "prompt" }>["prompt"];

const CUSTOM_REASONING_EFFORTS: AiReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
];

interface Draft {
  provider: string;
  model: string;
  baseUrl: string;
  contextWindow: string;
  maxTokens: string;
  reasoningEffort: string;
}

function draftFrom(config: AiConfig | null): Draft {
  return {
    provider: config?.provider ?? "",
    model: config?.model ?? "",
    baseUrl: config?.baseUrl ?? "",
    contextWindow: config?.contextWindow?.toString() ?? "",
    maxTokens: config?.maxTokens?.toString() ?? "",
    reasoningEffort: config?.reasoningEffort ?? "",
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    a.baseUrl === b.baseUrl &&
    a.contextWindow === b.contextWindow &&
    a.maxTokens === b.maxTokens &&
    a.reasoningEffort === b.reasoningEffort
  );
}

function parseDraft(draft: Draft): AiConfig | null {
  const provider = draft.provider.trim();
  const model = draft.model.trim();
  if (!provider || !model) return null;
  const reasoningEffort = draft.reasoningEffort
    ? AI_REASONING_EFFORTS.find((level) => level === draft.reasoningEffort)
    : undefined;
  if (draft.reasoningEffort && !reasoningEffort) return null;
  const effort = reasoningEffort ? { reasoningEffort } : {};
  const baseUrl = draft.baseUrl.trim();
  if (provider === "custom") {
    const contextWindow = Number(draft.contextWindow);
    const maxTokens = Number(draft.maxTokens);
    if (
      !baseUrl ||
      !Number.isSafeInteger(contextWindow) ||
      contextWindow <= 0 ||
      !Number.isSafeInteger(maxTokens) ||
      maxTokens <= 0 ||
      maxTokens > contextWindow
    ) {
      return null;
    }
    return { provider, model, baseUrl, contextWindow, maxTokens, ...effort };
  }
  return { provider, model, ...(baseUrl ? { baseUrl } : {}), ...effort };
}

function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return value;
    if (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    ) {
      return value;
    }
  } catch {
    // Not an absolute URL.
  }
  return null;
}

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  uiLocale: UiLocale;
  onApplyUiLocale: (next: UiLocale) => Promise<void>;
  localeApplyBlockedReason: string | null;
  dataDirectory: string;
}

export function SettingsDialog({
  open,
  onClose,
  uiLocale,
  onApplyUiLocale,
  localeApplyBlockedReason,
  dataDirectory,
}: SettingsDialogProps) {
  const { locale, t } = useI18n();

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<UiError | null>(null);
  const [snapshot, setSnapshot] = useState<AiSettingsSnapshot | null>(null);
  const [catalog, setCatalog] = useState<AiCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<UiError | null>(null);
  const [loadNonce, setLoadNonce] = useState(0);

  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [contextWindow, setContextWindow] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<UiError | null>(null);
  const [actionError, setActionError] = useState<UiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [languageDraft, setLanguageDraft] = useState<UiLocale>(uiLocale);
  const [applyingLanguage, setApplyingLanguage] = useState(false);
  const [languageError, setLanguageError] = useState<UiError | null>(null);

  const [loginActive, setLoginActive] = useState(false);
  const [loginPrompt, setLoginPrompt] = useState<{
    id: string;
    prompt: LoginPrompt;
  } | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [answering, setAnswering] = useState(false);
  const [notifications, setNotifications] = useState<LoginNotification[]>([]);
  const [loginError, setLoginError] = useState<UiError | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const [endpointConfirm, setEndpointConfirm] = useState<{
    config: AiConfig;
    destination: string;
  } | null>(null);

  const loginAbort = useRef<AbortController | null>(null);
  const sessionRef = useRef<string | null>(null);
  const catalogAbort = useRef<AbortController | null>(null);
  const catalogSeq = useRef(0);

  const draft = useMemo<Draft>(
    () => ({ provider, model, baseUrl, contextWindow, maxTokens, reasoningEffort }),
    [provider, model, baseUrl, contextWindow, maxTokens, reasoningEffort],
  );
  const initialDraft = useMemo(() => draftFrom(snapshot?.config ?? null), [snapshot]);
  const formDirty = snapshot !== null && !sameDraft(draft, initialDraft);

  const providerOption = catalog?.providers.find((entry) => entry.id === provider);
  const models =
    catalog && catalog.provider === provider ? catalog.models : [];
  const modelEfforts =
    provider === "custom"
      ? CUSTOM_REASONING_EFFORTS
      : models.find((entry) => entry.id === model)?.reasoningEfforts ?? [];
  const effortSelection = AI_REASONING_EFFORTS.find(
    (level) => level === reasoningEffort,
  );
  const credentialType = providerOption?.credentialType ?? null;
  const credentialLabel =
    credentialType === "oauth"
      ? t.settings.oauthName
      : credentialType === "api_key"
        ? t.settings.apiKeyName
        : null;

  const applyDraft = useCallback((next: Draft) => {
    setProvider(next.provider);
    setModel(next.model);
    setBaseUrl(next.baseUrl);
    setContextWindow(next.contextWindow);
    setMaxTokens(next.maxTokens);
    setReasoningEffort(next.reasoningEffort);
  }, []);

  const stopLogin = useCallback(() => {
    const sessionId = sessionRef.current;
    sessionRef.current = null;
    loginAbort.current?.abort();
    loginAbort.current = null;
    if (sessionId) void cancelAiLogin(sessionId).catch(() => {});
    setLoginActive(false);
    setLoginPrompt(null);
    setPromptValue("");
    setAnswering(false);
    setNotifications([]);
  }, []);

  const loadCatalog = useCallback(
    async (providerId: string, signal?: AbortSignal) => {
      const seq = ++catalogSeq.current;
      const current = (): boolean =>
        seq === catalogSeq.current && !signal?.aborted;
      setCatalogLoading(true);
      setCatalogError(null);
      try {
        const next = await fetchAiCatalog(providerId, signal);
        if (current()) setCatalog(next);
      } catch (error) {
        if (current()) setCatalogError(toUiError(error));
      } finally {
        if (current()) setCatalogLoading(false);
      }
    },
    [],
  );

  const loadSettings = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setLoadError(null);
      setSnapshot(null);
      setCatalog(null);
      setCatalogError(null);
      setFormError(null);
      setActionError(null);
      setNotice(null);
      setEndpointConfirm(null);
      setRemoveConfirm(false);
      setLoginError(null);
      stopLogin();
      try {
        const [settings, baseCatalog] = await Promise.all([
          fetchAiSettings(signal),
          fetchAiCatalog(undefined, signal),
        ]);
        if (signal.aborted) return;
        setSnapshot(settings);
        applyDraft(draftFrom(settings.config));
        setCatalog(baseCatalog);
        setLanguageDraft(uiLocale);
        setLanguageError(null);
        const selected = settings.config?.provider ?? "";
        if (selected) {
          const seq = ++catalogSeq.current;
          const selectedCatalog = await fetchAiCatalog(selected, signal);
          if (signal.aborted || seq !== catalogSeq.current) return;
          setCatalog(selectedCatalog);
        }
      } catch (error) {
        if (!signal.aborted) setLoadError(toUiError(error));
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [applyDraft, stopLogin, uiLocale],
  );

  useEffect(() => {
    if (!open) {
      stopLogin();
      catalogAbort.current?.abort();
      return;
    }
    const controller = new AbortController();
    void loadSettings(controller.signal);
    return () => controller.abort();
  }, [open, loadNonce, loadSettings, stopLogin]);

  useEffect(() => {
    return () => {
      loginAbort.current?.abort();
      catalogAbort.current?.abort();
      const sessionId = sessionRef.current;
      if (sessionId) void cancelAiLogin(sessionId).catch(() => {});
    };
  }, []);

  const selectProvider = (next: string): void => {
    const saved = snapshot?.config;
    const useSaved = saved?.provider === next;
    setProvider(next);
    setModel(useSaved ? saved.model : "");
    setBaseUrl(useSaved ? (saved.baseUrl ?? "") : "");
    setContextWindow(useSaved ? (saved.contextWindow?.toString() ?? "") : "");
    setMaxTokens(useSaved ? (saved.maxTokens?.toString() ?? "") : "");
    setReasoningEffort(useSaved ? (saved.reasoningEffort ?? "") : "");
    setFormError(null);
    setNotice(null);
    setActionError(null);
    catalogAbort.current?.abort();
    if (!next) {
      setCatalogLoading(false);
      setCatalogError(null);
      return;
    }
    const controller = new AbortController();
    catalogAbort.current = controller;
    void loadCatalog(next, controller.signal);
  };

  const selectModel = (next: string): void => {
    setModel(next);
    const supported =
      provider === "custom"
        ? CUSTOM_REASONING_EFFORTS
        : models.find((entry) => entry.id === next)?.reasoningEfforts ?? [];
    if (
      reasoningEffort &&
      !supported.some((level) => level === reasoningEffort)
    ) {
      setReasoningEffort("");
    }
  };

  const retryCatalog = (): void => {
    if (!provider) return;
    catalogAbort.current?.abort();
    const controller = new AbortController();
    catalogAbort.current = controller;
    void loadCatalog(provider, controller.signal);
  };

  const applyConfig = async (config: AiConfig): Promise<void> => {
    setSaving(true);
    setFormError(null);
    setActionError(null);
    setNotice(null);
    try {
      const next = await saveAiSettings(config);
      setSnapshot(next);
      applyDraft(draftFrom(next.config));
      setNotice(t.settings.configSaved);
      try {
        const nextCatalog = await fetchAiCatalog(config.provider);
        setCatalog(nextCatalog);
      } catch (error) {
        setCatalogError(toUiError(error));
      }
    } catch (error) {
      setFormError(toUiError(error));
    } finally {
      setSaving(false);
      setEndpointConfirm(null);
    }
  };

  const handleSave = (): void => {
    const config = parseDraft(draft);
    if (!config) {
      setFormError({ code: "INVALID_AI_SETTINGS" });
      return;
    }
    const capability =
      config.provider === "custom"
        ? CUSTOM_REASONING_EFFORTS
        : models.find((entry) => entry.id === config.model)?.reasoningEfforts;
    if (
      config.reasoningEffort &&
      capability &&
      !capability.some((level) => level === config.reasoningEffort)
    ) {
      setFormError({ code: "INVALID_AI_SETTINGS" });
      return;
    }
    const saved = snapshot?.config;
    if (
      credentialType &&
      saved?.provider === config.provider &&
      (saved.baseUrl ?? "") !== (config.baseUrl ?? "")
    ) {
      setEndpointConfirm({
        config,
        destination: config.baseUrl ?? t.settings.providerDefaultEndpoint,
      });
      return;
    }
    void applyConfig(config);
  };

  const refreshModels = async (): Promise<void> => {
    if (!provider) return;
    setRefreshing(true);
    setActionError(null);
    setCatalogError(null);
    try {
      const nextCatalog = await refreshAiCatalog(provider);
      setCatalog(nextCatalog);
      setNotice(t.settings.refreshed);
    } catch (error) {
      setActionError(toUiError(error));
    } finally {
      setRefreshing(false);
    }
  };

  const afterLogin = (providerId: string): void => {
    const seq = ++catalogSeq.current;
    catalogAbort.current?.abort();
    const controller = new AbortController();
    catalogAbort.current = controller;
    const current = (): boolean => seq === catalogSeq.current && !controller.signal.aborted;
    const canRefresh =
      catalog?.providers.find((entry) => entry.id === providerId)
        ?.canRefreshModels ?? false;
    setCatalogLoading(true);
    setCatalogError(null);

    void fetchAiSettings().then(
      (settings) => {
        if (current()) setSnapshot(settings);
      },
      (error) => {
        if (current()) setActionError(toUiError(error));
      },
    );

    const request = canRefresh
      ? refreshAiCatalog(providerId, controller.signal)
      : fetchAiCatalog(providerId, controller.signal);
    void request
      .then((nextCatalog) => {
        if (current()) setCatalog(nextCatalog);
      })
      .catch((error) => {
        if (current()) setCatalogError(toUiError(error));
      })
      .finally(() => {
        if (current()) setCatalogLoading(false);
      });
  };

  const beginLogin = async (type: AiCredentialKind): Promise<void> => {
    if (!provider || !providerOption) return;
    stopLogin();
    const controller = new AbortController();
    loginAbort.current = controller;
    let terminal = false;
    setLoginActive(true);
    setLoginError(null);
    setActionError(null);
    setNotice(null);
    setNotifications([]);
    setLoginPrompt(null);
    setPromptValue("");
    try {
      await startAiLogin(provider, type, {
        signal: controller.signal,
        onEvent: (event) => {
          if (isTerminalLoginEvent(event)) terminal = true;
          switch (event.type) {
            case "session":
              sessionRef.current = event.sessionId;
              break;
            case "prompt":
              setLoginPrompt({ id: event.promptId, prompt: event.prompt });
              setPromptValue("");
              break;
            case "prompt_cancelled":
              setLoginPrompt((current) =>
                current?.id === event.promptId ? null : current,
              );
              break;
            case "notification":
              setNotifications((current) => [...current, event.event].slice(-8));
              break;
            case "done":
              sessionRef.current = null;
              setLoginActive(false);
              setLoginPrompt(null);
              setPromptValue("");
              setNotice(t.settings.loginDone);
              void afterLogin(event.provider);
              break;
            case "error":
              sessionRef.current = null;
              setLoginActive(false);
              setLoginPrompt(null);
              setPromptValue("");
              setLoginError({
                code: event.error.code,
                detail: event.error.message,
              });
              break;
            case "cancelled":
              sessionRef.current = null;
              setLoginActive(false);
              setLoginPrompt(null);
              setPromptValue("");
              setNotice(t.settings.loginCancelled);
              break;
          }
        },
      });
      if (!terminal && !controller.signal.aborted) {
        setLoginError({ code: "AI_LOGIN_INTERRUPTED" });
      }
    } catch (error) {
      if (!controller.signal.aborted) setLoginError(toUiError(error));
    } finally {
      if (loginAbort.current === controller) loginAbort.current = null;
      setLoginActive(false);
      setLoginPrompt(null);
      setPromptValue("");
      setAnswering(false);
    }
  };

  const answerPrompt = async (value: string): Promise<void> => {
    const sessionId = sessionRef.current;
    const current = loginPrompt;
    if (!sessionId || !current || answering) return;
    setAnswering(true);
    setLoginError(null);
    try {
      await answerAiLogin(sessionId, current.id, value);
      setLoginPrompt(null);
      setPromptValue("");
    } catch (error) {
      const failure = toUiError(error);
      setLoginError(failure);
      if (failure.code === "AI_LOGIN_STALE_PROMPT") {
        setLoginPrompt(null);
        setPromptValue("");
      }
    } finally {
      setAnswering(false);
    }
  };

  const cancelLogin = (): void => {
    stopLogin();
    setLoginError(null);
    setNotice(t.settings.loginCancelled);
  };

  const confirmRemove = async (): Promise<void> => {
    setRemoveConfirm(false);
    if (!provider) return;
    setRemoving(true);
    setActionError(null);
    setNotice(null);
    try {
      await removeAiCredential(provider);
      setNotice(t.settings.credentialRemoved);
      try {
        const [settings, nextCatalog] = await Promise.all([
          fetchAiSettings(),
          fetchAiCatalog(provider),
        ]);
        setSnapshot(settings);
        setCatalog(nextCatalog);
      } catch (error) {
        setActionError(toUiError(error));
      }
    } catch (error) {
      setActionError(toUiError(error));
    } finally {
      setRemoving(false);
    }
  };

  const languageBlocked =
    localeApplyBlockedReason ??
    (loginActive
      ? t.settings.languageBlockedAuth
      : formDirty
        ? t.settings.languageBlockedDirty
        : null);
  const languageDisabled =
    languageDraft === uiLocale ||
    Boolean(languageBlocked) ||
    applyingLanguage ||
    saving ||
    removing ||
    endpointConfirm !== null;

  const applyLanguage = async (): Promise<void> => {
    if (
      languageDraft === uiLocale ||
      localeApplyBlockedReason ||
      loginActive ||
      formDirty ||
      saving ||
      removing ||
      endpointConfirm !== null
    ) {
      return;
    }
    setApplyingLanguage(true);
    setLanguageError(null);
    try {
      await onApplyUiLocale(languageDraft);
    } catch (error) {
      setLanguageError(toUiError(error));
    } finally {
      setApplyingLanguage(false);
    }
  };

  const handleClose = (): void => {
    if (loginActive) {
      stopLogin();
      setNotice(t.settings.loginCancelled);
    }
    setPromptValue("");
    onClose();
  };

  const externalLink = (url: string, label: string) => {
    const safe = safeExternalUrl(url);
    if (!safe) return <span className="field-error">{t.settings.insecureLink}</span>;
    return (
      <a href={safe} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    );
  };

  const renderNotifications = () => {
    if (notifications.length === 0) return null;
    return (
      <div className="login-notifications">
        {notifications.map((event, index) => {
          if (event.type === "info") {
            return (
              <div key={`info-${index}`} className="login-notification">
                <p className="muted">{t.settings.notificationInfo}</p>
                <p className="provider-text">{event.message}</p>
                {event.links?.map((link) => (
                  <div key={link.url}>
                    {externalLink(link.url, link.label ?? t.settings.openLink)}
                  </div>
                ))}
              </div>
            );
          }
          if (event.type === "auth_url") {
            return (
              <div key={`auth-${index}`} className="login-notification">
                <p>{externalLink(event.url, t.settings.authLink)}</p>
                {event.instructions && (
                  <>
                    <p className="muted">{t.settings.instructionsOriginal}</p>
                    <p className="provider-text">{event.instructions}</p>
                  </>
                )}
              </div>
            );
          }
          if (event.type === "device_code") {
            return (
              <div key={`device-${index}`} className="login-notification">
                <p>
                  {t.settings.deviceCodeLabel}: <code>{event.userCode}</code>
                </p>
                <p>
                  {t.settings.deviceCodeAddress}:{" "}
                  {externalLink(event.verificationUri, event.verificationUri)}
                </p>
              </div>
            );
          }
          return (
            <div key={`progress-${index}`} className="login-notification">
              <p className="muted">{t.settings.notificationProgress}</p>
              <p className="provider-text">{event.message}</p>
            </div>
          );
        })}
      </div>
    );
  };

  const renderPrompt = () => {
    if (!loginPrompt) return null;
    const prompt = loginPrompt.prompt;
    return (
      <div className="login-prompt">
        <p className="muted">{t.settings.promptLabel}</p>
        <p className="provider-text">{prompt.message}</p>
        {prompt.type === "select" ? (
          <div className="prompt-options">
            {prompt.options.map((option) => (
              <button
                key={option.id}
                type="button"
                disabled={answering}
                onClick={() => void answerPrompt(option.id)}
              >
                <strong>{option.label}</strong>
                {option.description && (
                  <span className="muted">{option.description}</span>
                )}
              </button>
            ))}
          </div>
        ) : (
          <form
            className="inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (promptValue.length === 0) return;
              void answerPrompt(promptValue);
            }}
          >
            <label className="sr-only" htmlFor="ai-login-answer">
              {prompt.type === "secret"
                ? t.settings.promptSecret
                : prompt.type === "manual_code"
                  ? t.settings.promptManualCode
                  : t.settings.promptText}
            </label>
            <input
              id="ai-login-answer"
              type={prompt.type === "secret" ? "password" : "text"}
              autoComplete="off"
              value={promptValue}
              placeholder={prompt.placeholder ?? ""}
              onChange={(event) => setPromptValue(event.target.value)}
              disabled={answering}
            />
            <button
              type="submit"
              className="primary"
              disabled={answering || promptValue.length === 0}
            >
              {t.settings.promptSubmit}
            </button>
          </form>
        )}
      </div>
    );
  };

  const frozen =
    loginActive || saving || removing || endpointConfirm !== null;

  return (
    <ModalDialog
      open={open}
      onClose={handleClose}
      label={t.settings.title}
      className="settings-dialog"
    >
      {open && (
        <>
      <div className="dialog-heading">
        <h2>{t.settings.title}</h2>
        <button type="button" onClick={handleClose}>
          {t.settings.close}
        </button>
      </div>

      {loading && <p>{t.settings.loading}</p>}
      {loadError && (
        <div className="inline-error" role="alert">
          <span>{errorText(loadError, locale)}</span>
          <button type="button" onClick={() => setLoadNonce((value) => value + 1)}>
            {t.settings.retry}
          </button>
        </div>
      )}

      {!loading && !loadError && snapshot && (
        <div className="settings-sections">
          <section className="settings-section" aria-labelledby="settings-language">
            <h3 id="settings-language">{t.settings.languageSection}</h3>
            <p className="muted">{t.settings.languageDescription}</p>
            <label>
              {t.settings.languageSection}
              <select
                value={languageDraft}
                onChange={(event) =>
                  setLanguageDraft(event.target.value as UiLocale)
                }
                disabled={applyingLanguage}
              >
                <option value="en">{t.settings.english}</option>
                <option value="zh-CN">{t.settings.chinese}</option>
              </select>
            </label>
            {languageBlocked && (
              <p className="field-error" role="status">
                {languageBlocked}
              </p>
            )}
            {languageError && (
              <p className="field-error" role="alert">
                {errorText(languageError, locale)}
              </p>
            )}
            <button
              type="button"
              className="primary"
              disabled={languageDisabled}
              onClick={() => void applyLanguage()}
            >
              {applyingLanguage
                ? t.settings.applyingLanguage
                : t.settings.applyLanguage}
            </button>
          </section>

          <section className="settings-section" aria-labelledby="settings-ai">
            <h3 id="settings-ai">{t.settings.aiSection}</h3>
            <div className="settings-grid">
              <label>
                {t.settings.provider}
                <select
                  value={provider}
                  onChange={(event) => selectProvider(event.target.value)}
                  disabled={frozen || refreshing}
                >
                  <option value="">{t.settings.chooseProvider}</option>
                  {catalog?.providers.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                {t.settings.model}
                {provider === "custom" ? (
                  <input
                    type="text"
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    disabled={frozen}
                  />
                ) : (
                  <select
                    value={model}
                    onChange={(event) => selectModel(event.target.value)}
                    disabled={frozen || catalogLoading || models.length === 0}
                  >
                    <option value="">{t.settings.chooseModel}</option>
                    {model && !models.some((entry) => entry.id === model) && (
                      <option value={model}>{model}</option>
                    )}
                    {models.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.name}
                      </option>
                    ))}
                  </select>
                )}
              </label>
            </div>

            <label>
              {t.settings.reasoningEffort}
              <select
                value={reasoningEffort}
                onChange={(event) => setReasoningEffort(event.target.value)}
                disabled={frozen || modelEfforts.length === 0}
                aria-describedby={
                  provider === "custom" ||
                  (provider && model && modelEfforts.length === 0)
                    ? "settings-reasoning-effort-hint"
                    : undefined
                }
              >
                <option value="">{t.settings.reasoningEffortDefault}</option>
                {effortSelection &&
                  !modelEfforts.includes(effortSelection) && (
                    <option value={effortSelection} disabled>
                      {t.settings.reasoningEffortLevels[effortSelection]}
                    </option>
                  )}
                {modelEfforts.map((level) => (
                  <option key={level} value={level}>
                    {t.settings.reasoningEffortLevels[level]}
                  </option>
                ))}
              </select>
            </label>
            {(provider === "custom" ||
              (provider && model && modelEfforts.length === 0)) && (
              <p id="settings-reasoning-effort-hint" className="muted">
                {provider === "custom"
                  ? t.settings.reasoningEffortCustomNote
                  : t.settings.reasoningEffortUnavailable}
              </p>
            )}

            {catalogLoading && <p className="muted">{t.settings.loading}</p>}
            {catalogError && (
              <div className="inline-error" role="alert">
                <span>{errorText(catalogError, locale)}</span>
                <button type="button" onClick={retryCatalog}>
                  {t.settings.retry}
                </button>
              </div>
            )}
            {provider && !catalogLoading && models.length === 0 && (
              <p className="muted">{t.settings.noModels}</p>
            )}

            <label>
              {provider === "custom"
                ? t.settings.baseUrlCustom
                : t.settings.baseUrl}
              <input
                type="text"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                disabled={frozen}
                placeholder="https://example.com/v1"
              />
            </label>

            {provider === "custom" ? (
              <div className="settings-grid">
                <label>
                  {t.settings.contextWindow}
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={contextWindow}
                    onChange={(event) => setContextWindow(event.target.value)}
                    disabled={frozen}
                  />
                </label>
                <label>
                  {t.settings.maxTokens}
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={maxTokens}
                    onChange={(event) => setMaxTokens(event.target.value)}
                    disabled={frozen}
                  />
                </label>
              </div>
            ) : (
              <p className="muted">{t.settings.builtinNote}</p>
            )}
            {provider === "custom" && (
              <p className="muted">{t.settings.customNote}</p>
            )}

            {providerOption?.canRefreshModels && (
              <button
                type="button"
                disabled={frozen || refreshing || !provider}
                onClick={() => void refreshModels()}
              >
                {refreshing
                  ? t.settings.refreshingModels
                  : t.settings.refreshModels}
              </button>
            )}

            {formError && (
              <p className="field-error" role="alert">
                {errorText(formError, locale)}
              </p>
            )}
            {notice && (
              <p className="settings-notice" role="status">
                {notice}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="primary"
                disabled={frozen || !provider || !model.trim()}
                onClick={handleSave}
              >
                {saving ? t.settings.savingConfig : t.settings.saveConfig}
              </button>
            </div>
          </section>

          <section className="settings-section" aria-labelledby="settings-auth">
            <h3 id="settings-auth">{t.settings.authSection}</h3>
            {providerOption ? (
              <>
                <p>{t.settings.authProvider(providerOption.name)}</p>
                {credentialType ? (
                  <>
                    <p>
                      {t.settings.authConfigured(credentialLabel ?? credentialType)}
                    </p>
                    {snapshot?.config?.provider === provider &&
                      !snapshot.status.configured &&
                      snapshot.status.code && (
                        <p className="field-error" role="status">
                          {errorText({ code: snapshot.status.code }, locale)}
                        </p>
                      )}
                    <p className="muted">{t.settings.authUnverified}</p>
                  </>
                ) : (
                  <p className="muted">{t.settings.authNone}</p>
                )}

                <div className="dialog-actions">
                  {providerOption.authMethods.includes("api_key") && (
                    <button
                      type="button"
                      disabled={frozen}
                      onClick={() => void beginLogin("api_key")}
                    >
                      {credentialType === "api_key"
                        ? t.settings.replaceKey
                        : t.settings.addKey}
                    </button>
                  )}
                  {providerOption.authMethods.includes("oauth") && (
                    <button
                      type="button"
                      disabled={frozen}
                      onClick={() => void beginLogin("oauth")}
                    >
                      {t.settings.signIn}
                    </button>
                  )}
                  {credentialType && (
                    <button
                      type="button"
                      className="danger"
                      disabled={frozen}
                      onClick={() => setRemoveConfirm(true)}
                    >
                      {credentialType === "oauth"
                        ? t.settings.signOut
                        : t.settings.removeCredential}
                    </button>
                  )}
                </div>

                {provider === "custom" && (
                  <p className="muted">{t.settings.keylessNote}</p>
                )}

                {removeConfirm && (
                  <div className="inline-error">
                    <strong>{t.confirm.removeCredentialTitle}</strong>
                    <p>{t.confirm.removeCredentialBody(providerOption.name)}</p>
                    <div className="inline-actions">
                      <button
                        type="button"
                        className="danger"
                        onClick={() => void confirmRemove()}
                      >
                        {t.confirm.removeCredentialConfirm}
                      </button>
                      <button
                        type="button"
                        onClick={() => setRemoveConfirm(false)}
                      >
                        {t.common.cancel}
                      </button>
                    </div>
                  </div>
                )}

                {removing && <p className="muted">{t.settings.savingConfig}</p>}
                {actionError && (
                  <p className="field-error" role="alert">
                    {errorText(actionError, locale)}
                  </p>
                )}
                {loginError && (
                  <p className="field-error" role="alert">
                    {errorText(loginError, locale)}
                  </p>
                )}

                {loginActive && (
                  <div className="login-panel" role="status">
                    <p>
                      <strong>{t.settings.loginActive}</strong>
                    </p>
                    {loginPrompt ? (
                      renderPrompt()
                    ) : (
                      <p className="muted">{t.settings.loginWaiting}</p>
                    )}
                    {renderNotifications()}
                    <button type="button" onClick={cancelLogin}>
                      {t.settings.loginCancel}
                    </button>
                  </div>
                )}
                {!loginActive && notifications.length > 0 && renderNotifications()}
                <p className="muted">{t.settings.providerContentNote}</p>
              </>
            ) : (
              <p className="muted">{t.settings.chooseProvider}</p>
            )}
          </section>

          {endpointConfirm && (
            <section className="settings-section" aria-labelledby="settings-endpoint">
              <h3 id="settings-endpoint">{t.confirm.endpointTitle}</h3>
              <p>{t.confirm.endpointBody(endpointConfirm.destination)}</p>
              <div className="dialog-actions">
                <button
                  type="button"
                  onClick={() => setEndpointConfirm(null)}
                >
                  {t.common.cancel}
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void applyConfig(endpointConfirm.config)}
                >
                  {t.confirm.endpointConfirm}
                </button>
              </div>
            </section>
          )}

          <section className="settings-section" aria-labelledby="settings-data">
            <h3 id="settings-data">{t.settings.dataSection}</h3>
            <p>
              {t.settings.dataDirectory} {dataDirectory}
            </p>
            <p className="muted">{t.settings.backup}</p>
            <p className="muted">{t.settings.access}</p>
            <p className="muted">{t.settings.signOutNote}</p>
          </section>
        </div>
      )}
        </>
      )}
    </ModalDialog>
  );
}
