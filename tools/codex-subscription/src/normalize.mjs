import { PACKAGE_NAME, VERSION } from "./constants.mjs";

const REASONING_INCLUDE = "reasoning.encrypted_content";
const MIN_OUTPUT_TOKENS = 16;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/u;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstHeader(headers, names) {
  for (const name of names) {
    const raw = headers?.[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === "string" && SESSION_ID_PATTERN.test(value.trim())) return value.trim();
  }
  return undefined;
}

export function extractSessionId(headers) {
  return firstHeader(headers, [
    "session-id",
    "x-codex-session-id",
    "x-zcode-session-id",
    "x-client-request-id",
  ]);
}

/**
 * Codex 后端要求无状态流式 Responses：store=false、stream=true，并回传加密推理。
 * 其余字段保留 ZCode 的原始请求，只补缺省值，不在这里改写工具/推理语义。
 */
export function normalizeRequestBody(body, { sessionId } = {}) {
  if (!isRecord(body)) throw new Error("Codex 请求体必须是 JSON 对象");
  const include = new Set(
    (Array.isArray(body.include) ? body.include : []).filter(
      (value) => typeof value === "string" && value.trim().length > 0,
    ),
  );
  include.add(REASONING_INCLUDE);
  const next = {
    ...body,
    store: false,
    stream: true,
    include: [...include],
  };
  if (next.tool_choice === undefined || next.tool_choice === null) next.tool_choice = "auto";
  if (next.parallel_tool_calls === undefined) next.parallel_tool_calls = true;
  // Ultra 是 Codex 的执行/速度预设，不是 Responses 的 reasoning.effort；客户端若从
  // 目录里带了它，发送前退到 API 支持的 max，避免整轮请求被 400 拒绝。
  if (isRecord(next.reasoning) && next.reasoning.effort === "ultra") {
    next.reasoning = { ...next.reasoning, effort: "max" };
  }
  if (
    Number.isFinite(next.max_output_tokens) &&
    next.max_output_tokens > 0 &&
    next.max_output_tokens < MIN_OUTPUT_TOKENS
  ) {
    next.max_output_tokens = MIN_OUTPUT_TOKENS;
  }
  if (sessionId && !next.prompt_cache_key) next.prompt_cache_key = sessionId;
  return next;
}

export function buildUpstreamHeaders(credentials, { sessionId } = {}) {
  return {
    authorization: `Bearer ${credentials.access}`,
    "chatgpt-account-id": credentials.accountId,
    "openai-beta": "responses=experimental",
    originator: "zcode",
    "user-agent": `${PACKAGE_NAME}/${VERSION}`,
    accept: "text/event-stream",
    "content-type": "application/json",
    ...(sessionId ? { "session-id": sessionId, "x-client-request-id": sessionId } : {}),
  };
}

export function clientWantsStream(body) {
  return isRecord(body) && body.stream === true;
}

/**
 * 非流式调用（标题、压缩等辅助请求）仍让上游走 SSE，再聚合 response.completed 成 JSON。
 */
export function aggregateResponsesSse(text) {
  let completed;
  let failure;
  for (const rawLine of String(text).split(/\r?\n/u)) {
    const line = rawLine.trimStart();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event?.type === "response.completed" || event?.type === "response.incomplete") {
      if (isRecord(event.response)) completed = event.response;
    } else if (event?.type === "response.failed") {
      failure = event.response?.error ?? event.error ?? { message: "Codex response failed" };
    } else if (event?.type === "error") {
      failure = event.error ?? { message: "Codex stream error" };
    }
  }
  if (completed) return completed;
  if (failure) {
    const message =
      typeof failure.message === "string" && failure.message.trim()
        ? failure.message.trim()
        : "Codex 响应失败";
    throw new Error(message);
  }
  throw new Error("Codex 流结束但未返回 response.completed");
}
