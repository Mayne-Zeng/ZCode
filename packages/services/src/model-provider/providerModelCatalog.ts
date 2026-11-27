import type { ProviderApiType } from "@zcode/provider";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

const log = createServiceLogger("provider-model-catalog");

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_CHARS = 4 * 1024 * 1024;
const MAX_MODELS = 1000;
const MAX_PAGES = 10;
const ANTHROPIC_VERSION = "2023-06-01";

export type ProviderCatalogInputModality = "image" | "video" | "audio" | "pdf";

/** 端点目录中的单个模型；只有端点确实返回的字段才会出现。 */
export interface ProviderCatalogModel {
  readonly modelId: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly inputModalities?: readonly ProviderCatalogInputModality[];
  /** 端点声明的可用 API 格式；缺省表示端点未提供该信息，不做过滤。 */
  readonly apiFormats?: readonly ProviderApiType[];
}

export interface ProviderModelCatalogInput {
  readonly apiType: ProviderApiType;
  readonly baseUrl: string;
  readonly apiKey: string;
}

export type ProviderModelCatalogFetcher = (
  input: ProviderModelCatalogInput,
) => Promise<readonly ProviderCatalogModel[]>;

interface ProviderModelCatalogOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const API_FORMAT_BY_ENDPOINT_TYPE: Record<string, ProviderApiType> = {
  openai: "openai-chat-completions",
  "openai-compatible": "openai-chat-completions",
  "openai-response": "openai-responses",
  responses: "openai-responses",
  anthropic: "anthropic-messages",
};

/**
 * 拉取 OpenAI/Anthropic 兼容端点的模型目录。
 *
 * API Key 只在 Host 内使用：这里不接受 Renderer 传入的任意端点，
 * 调用方必须先用已保存的 Provider Effective Config 解析出 baseUrl 与 apiKey。
 */
export function createProviderModelCatalogFetcher(
  options: ProviderModelCatalogOptions = {},
): ProviderModelCatalogFetcher {
  const fetchImpl =
    options.fetchImpl ??
    ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async function fetchProviderModelCatalog(
    input: ProviderModelCatalogInput,
  ): Promise<readonly ProviderCatalogModel[]> {
    const apiKey = input.apiKey.trim();
    if (!apiKey) throw new Error("读取模型列表失败：API Key 为空");
    const firstUrl = buildModelsUrl(input.baseUrl, input.apiType);
    const headers = buildRequestHeaders(input.apiType, apiKey);
    const collected: ProviderCatalogModel[] = [];
    const seen = new Set<string>();
    let url: URL | null = firstUrl;

    for (let page = 0; url && page < MAX_PAGES; page += 1) {
      const response = await requestPage(fetchImpl, url, headers, timeoutMs);
      const payload = await readJsonPayload(response);
      const pageModels = parseCatalogPayload(payload);
      for (const model of pageModels.models) {
        if (seen.has(model.modelId)) continue;
        seen.add(model.modelId);
        collected.push(model);
        if (collected.length >= MAX_MODELS) {
          log.warn(undefined, "模型目录超过上限，已截断", { limit: MAX_MODELS });
          return collected;
        }
      }
      url = pageModels.hasMore ? buildNextPageUrl(firstUrl, pageModels.lastId) : null;
    }
    return collected;
  };
}

function buildModelsUrl(baseUrl: string, apiType: ProviderApiType): URL {
  const trimmed = baseUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("读取模型列表失败：Base URL 不是有效地址");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("读取模型列表失败：Base URL 必须是 http(s) 地址");
  }
  // runtime SDK 接收的是 API base URL，会自行追加 /chat/completions、/responses 或 /messages；
  // 目录接口同样以 baseUrl + /models 定位，并保留用户配置的路径前缀（如 /erp/v1）。
  parsed.pathname = `${parsed.pathname.replace(/\/+$/u, "")}/models`;
  parsed.search = "";
  parsed.hash = "";
  // Anthropic 默认每页 20 个；显式拉满减少分页次数，分页仍按 has_more/last_id。
  if (apiType === "anthropic-messages") parsed.searchParams.set("limit", "1000");
  return parsed;
}

function buildNextPageUrl(baseUrl: URL, lastId: string | undefined): URL | null {
  if (!lastId) return null;
  const next = new URL(baseUrl.toString());
  next.searchParams.set("after_id", lastId);
  return next;
}

function buildRequestHeaders(apiType: ProviderApiType, apiKey: string): Record<string, string> {
  if (apiType === "anthropic-messages") {
    return {
      accept: "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    };
  }
  return {
    accept: "application/json",
    authorization: `Bearer ${apiKey}`,
  };
}

async function requestPage(
  fetchImpl: typeof fetch,
  url: URL,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers,
      // 重定向可能把 Authorization/x-api-key 带到其它 Origin；目录请求不需要跟随。
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`读取模型列表失败：${networkErrorMessage(error)}`);
  }
  if (response.ok) return response;
  const detail = await readErrorDetail(response);
  void response.body?.cancel().catch(() => undefined);
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `读取模型列表失败：API Key 无效或没有模型列表权限（HTTP ${response.status}）${
        detail ? `：${detail}` : ""
      }`,
    );
  }
  if (response.status === 404) {
    throw new Error(
      `读取模型列表失败：该端点未提供 /models 接口（HTTP 404）${detail ? `：${detail}` : ""}`,
    );
  }
  throw new Error(`读取模型列表失败 (HTTP ${response.status})${detail ? `：${detail}` : ""}`);
}

function networkErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|aborted|abort/i.test(message)) return "请求超时，请检查网络或代理设置";
  // fetch 的 redirect:"error" 与 DNS/TLS 失败只会给出 "fetch failed"，真实原因在 cause 中。
  const cause =
    error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined;
  if (!message || message === "fetch failed") {
    return cause || "网络请求失败（已禁止跨站重定向）";
  }
  return message;
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return "";
    let detail = text;
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) {
        const error = parsed.error;
        detail =
          (isRecord(error) && typeof error.message === "string" ? error.message : undefined) ??
          (typeof parsed.message === "string" ? parsed.message : text);
      }
    } catch {
      // 非 JSON 错误体按原文截断。
    }
    return truncate(detail, 200);
  } catch {
    return "";
  }
}

async function readJsonPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_CHARS) {
    throw new Error("读取模型列表失败：响应过大");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("读取模型列表失败：响应不是合法 JSON");
  }
}

interface ParsedCatalogPage {
  readonly models: readonly ProviderCatalogModel[];
  readonly hasMore: boolean;
  readonly lastId?: string;
}

function parseCatalogPayload(payload: unknown): ParsedCatalogPage {
  const container = findModelArray(payload);
  if (!container) throw new Error("读取模型列表失败：响应不是模型列表");
  const models: ProviderCatalogModel[] = [];
  for (const item of container.items) {
    const model = normalizeCatalogModel(item);
    if (model) models.push(model);
  }
  return {
    models,
    hasMore: container.hasMore && models.length > 0,
    ...(container.lastId ? { lastId: container.lastId } : {}),
  };
}

function findModelArray(
  payload: unknown,
): { items: readonly unknown[]; hasMore: boolean; lastId?: string } | null {
  if (Array.isArray(payload)) return { items: payload, hasMore: false };
  if (!isRecord(payload)) return null;
  const items = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.models)
      ? payload.models
      : null;
  if (!items) return null;
  const lastId =
    typeof payload.last_id === "string" && payload.last_id.trim()
      ? payload.last_id.trim()
      : undefined;
  return { items, hasMore: payload.has_more === true, ...(lastId ? { lastId } : {}) };
}

function normalizeCatalogModel(item: unknown): ProviderCatalogModel | null {
  const record = isRecord(item) ? item : null;
  const rawId = typeof item === "string" ? item : readModelId(record);
  const modelId = rawId?.trim();
  if (!modelId) return null;
  const contextWindow = readPositiveInteger(record, [
    "context_length",
    "context_window",
    "max_context_length",
    "max_model_len",
    "max_input_tokens",
  ]);
  const maxOutputTokens = readPositiveInteger(record, [
    "max_output_tokens",
    "max_completion_tokens",
  ]);
  const inputModalities = readInputModalities(record);
  const apiFormats = readApiFormats(record);
  return {
    modelId,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(inputModalities !== undefined ? { inputModalities } : {}),
    ...(apiFormats !== undefined ? { apiFormats } : {}),
  };
}

function readModelId(record: Record<string, unknown> | null): string | undefined {
  if (!record) return undefined;
  for (const key of ["id", "model", "name"] as const) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    // Google 风格目录返回 models/gemini-...；其它端点保持原样。
    return trimmed.startsWith("models/") ? trimmed.slice("models/".length) : trimmed;
  }
  return undefined;
}

function readPositiveInteger(
  record: Record<string, unknown> | null,
  keys: readonly string[],
): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    const parsed =
      typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function readInputModalities(
  record: Record<string, unknown> | null,
): readonly ProviderCatalogInputModality[] | undefined {
  if (!record) return undefined;
  const architecture = isRecord(record.architecture) ? record.architecture : null;
  const source =
    readStringArray(record.input_modalities) ??
    readStringArray(record.modalities) ??
    readStringArray(architecture?.input_modalities);
  if (!source) return undefined;
  const modalities: ProviderCatalogInputModality[] = [];
  for (const value of source) {
    const normalized = value.toLowerCase();
    if (normalized === "image" || normalized === "video" || normalized === "audio") {
      modalities.push(normalized);
    } else if (normalized === "pdf" || normalized === "file") {
      modalities.push("pdf");
    }
  }
  return modalities.length > 0 ? [...new Set(modalities)] : undefined;
}

function readApiFormats(
  record: Record<string, unknown> | null,
): readonly ProviderApiType[] | undefined {
  if (!record) return undefined;
  const source = readStringArray(record.supported_endpoint_types);
  if (!source) return undefined;
  const formats = new Set<ProviderApiType>();
  for (const value of source) {
    const mapped = API_FORMAT_BY_ENDPOINT_TYPE[value.toLowerCase()];
    if (mapped) formats.add(mapped);
  }
  // 端点声明了类型但都不属于聊天格式（如 embedding/rerank）时返回空数组，
  // 让同步按当前 API 格式过滤掉；缺省字段才表示端点没有提供格式信息。
  return [...formats];
}

function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings : undefined;
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
