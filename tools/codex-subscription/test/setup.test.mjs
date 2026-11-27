import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  OPENAI_RESPONSES_REASONING_MAP,
  buildManualModelRule,
  buildProviderRule,
  createEmptyProviderConfig,
  mergeProviderConfig,
  parseProviderConfig,
  readProviderConfigFile,
  writeProviderConfig,
} from "../src/setup.mjs";
import { createTempDir } from "./helpers.mjs";

const PROVIDER_ID = "codex-subscription";

function existingConfig() {
  return {
    schemaVersion: 1,
    config: {
      providerOrder: ["other-provider"],
      providerConfigRules: {
        providerRules: [
          {
            providerId: "other-provider",
            providerName: "Other",
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: "secret" },
              api: { type: "openai-chat-completions", baseUrl: "https://other.test/v1" },
              personalModelIds: ["other-model"],
              modelOrder: ["other-model"],
            },
          },
        ],
      },
      modelConfigRules: {
        providerModelRules: [
          { providerId: "other-provider", modelId: "other-model", config: { enabled: true } },
        ],
        manualProviderModelRules: [],
      },
      defaultModelSelection: { providerId: "other-provider", modelId: "other-model" },
    },
  };
}

test("buildProviderRule 使用 openai-responses 和本地地址", () => {
  const rule = buildProviderRule({
    providerId: PROVIDER_ID,
    providerName: "Codex 订阅",
    host: "0.0.0.0",
    port: 17870,
    models: [{ id: "gpt-6-astra" }],
  });
  assert.equal(rule.config.api.type, "openai-responses");
  assert.equal(rule.config.api.baseUrl, "http://127.0.0.1:17870/v1");
  assert.deepEqual(rule.config.personalModelIds, ["gpt-6-astra"]);
  assert.deepEqual(rule.config.modelOrder, ["gpt-6-astra"]);
});

test("buildManualModelRule 生成 ZCode manual schema 需要的完整字段", () => {
  const rule = buildManualModelRule({
    providerId: PROVIDER_ID,
    model: {
      id: "gpt-6-astra",
      contextWindow: 500000,
      maxOutputTokens: 128000,
      reasoningEfforts: ["low", "high", "high"],
      supportsImage: true,
      supportsPdf: false,
    },
  });
  assert.equal(rule.providerId, PROVIDER_ID);
  assert.equal(rule.modelId, "gpt-6-astra");
  assert.equal(rule.config.enabled, true);
  assert.equal(rule.config.properties.contextWindow, 500000);
  assert.equal(rule.config.properties.inputFormat.supportsImage, true);
  assert.equal(rule.config.properties.inputFormat.supportsVideo, false);
  assert.deepEqual(rule.config.optionSpecs.reasoningLevel.values, ["low", "high"]);
  assert.equal(rule.config.optionSpecs.reasoningLevel.map, OPENAI_RESPONSES_REASONING_MAP);
  assert.equal(rule.config.optionSpecs.maxOutputTokens.max, 128000);
});

test("非推理模型使用空 map 且不发送 reasoning", () => {
  const rule = buildManualModelRule({
    providerId: PROVIDER_ID,
    model: { id: "plain-model", reasoningEfforts: [] },
  });
  assert.deepEqual(rule.config.optionSpecs.reasoningLevel, {
    values: ["disabled"],
    map: "{}",
  });
  assert.equal(rule.config.properties.contextWindow, 272000);
});

test("mergeProviderConfig 只替换本工具拥有的内容", () => {
  const providerRule = buildProviderRule({
    providerId: PROVIDER_ID,
    providerName: "Codex 订阅",
    host: "127.0.0.1",
    port: 17870,
    models: [{ id: "gpt-6-astra" }],
  });
  const manualRules = [
    buildManualModelRule({
      providerId: PROVIDER_ID,
      model: { id: "gpt-6-astra", reasoningEfforts: ["high"] },
    }),
  ];
  const merged = mergeProviderConfig(existingConfig(), {
    providerRule,
    manualRules,
    providerId: PROVIDER_ID,
  });
  assert.equal(merged.config.providerConfigRules.providerRules.length, 2);
  assert.deepEqual(
    merged.config.providerConfigRules.providerRules.map((rule) => rule.providerId),
    ["other-provider", PROVIDER_ID],
  );
  assert.equal(merged.config.providerOrder.at(-1), PROVIDER_ID);
  assert.equal(merged.config.defaultModelSelection.providerId, "other-provider");
  assert.equal(merged.config.modelConfigRules.manualProviderModelRules.length, 1);
  assert.equal(merged.config.modelConfigRules.providerModelRules[0].providerId, "other-provider");
});

