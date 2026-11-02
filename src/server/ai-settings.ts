import {
  InMemoryModelsStore,
  envApiKeyAuth,
  getSupportedThinkingLevels,
  type AuthContext,
  type AuthInteraction,
  type CredentialInfo,
  type CredentialStore,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Database } from "bun:sqlite";
import {
  aiConfigSchema,
  type AiCatalog,
  type AiConfig,
  type AiCredentialKind,
  type AiModelOption,
  type AiProviderOption,
  type AiReasoningEffort,
  type AiSettingsSnapshot,
} from "../shared/contracts";
import {
  AiError,
  CUSTOM_PROVIDER_ID,
  createAiRuntime,
  registerCustomProvider,
  type AiRuntime,
} from "./ai";
import {
  getAppSettings,
  saveAiConfig,
  StoredAiConfigError,
} from "./storage";

const MODEL_REFRESH_TIMEOUT_MS = 15_000;

export class AiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiConfigError";
  }
}

export class AiProviderNotFoundError extends Error {
  constructor(providerId: string) {
    super(`unknown AI provider: ${providerId}`);
    this.name = "AiProviderNotFoundError";
  }
}

export interface AiManager {
  getRuntime(): Promise<AiRuntime>;
  getSettings(): Promise<AiSettingsSnapshot>;
  getCatalog(provider?: string): Promise<AiCatalog>;
  refreshCatalog(provider: string, signal: AbortSignal): Promise<AiCatalog>;
  saveConfig(config: AiConfig): Promise<AiSettingsSnapshot>;
  assertLoginSupported(provider: string, type: AiCredentialKind): Promise<void>;
  login(
    provider: string,
    type: AiCredentialKind,
    interaction: AuthInteraction,
  ): Promise<void>;
  logout(provider: string): Promise<void>;
}

