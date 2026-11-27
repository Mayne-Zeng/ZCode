import { readFile } from "node:fs/promises";
import { atomicWritePrivateFile, withFileLock } from "./lock.mjs";

export const OPENAI_RESPONSES_REASONING_MAP =
  '{"reasoning":{"effort":reasoningLevel == "disabled" ? "none" : reasoningLevel == "enabled" ? "high" : reasoningLevel}}';

const DEFAULT_CONTEXT_WINDOW = 272_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 128_000;
const SUPPORTED_SCHEMA_VERSION = 1;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function uniqueNonEmpty(values) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : []).filter(
        (value) => typeof value === "string" && value.trim().length > 0,
      ),
    ),
  ];
}

export function createEmptyProviderConfig() {
  return {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    config: {
      providerOrder: [],
      providerConfigRules: { providerRules: [] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  };
}

/**
 * 读到不认识的 schema 就停手：外部工具不能替 ZCode 做迁移，也不能把用户配置降级。
 */
export function parseProviderConfig(rawText, filePath) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(`ZCode Provider 配置文件不是有效 JSON，已停止写入: ${filePath}`, {
      cause: error,
    });
  }
  if (!isRecord(parsed)) {
    throw new Error(`ZCode Provider 配置文件根节点不是对象，已停止写入: ${filePath}`);
  }
  if (parsed.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `ZCode Provider 配置 schemaVersion=${String(parsed.schemaVersion)}，本工具只支持 ${SUPPORTED_SCHEMA_VERSION}，已停止写入`,
    );
  }
  const config = parsed.config;
  if (
    !isRecord(config) ||
    !isRecord(config.providerConfigRules) ||
    !Array.isArray(config.providerConfigRules.providerRules) ||
    !isRecord(config.modelConfigRules) ||
    !Array.isArray(config.modelConfigRules.providerModelRules) ||
    !Array.isArray(config.modelConfigRules.manualProviderModelRules)
  ) {
    throw new Error(`ZCode Provider 配置结构不完整，已停止写入: ${filePath}`);
  }
  return parsed;
}

export async function readProviderConfigFile(filePath) {
  let rawText;
  try {
    rawText = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return createEmptyProviderConfig();
    throw error;
  }
  return parseProviderConfig(rawText, filePath);
}

export function loopbackHost(host) {
  return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

export function buildProviderRule({ providerId, providerName, host, port, models }) {
  return {
    providerId,
    providerName,
    config: {
      group: "standard-personal",
      access: { type: "api-key", apiKey: providerId },
      api: {
        type: "openai-responses",
        baseUrl: `http://${loopbackHost(host)}:${port}/v1`,
      },
      personalModelIds: models.map((model) => model.id),
      modelOrder: models.map((model) => model.id),
    },
  };
}

export function buildManualModelRule({ providerId, model }) {
  const efforts = uniqueNonEmpty(model.reasoningEfforts);
  const hasReasoning = efforts.length > 0;
  return {
    providerId,
    modelId: model.id,
    config: {
      enabled: true,
      properties: {
        contextWindow: positiveInteger(model.contextWindow, DEFAULT_CONTEXT_WINDOW),
        supportsJsonSchemaOutput: true,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: false,
        inputFormat: {
          supportsImage: model.supportsImage === true,
          supportsVideo: false,
          supportsPdf: model.supportsPdf === true,
        },
      },
      optionSpecs: {
        // ZCode 的 manual 模型配置要求 reasoningLevel 自带 map；非推理模型写空 patch。
        reasoningLevel: hasReasoning
          ? { values: efforts, map: OPENAI_RESPONSES_REASONING_MAP }
          : { values: ["disabled"], map: "{}" },
        maxOutputTokens: {
          max: positiveInteger(model.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS),
        },
      },
    },
  };
}

/**
 * 只替换本工具拥有的 Provider 与模型规则；其它 Provider、默认模型选择原样保留。
 */
export function mergeProviderConfig(fileConfig, { providerRule, manualRules, providerId }) {
  const next = structuredClone(fileConfig);
  const config = next.config;
  const rules = config.providerConfigRules.providerRules;
  const existingIndex = rules.findIndex((rule) => rule?.providerId === providerId);
  const existing = existingIndex >= 0 ? rules[existingIndex] : undefined;
  const mergedRule = {
    ...providerRule,
    ...(existing?.enabled === false ? { enabled: false } : {}),
  };
  if (existingIndex >= 0) rules[existingIndex] = mergedRule;
  else rules.push(mergedRule);

  const order = Array.isArray(config.providerOrder) ? config.providerOrder : [];
  config.providerOrder = order.includes(providerId) ? order : [...order, providerId];

  const modelRules = config.modelConfigRules;
  modelRules.providerModelRules = modelRules.providerModelRules.filter(
    (rule) => rule?.providerId !== providerId,
  );
  modelRules.manualProviderModelRules = [
    ...modelRules.manualProviderModelRules.filter((rule) => rule?.providerId !== providerId),
    ...manualRules,
  ];
  return next;
}

function backupPath(filePath, now) {
  const stamp = new Date(now).toISOString().replace(/[:.]/gu, "-");
  return `${filePath}.bak-${stamp}`;
}

/**
 * @returns {Promise<{ config: object, backupPath?: string }>}
 */
export async function writeProviderConfig({
  filePath,
  providerRule,
  manualRules,
  providerId,
  now = Date.now,
}) {
  let backup;
  const merged = await withFileLock(filePath, async () => {
    const current = await readProviderConfigFile(filePath);
    const next = mergeProviderConfig(current, { providerRule, manualRules, providerId });
    try {
      const rawText = await readFile(filePath, "utf8");
      backup = backupPath(filePath, now());
      await atomicWritePrivateFile(backup, rawText);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await atomicWritePrivateFile(filePath, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
  return { config: merged, ...(backup ? { backupPath: backup } : {}) };
}
