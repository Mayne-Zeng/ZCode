import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import {
  type ModelConfigObject,
  type ModelId,
  type ModelSelection,
  type ModelSelectionFacade,
  type ModelSelectionView,
  type ModelSelectionViewInput,
  type ProviderConfigObject,
  type ProviderId,
  type ProviderSettingsFacade,
  type ProviderSettingsCreationResult,
  type ModelConfigResolution,
  type ProviderSettingsView,
  type ResolveModelConfigInput,
  type SavePersonalModelDraftInput,
} from "@zcode/provider";
import { createServiceDescriptor } from "../descriptors.js";
import type { ModelConnectivityResult } from "@zcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";
import {
  type CodexSubscriptionModel,
  type CodexSubscriptionStatus,
  isAllowedCodexBaseUrl,
} from "./codexSubscriptionTypes.js";

export type {
  ProviderSettingsProviderView,
  ModelSelectionView,
  ModelSelectionViewInput,
  ProviderSettingsView,
} from "@zcode/provider";
export type { CodexSubscriptionModel, CodexSubscriptionStatus };

const CODEX_REASONING_LEVEL_MAP =
  '{"reasoning":{"effort":reasoningLevel == "disabled" ? "none" : reasoningLevel == "enabled" ? "high" : reasoningLevel}}';
const CODEX_DEFAULT_CONTEXT_WINDOW = 272_000;
const CODEX_DEFAULT_MAX_OUTPUT_TOKENS = 128_000;

/** Host 侧 Codex 登录能力；远端 Host 未装配时由设置服务报告 supported=false。 */
export interface CodexSubscriptionSettingsPort {
  getStatus(): Promise<CodexSubscriptionStatus>;
  startLogin(): Promise<{ authorizeUrl: string }>;
  cancelLogin(): Promise<void>;
  logout(): Promise<void>;
  listModels(): Promise<readonly CodexSubscriptionModel[]>;
  dispose?(): Promise<void> | void;
}

function codexModelConfigObject(model: CodexSubscriptionModel): ModelConfigObject {
  const efforts = [...new Set(model.reasoningEfforts)];
  return {
    enabled: true,
    properties: {
      contextWindow: model.contextWindow ?? CODEX_DEFAULT_CONTEXT_WINDOW,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
      inputFormat: {
        supportsImage: model.supportsImage,
        supportsVideo: false,
        supportsPdf: model.supportsPdf,
      },
    },
    optionSpecs: {
      reasoningLevel:
        efforts.length > 0
          ? { values: efforts, map: CODEX_REASONING_LEVEL_MAP }
          : { values: ["disabled"], map: "{}" },
      maxOutputTokens: {
        max: model.maxOutputTokens ?? CODEX_DEFAULT_MAX_OUTPUT_TOKENS,
      },
    },
  };
}

export interface IProviderSettingsService {
  readonly onDidChange: Event<ProviderSettingsView>;
  getView(): Promise<ProviderSettingsView>;
  refresh(reason: string): Promise<ProviderSettingsView>;
  createPersonalProvider(
    input?: Parameters<ProviderSettingsFacade["createPersonalProvider"]>[0],
  ): Promise<ProviderSettingsCreationResult>;
  resolveModelConfig(input: ResolveModelConfigInput): Promise<ModelConfigResolution>;
  savePersonalProviderOverlay(
    providerId: ProviderId,
    config: ProviderConfigObject,
    metadata?: Parameters<ProviderSettingsFacade["savePersonalProviderOverlay"]>[2],
  ): Promise<ProviderSettingsView>;
  deletePersonalProvider(providerId: ProviderId): Promise<ProviderSettingsView>;
  reorderPersonalProviders(providerIds: readonly ProviderId[]): Promise<ProviderSettingsView>;
  reorderPersonalModels(
    providerId: ProviderId,
    modelIds: readonly ModelId[],
  ): Promise<ProviderSettingsView>;
  addPersonalModel(
    providerId: ProviderId,
    modelId: ModelId,
    config: ModelConfigObject,
    useRecommendedConfig?: boolean,
  ): Promise<ProviderSettingsView>;
  renamePersonalModel(
    providerId: ProviderId,
    currentModelId: ModelId,
    nextModelId: ModelId,
  ): Promise<ProviderSettingsView>;
  deletePersonalModel(providerId: ProviderId, modelId: ModelId): Promise<ProviderSettingsView>;
  savePersonalModelDraft(input: SavePersonalModelDraftInput): Promise<ProviderSettingsView>;
  setPersonalModelEnabled(
    providerId: ProviderId,
    modelId: ModelId,
    enabled: boolean,
  ): Promise<ProviderSettingsView>;
  /** 测试已经保存并进入目标 Environment Registry 的正式 Model。 */
  testModelConnectivity(
    input: ProviderSettingsConnectivityRequest,
  ): Promise<ModelConnectivityResult>;
  getCodexSubscriptionStatus(): Promise<CodexSubscriptionStatus>;
  startCodexSubscriptionLogin(): Promise<{ authorizeUrl: string }>;
  cancelCodexSubscriptionLogin(): Promise<void>;
  logoutCodexSubscription(): Promise<void>;
  syncCodexSubscriptionModels(providerId: ProviderId): Promise<ProviderSettingsView>;
}

