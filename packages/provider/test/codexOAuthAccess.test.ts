import { describe, expect, it } from "vitest";
import {
  CodexOAuthAccessConfig,
  ModelConfig,
  ModelConfigRules,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigService,
  parseProviderConfig,
  type PersonalProviderConfigRepository,
  type ProviderConfigLayerSnapshot,
  type ProviderConfigLayerUpdate,
} from "../src/index.js";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

class MemoryPersonalRepository implements PersonalProviderConfigRepository {
  #snapshot: ProviderConfigLayerSnapshot;

  constructor(snapshot: ProviderConfigLayerSnapshot) {
    this.#snapshot = snapshot;
  }

  async read(): Promise<ProviderConfigLayerSnapshot> {
    return this.#snapshot;
  }

  onDidChange(): () => void {
    return () => undefined;
  }

  async update(
    transform: (current: ProviderConfigLayerSnapshot) => ProviderConfigLayerUpdate,
  ): Promise<ProviderConfigLayerSnapshot> {
    const update = transform(this.#snapshot);
    this.#snapshot = Object.freeze({
      revision: `${Number(this.#snapshot.revision) + 1}`,
      providers: update.providers,
      models: update.models,
      ...(update.providerOrder === undefined ? {} : { providerOrder: update.providerOrder }),
    });
    return this.#snapshot;
  }
}

function codexProviderConfig(): ProviderConfig {
  return new ProviderConfig({
    group: "standard-personal",
    access: new CodexOAuthAccessConfig(),
    api: new ProviderApiConfig({ type: "openai-responses", baseUrl: CODEX_BASE_URL }),
    personalModelIds: [],
    modelOrder: [],
  });
}

function modelConfig(modelId: string): ModelConfig {
  return ModelConfig.fromData({
    enabled: true,
    properties: {
      contextWindow: 272000,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
      inputFormat: { supportsImage: true, supportsVideo: false, supportsPdf: false },
    },
    optionSpecs: {
      reasoningLevel: {
        values: ["low", "high"],
        map: '{"reasoning":{"effort":reasoningLevel}}',
      },
      maxOutputTokens: { max: 128000 },
    },
  });
}

describe("codex-oauth provider access", () => {
  it("解析为专用 Access，不接受 apiKey", () => {
    const parsed = parseProviderConfig({
      group: "standard-personal",
      access: { type: "codex-oauth" },
      api: { type: "openai-responses", baseUrl: CODEX_BASE_URL },
      personalModelIds: [],
      modelOrder: [],
    });
    expect(parsed.access).toBeInstanceOf(CodexOAuthAccessConfig);
    expect(parsed.access?.toJSON()).toEqual({ type: "codex-oauth" });
    expect(() =>
      parseProviderConfig({
        access: { type: "codex-oauth", apiKey: "leak" },
      }),
    ).toThrow();
  });

  it("替换模型只重写目标 Provider 的成员与手动规则", async () => {
    const initial: ProviderConfigLayerSnapshot = {
      revision: "1",
      providers: new ProviderConfigMap([["codex-subscription", codexProviderConfig()]]),
      models: ModelConfigRules.empty(),
      providerOrder: ["codex-subscription"],
    };
    const repository = new MemoryPersonalRepository(initial);
    const service = new ProviderConfigService({
      zcodeBuiltinSource: {
        async read() {
          return {
            revision: "builtin-1",
            providers: new ProviderConfigMap(),
            models: ModelConfigRules.empty(),
          };
        },
        onDidChange() {
          return () => undefined;
        },
      },
      personalRepository: repository,
    });

    const first = await service.replacePersonalModels("codex-subscription", [
      { modelId: "gpt-6-astra", config: modelConfig("gpt-6-astra") },
      { modelId: "gpt-6-luna", config: modelConfig("gpt-6-luna") },
    ]);
    expect(first.providers.get("codex-subscription")?.personalModelIds).toEqual([
      "gpt-6-astra",
      "gpt-6-luna",
    ]);
    expect(first.models.getExactRule("codex-subscription", "gpt-6-astra")?.type).toBe(
      "manual-provider-model",
    );

    const second = await service.replacePersonalModels("codex-subscription", [
      { modelId: "gpt-6.2-sol", config: modelConfig("gpt-6.2-sol") },
    ]);
    expect(second.providers.get("codex-subscription")?.personalModelIds).toEqual(["gpt-6.2-sol"]);
    expect(second.models.getExactRule("codex-subscription", "gpt-6-astra")).toBeUndefined();
    expect(second.models.getExactRule("codex-subscription", "gpt-6.2-sol")?.type).toBe(
      "manual-provider-model",
    );
  });
});