export function createAiManager(
  db: Database,
  credentialStore: CredentialStore,
): AiManager {
  const modelsStore = new InMemoryModelsStore();
  const authContext: AuthContext = {
    env: async () => undefined,
    fileExists: async () => false,
  };
  const createAppModels = (config: AiConfig | null): MutableModels => {
    const models = builtinModels({
      credentials: credentialStore,
      modelsStore,
      authContext,
    });
    for (const [id, name] of [
      ["amazon-bedrock", "Amazon Bedrock API key"],
      ["google-vertex", "Google Cloud API key"],
    ] as const) {
      const provider = models.getProvider(id);
      if (!provider) {
        throw new Error(`Pi provider ${id} is missing from this build`);
      }
      models.setProvider({
        ...provider,
        auth: { ...provider.auth, apiKey: envApiKeyAuth(name, []) },
      });
    }
    return registerCustomProvider(
      models,
      config?.provider === CUSTOM_PROVIDER_ID ? config : null,
    );
  };
  const catalogModels = createAppModels(null);
  let initialized: Promise<void> | null = null;
  let runtimeCache: { key: string; runtime: AiRuntime } | null = null;
  let runtimeChain: Promise<unknown> = Promise.resolve();

  const ensureInitialized = (): Promise<void> => {
    initialized ??= catalogModels
      .refresh({ allowNetwork: false })
      .then(() => undefined);
    return initialized;
  };

  const appSettings = () => {
    try {
      return getAppSettings(db);
    } catch (error) {
      if (error instanceof StoredAiConfigError) {
        throw new AiError("AI_CONFIG_INVALID", "the stored AI configuration is invalid");
      }
      throw error;
    }
  };

  const credentialMetadata = async (): Promise<Map<string, AiCredentialKind>> => {
    const entries: readonly CredentialInfo[] = await credentialStore.list();
    return new Map(entries.map((entry) => [entry.providerId, entry.type]));
  };

  const providerFor = (providerId: string): Provider => {
    const provider = catalogModels.getProvider(providerId);
    if (!provider) throw new AiProviderNotFoundError(providerId);
    return provider;
  };

  const authMethods = (provider: Provider): AiCredentialKind[] => {
    const methods: AiCredentialKind[] = [];
    if (provider.auth.apiKey?.login) methods.push("api_key");
    if (provider.auth.oauth?.login) methods.push("oauth");
    return methods;
  };

  const refreshModels = async (
    providerId: string,
    signal: AbortSignal,
  ): Promise<Error | undefined> => {
    const result = await catalogModels.refresh({
      allowNetwork: true,
      providers: [providerId],
      force: true,
      signal,
    });
    return result.errors.get(providerId);
  };

  const refreshWithTimeout = async (providerId: string): Promise<Error | undefined> => {
    try {
      return await refreshModels(
        providerId,
        AbortSignal.timeout(MODEL_REFRESH_TIMEOUT_MS),
      );
    } catch (error) {
      return error instanceof Error ? error : new Error("model refresh failed");
    }
  };

  const modelOf = (provider: Provider, modelId: string) =>
    provider.getModels().find((model) => model.id === modelId);

  const buildRuntime = async (): Promise<AiRuntime> => {
    await ensureInitialized();
    const settings = appSettings();
    const config = settings.aiConfig;
    const key = JSON.stringify(config);
    if (runtimeCache?.key === key) return runtimeCache.runtime;

    const models = createAppModels(config);
    if (config) {
      await models.refresh({
        allowNetwork: false,
        providers: [config.provider],
      });
    }

    let runtime = createAiRuntime(config, models);
    if (config && config.provider !== CUSTOM_PROVIDER_ID) {
      const provider = models.getProvider(config.provider);
      if (provider && !modelOf(provider, config.model) && provider.refreshModels) {
        await refreshWithTimeout(provider.id);
        await models.refresh({
          allowNetwork: false,
          providers: [config.provider],
        });
        runtime = createAiRuntime(config, models);
      }
    }

    runtimeCache = { key, runtime };
    return runtime;
  };

  const getRuntime = (): Promise<AiRuntime> => {
    const run = runtimeChain.then(buildRuntime, buildRuntime);
    runtimeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const statusFor = async (
    config: AiConfig | null,
  ): Promise<AiSettingsSnapshot["status"]> => {
    if (!config) {
      return { configured: false, code: "AI_NOT_CONFIGURED" };
    }
    const provider = catalogModels.getProvider(config.provider);
    if (!provider) {
      return { configured: false, code: "AI_NOT_CONFIGURED" };
    }

    const model = modelOf(provider, config.model);
    if (!model) {
      return { configured: false, code: "AI_NOT_CONFIGURED" };
    }
    if (!model.input.includes("image")) {
      return { configured: false, code: "AI_MODEL_UNSUPPORTED" };
    }
    if (
      config.reasoningEffort !== undefined &&
      !getSupportedThinkingLevels(model).includes(config.reasoningEffort)
    ) {
      return { configured: false, code: "AI_MODEL_UNSUPPORTED" };
    }

    if (config.provider === CUSTOM_PROVIDER_ID) {
      return { configured: true };
    }
    if (await catalogModels.checkAuth(config.provider)) {
      return { configured: true };
    }
    return { configured: false, code: "AI_NOT_CONFIGURED" };
  };

  const getSettings = async (): Promise<AiSettingsSnapshot> => {
    await ensureInitialized();
    const config = appSettings().aiConfig;
    registerCustomProvider(
      catalogModels,
      config?.provider === CUSTOM_PROVIDER_ID ? config : null,
    );
    return {
      config,
      status: await statusFor(config),
    };
  };

  const getCatalog = async (providerId?: string): Promise<AiCatalog> => {
    await ensureInitialized();
    const settings = appSettings();
    const config = settings.aiConfig;
    registerCustomProvider(
      catalogModels,
      config?.provider === CUSTOM_PROVIDER_ID ? config : null,
    );
    const selected = providerId === undefined ? null : providerFor(providerId);
    const metadata = await credentialMetadata();

    const providers: AiProviderOption[] = catalogModels.getProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      authMethods: authMethods(provider),
      credentialType: metadata.get(provider.id) ?? null,
      canRefreshModels: provider.refreshModels !== undefined,
    }));

    const models: AiModelOption[] = selected
      ? selected
          .getModels()
          .filter((model) => model.input.includes("image"))
          .map((model) => ({
            id: model.id,
            name: model.name,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            reasoningEfforts: getSupportedThinkingLevels(model).filter(
              (level): level is AiReasoningEffort => level !== "off",
            ),
          }))
      : [];

    return { providers, provider: selected?.id ?? null, models };
  };

  const refreshCatalog = async (
    providerId: string,
    signal: AbortSignal,
  ): Promise<AiCatalog> => {
    await ensureInitialized();
    providerFor(providerId);
    const combined = AbortSignal.any([
      signal,
      AbortSignal.timeout(MODEL_REFRESH_TIMEOUT_MS),
    ]);
    const failure = await refreshModels(providerId, combined);
    if (failure) {
      console.error(`AI model refresh failed (${providerId}) code=catalog`);
      throw new AiError(
        "AI_REQUEST_FAILED",
        `model catalog refresh failed for ${providerId}`,
      );
    }
    if (combined.aborted) {
      throw new AiError(
        "AI_REQUEST_FAILED",
        `model catalog refresh failed for ${providerId}`,
      );
    }
    runtimeCache = null;
    return getCatalog(providerId);
  };

  const saveConfig = async (config: AiConfig): Promise<AiSettingsSnapshot> => {
    const parsed = aiConfigSchema.parse(config);
    await ensureInitialized();
    registerCustomProvider(
      catalogModels,
      parsed.provider === CUSTOM_PROVIDER_ID ? parsed : null,
    );
    const provider = providerFor(parsed.provider);

    let model = modelOf(provider, parsed.model);
    if (!model && parsed.provider !== CUSTOM_PROVIDER_ID && provider.refreshModels) {
      await refreshWithTimeout(provider.id);
      model = modelOf(provider, parsed.model);
    }
    if (!model) {
      throw new AiConfigError(`unknown model for ${parsed.provider}: ${parsed.model}`);
    }
    if (!model.input.includes("image")) {
      throw new AiConfigError(`${parsed.provider}/${parsed.model} does not accept images`);
    }
    if (
      parsed.reasoningEffort !== undefined &&
      !getSupportedThinkingLevels(model).includes(parsed.reasoningEffort)
    ) {
      throw new AiConfigError(
        `${parsed.provider}/${parsed.model} does not support reasoning effort ${parsed.reasoningEffort}`,
      );
    }

    saveAiConfig(db, parsed);
    runtimeCache = null;
    return getSettings();
  };

  const assertLoginSupported = async (
    providerId: string,
    type: AiCredentialKind,
  ): Promise<void> => {
    await ensureInitialized();
    const provider = providerFor(providerId);
    if (type === "oauth") {
      if (!provider.auth.oauth?.login) {
        throw new AiConfigError(`${provider.name} does not support OAuth login`);
      }
      return;
    }
    if (!provider.auth.apiKey?.login) {
      throw new AiConfigError(`${provider.name} does not support API-key login`);
    }
  };

  const login = async (
    providerId: string,
    type: AiCredentialKind,
    interaction: AuthInteraction,
  ): Promise<void> => {
    await assertLoginSupported(providerId, type);
    const settings = appSettings();
    await catalogModels.login(providerId, type, interaction, {
      getDeviceId: () => settings.deviceId,
      agentName: "Lumo",
    });
    runtimeCache = null;
  };

  const logout = async (providerId: string): Promise<void> => {
    await ensureInitialized();
    providerFor(providerId);
    await catalogModels.logout(providerId);
    runtimeCache = null;
  };

  return {
    getRuntime,
    getSettings,
    getCatalog,
    refreshCatalog,
    saveConfig,
    assertLoginSupported,
    login,
    logout,
  };
}