export const IProviderSettingsService = createServiceDescriptor<IProviderSettingsService>(
  ServiceChannels.ProviderSettings,
);

export interface ProviderSettingsConnectivityTestInput {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
}

export interface ProviderSettingsConnectivityRequest {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
}

export type ProviderSettingsConnectivityTester = (
  input: ProviderSettingsConnectivityTestInput,
) => Promise<ModelConnectivityResult>;

export interface IModelSelectionService {
  readonly onDidChange: Event<ModelSelectionView>;
  getView(input?: ModelSelectionViewInput): Promise<ModelSelectionView>;
}

export interface ModelSelectionConfiguredDefaultSource {
  read(): Promise<ModelSelection | undefined>;
  onDidChange?(listener: () => void): () => void;
}

export const IModelSelectionService = createServiceDescriptor<IModelSelectionService>(
  ServiceChannels.ModelSelection,
);

export function createProviderSettingsService(
  facade: ProviderSettingsFacade,
  ensureReady: () => Promise<void> = async () => {},
  testConnectivity?: ProviderSettingsConnectivityTester,
  codexSubscription?: CodexSubscriptionSettingsPort,
): IProviderSettingsService {
  return {
    onDidChange: toEvent((listener) => facade.onDidChange(listener)),
    getView: async () => {
      await ensureReady();
      return facade.getView();
    },
    refresh: async (reason) => {
      await ensureReady();
      return facade.refresh(reason);
    },
    createPersonalProvider: async (input) => {
      await ensureReady();
      return facade.createPersonalProvider(input);
    },
    resolveModelConfig: async (input) => {
      await ensureReady();
      return facade.resolveModelConfig(input);
    },
    savePersonalProviderOverlay: async (providerId, config, metadata) => {
      await ensureReady();
      return facade.savePersonalProviderOverlay(providerId, config, metadata);
    },
    deletePersonalProvider: async (providerId) => {
      await ensureReady();
      return facade.deletePersonalProvider(providerId);
    },
    reorderPersonalProviders: async (providerIds) => {
      await ensureReady();
      return facade.reorderPersonalProviders(providerIds);
    },
    reorderPersonalModels: async (providerId, modelIds) => {
      await ensureReady();
      return facade.reorderPersonalModels(providerId, modelIds);
    },
    addPersonalModel: async (providerId, modelId, config, useRecommendedConfig) => {
      await ensureReady();
      return facade.addPersonalModel(providerId, modelId, config, useRecommendedConfig);
    },
    renamePersonalModel: async (providerId, currentModelId, nextModelId) => {
      await ensureReady();
      return facade.renamePersonalModel(providerId, currentModelId, nextModelId);
    },
    deletePersonalModel: async (providerId, modelId) => {
      await ensureReady();
      return facade.deletePersonalModel(providerId, modelId);
    },
    savePersonalModelDraft: async (input) => {
      await ensureReady();
      return facade.savePersonalModelDraft(input);
    },
    setPersonalModelEnabled: async (providerId, modelId, enabled) => {
      await ensureReady();
      return facade.setPersonalModelEnabled(providerId, modelId, enabled);
    },
    testModelConnectivity: async (input) => {
      await ensureReady();
      if (!testConnectivity) {
        throw new Error("当前 Environment 未装配模型连通性测试能力");
      }
      await facade.waitForProviderOperations(input.providerId);
      // 禁用对象仍存在于配置视图，但不进入执行 Registry；不能把未发布误报成配置丢失。
      // 只消费操作完成后的公共资格，不另查 Key、权益，也不替代目标 Environment 最终校验。
      const provider = facade
        .getView()
        .providers.find((item) => item.providerId === input.providerId);
      const model = provider?.models.find((item) => item.modelId === input.modelId);
      const unavailable =
        !provider || !provider.enabled
          ? "provider-unavailable"
          : !model || !model.enabled || model.issues.length > 0
            ? "model-unavailable"
            : !provider.executable
              ? "provider-unavailable"
              : !model.executable
                ? "model-unavailable"
                : undefined;
      if (unavailable) {
        return {
          success: false,
          error: {
            code: unavailable,
            message:
              unavailable === "provider-unavailable"
                ? "This provider is currently unavailable for connectivity testing."
                : "This model is currently unavailable for connectivity testing.",
          },
        };
      }
      return testConnectivity({
        workspacePath: input.workspacePath,
        ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
        providerId: input.providerId,
        modelId: input.modelId,
      });
    },
    getCodexSubscriptionStatus: async () => {
      if (!codexSubscription) return { supported: false, state: "signed-out" };
      return codexSubscription.getStatus();
    },
    startCodexSubscriptionLogin: async () => {
      if (!codexSubscription) {
        throw new Error("当前 Environment 未装配 Codex 订阅登录能力");
      }
      return codexSubscription.startLogin();
    },
    cancelCodexSubscriptionLogin: async () => {
      if (!codexSubscription) return;
      await codexSubscription.cancelLogin();
    },
    logoutCodexSubscription: async () => {
      if (!codexSubscription) {
        throw new Error("当前 Environment 未装配 Codex 订阅登录能力");
      }
      await codexSubscription.logout();
    },
    syncCodexSubscriptionModels: async (providerId) => {
      await ensureReady();
      if (!codexSubscription) {
        throw new Error("当前 Environment 未装配 Codex 订阅登录能力");
      }
      await facade.waitForProviderOperations(providerId);
      const provider = facade.getView().providers.find((item) => item.providerId === providerId);
      if (!provider) throw new Error(`Provider 不存在: ${providerId}`);
      // 只在 Host 自己的 Registry 事实里校验接入方式与端点；Renderer 传入的 providerId
      // 不能成为把订阅 token 带到任意 Provider 的凭据。
      if (provider.effectiveConfig.access?.type !== "codex-oauth") {
        throw new Error(`Provider 不是 Codex 订阅接入: ${providerId}`);
      }
      if (provider.effectiveConfig.api?.type !== "openai-responses") {
        throw new Error(`Codex 订阅 Provider 必须使用 openai-responses: ${providerId}`);
      }
      if (!isAllowedCodexBaseUrl(provider.effectiveConfig.api?.baseUrl)) {
        throw new Error("Codex 订阅 Provider 的 Base URL 必须指向 ChatGPT Codex 端点");
      }
      const models = await codexSubscription.listModels();
      if (models.length === 0) {
        throw new Error("ChatGPT 账号没有返回可用的 Codex 模型");
      }
      return facade.replacePersonalModels(
        providerId,
        models.map((model) => ({
          modelId: model.id,
          config: codexModelConfigObject(model),
        })),
      );
    },
  };
}

