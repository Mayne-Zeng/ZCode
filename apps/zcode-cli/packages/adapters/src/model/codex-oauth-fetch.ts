type FetchLike = typeof globalThis.fetch;

const REASONING_INCLUDE = "reasoning.encrypted_content";
const MIN_OUTPUT_TOKENS = 16;
const CODEX_RESPONSES_HOST = "chatgpt.com";
const CODEX_RESPONSES_PATH = "/backend-api/codex/responses";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCodexResponsesRequest(input: RequestInfo | URL): boolean {
  const raw =
    typeof input === "string" ? input : input instanceof URL ? input.href : (input.url ?? "");
  try {
    const url = new URL(raw);
    return url.hostname === CODEX_RESPONSES_HOST && url.pathname === CODEX_RESPONSES_PATH;
  } catch {
    return false;
  }
}

async function readBody(input: RequestInfo | URL, init: RequestInit | undefined) {
  if (typeof init?.body === "string") return init.body;
  if (input instanceof Request) return input.clone().text();
  return undefined;
}

function normalizeInputRoles(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  return input.map((item) =>
    isRecord(item) && item.role === "system" ? { ...item, role: "developer" } : item,
  );
}

function normalizeBody(body: Record<string, unknown>): Record<string, unknown> {
  const include = new Set(
    (Array.isArray(body.include) ? body.include : []).filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    ),
  );
  include.add(REASONING_INCLUDE);
  const next: Record<string, unknown> = {
    ...body,
    store: false,
    stream: true,
    include: [...include],
    input: normalizeInputRoles(body.input),
  };
  if (next.tool_choice === undefined || next.tool_choice === null) next.tool_choice = "auto";
  if (next.parallel_tool_calls === undefined) next.parallel_tool_calls = true;
  // Ultra 是 Codex 的执行/速度预设，不是 Responses 的 reasoning.effort；旧模型配置
  // 仍可能带着它，发送前退到 API 支持的 max，避免整个请求被 400 拒绝。
  if (isRecord(next.reasoning) && next.reasoning.effort === "ultra") {
    next.reasoning = { ...next.reasoning, effort: "max" };
  }
  if (
    Number.isFinite(next.max_output_tokens) &&
    (next.max_output_tokens as number) > 0 &&
    (next.max_output_tokens as number) < MIN_OUTPUT_TOKENS
  ) {
    next.max_output_tokens = MIN_OUTPUT_TOKENS;
  }
  return next;
}

function aggregateSse(text: string): Record<string, unknown> {
  let completed: Record<string, unknown> | undefined;
  let failure: unknown;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trimStart();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    if (event.type === "response.completed" || event.type === "response.incomplete") {
      if (isRecord(event.response)) completed = event.response;
    } else if (event.type === "response.failed") {
      failure = isRecord(event.response) ? event.response.error : event.error;
    } else if (event.type === "error") {
      failure = event.error;
    }
  }
  if (completed) return completed;
  const message =
    isRecord(failure) && typeof failure.message === "string" && failure.message.trim()
      ? failure.message.trim()
      : "Codex 流结束但没有 response.completed";
  throw new Error(message);
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Codex 订阅的 wire 语义：上游固定无状态流式，并把 system 提示保留为普通 input。
 * ZCode 的标题/压缩等辅助调用会走非流式 generateText；这里把 SSE 聚合回 JSON，
 * 避免把 Responses 流直接交给 expect JSON 的调用方。
 */
export function createCodexOAuthFetch(fetchImpl: FetchLike): FetchLike {
  return async (input, init) => {
    if (!isCodexResponsesRequest(input)) return fetchImpl(input, init);
    const bodyText = await readBody(input, init);
    if (bodyText === undefined) return fetchImpl(input, init);
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return fetchImpl(input, init);
    }
    if (!isRecord(body)) return fetchImpl(input, init);
    const wantsStream = body.stream === true;
    const normalized = normalizeBody(body);
    const requestInit: RequestInit = {
      ...init,
      body: JSON.stringify(normalized),
      headers: new Headers(init?.headers),
    };
    (requestInit.headers as Headers).set("content-type", "application/json");
    (requestInit.headers as Headers).set("accept", "text/event-stream");
    const response = await fetchImpl(
      input instanceof Request ? new Request(input, requestInit) : input,
      input instanceof Request ? undefined : requestInit,
    );
    if (wantsStream || !response.ok) {
      // 流式调用直接透传；错误响应保留上游状态与正文，由现有错误分类消费。
      return response;
    }
    const text = await response.text().catch(() => "");
    try {
      return jsonResponse(aggregateSse(text));
    } catch (error) {
      return jsonResponse(
        {
          error: {
            message: error instanceof Error ? error.message : String(error),
            type: "codex_stream_incomplete",
          },
        },
        502,
      );
    }
  };
}