test("mergeProviderConfig 幂等且保留已有 enabled=false", () => {
  const providerRule = buildProviderRule({
    providerId: PROVIDER_ID,
    providerName: "Codex 订阅",
    host: "127.0.0.1",
    port: 17870,
    models: [{ id: "gpt-6-astra" }],
  });
  const manualRules = [
    buildManualModelRule({
      providerId: PROVIDER_ID,
      model: { id: "gpt-6-astra", reasoningEfforts: ["high"] },
    }),
  ];
  let config = mergeProviderConfig(existingConfig(), {
    providerRule,
    manualRules,
    providerId: PROVIDER_ID,
  });
  config = structuredClone(config);
  config.config.providerConfigRules.providerRules[1].enabled = false;
  const merged = mergeProviderConfig(config, {
    providerRule,
    manualRules,
    providerId: PROVIDER_ID,
  });
  assert.equal(merged.config.providerConfigRules.providerRules.length, 2);
  assert.equal(merged.config.providerConfigRules.providerRules[1].enabled, false);
  assert.equal(merged.config.modelConfigRules.manualProviderModelRules.length, 1);
  assert.equal(merged.config.providerOrder.filter((id) => id === PROVIDER_ID).length, 1);
});

test("writeProviderConfig 备份原文件并原子写入", async (t) => {
  const directory = await createTempDir(t);
  const filePath = join(directory, "provider_config.json");
  await writeFile(filePath, `${JSON.stringify(existingConfig(), null, 2)}\n`, { mode: 0o600 });
  const providerRule = buildProviderRule({
    providerId: PROVIDER_ID,
    providerName: "Codex 订阅",
    host: "127.0.0.1",
    port: 17870,
    models: [{ id: "gpt-6-astra" }],
  });
  const manualRules = [
    buildManualModelRule({
      providerId: PROVIDER_ID,
      model: { id: "gpt-6-astra", reasoningEfforts: ["high"] },
    }),
  ];
  const result = await writeProviderConfig({
    filePath,
    providerId: PROVIDER_ID,
    providerRule,
    manualRules,
  });
  assert.ok(result.backupPath);
  const backup = JSON.parse(await readFile(result.backupPath, "utf8"));
  assert.equal(backup.config.providerConfigRules.providerRules.length, 1);
  const written = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(written.config.providerConfigRules.providerRules.length, 2);
  const mode = (await stat(filePath)).mode & 0o777;
  assert.equal(mode, 0o600);
  const reread = await readProviderConfigFile(filePath);
  assert.equal(reread.config.providerConfigRules.providerRules[1].providerId, PROVIDER_ID);
});

test("parseProviderConfig 拒绝未知 schemaVersion", () => {
  assert.throws(
    () => parseProviderConfig(JSON.stringify({ schemaVersion: 2, config: {} }), "/tmp/x.json"),
    /schemaVersion=2/u,
  );
});

test("createEmptyProviderConfig 可直接被合并", () => {
  const providerRule = buildProviderRule({
    providerId: PROVIDER_ID,
    providerName: "Codex 订阅",
    host: "127.0.0.1",
    port: 17870,
    models: [{ id: "gpt-6-astra" }],
  });
  const merged = mergeProviderConfig(createEmptyProviderConfig(), {
    providerRule,
    manualRules: [],
    providerId: PROVIDER_ID,
  });
  assert.equal(merged.config.providerConfigRules.providerRules.length, 1);
  assert.deepEqual(merged.config.providerOrder, [PROVIDER_ID]);
});