export function createModelSelectionService(
  facade: ModelSelectionFacade,
  ensureReady: () => Promise<void> = async () => {},
  configuredDefaultSource?: ModelSelectionConfiguredDefaultSource,
): IModelSelectionService & { dispose(): void } {
  const log = createServiceLogger("model-selection");
  let revision = 0;
  let disposed = false;
  const listeners = new Set<(view: ModelSelectionView) => void>();
  const getView = async (input?: ModelSelectionViewInput): Promise<ModelSelectionView> => {
    await ensureReady();
    if (disposed) throw new Error("ModelSelectionService 已 dispose");
    const configuredDefault = await configuredDefaultSource?.read();
    if (disposed) throw new Error("ModelSelectionService 已 dispose");
    const base = facade.getView(configuredDefault);
    if (revision < base.revision) revision = base.revision;
    return facade.getView(configuredDefault, revision, input);
  };
  const emit = (): void => {
    if (disposed) return;
    revision += 1;
    void getView().then(
      (view) => {
        if (disposed) return;
        for (const listener of listeners) listener(view);
      },
      (error: unknown) => {
        // Registry 事件触发的异步 View 重建没有 owner；Host dispose 后它仍会继续
        // 读取已释放的配置仓库，并形成未处理 rejection。dispose 是明确的取消边界；仅在服务
        // 仍存活时记录真实读取失败。
        if (disposed) return;
        log.warn(undefined, `ModelSelection View 刷新失败: ${String(error)}`);
      },
    );
  };
  const disposeFacade = facade.onDidChange(emit);
  const disposeConfiguredDefault = configuredDefaultSource?.onDidChange?.(emit);

  return {
    onDidChange: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    getView,
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeFacade();
      disposeConfiguredDefault?.();
      listeners.clear();
    },
  };
}

function toEvent<T>(subscribe: (listener: (event: T) => void) => () => void): Event<T> {
  return (listener) => {
    const dispose = subscribe(listener);
    return { dispose };
  };
}
