import { createServer } from "node:http";
import { Readable } from "node:stream";
import { MAX_REQUEST_BODY_BYTES } from "./constants.mjs";
import {
  aggregateResponsesSse,
  clientWantsStream,
  extractSessionId,
  normalizeRequestBody,
} from "./normalize.mjs";
import { CodexLoginRequiredError } from "./auth.mjs";
import { formatError } from "./log.mjs";

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function openAiError(message, { code = "codex_subscription_error" } = {}) {
  return { error: { message, type: "codex_subscription_error", code: String(code) } };
}

function parseUpstreamError(text, status) {
  try {
    const parsed = JSON.parse(text);
    if (parsed?.error) return parsed;
  } catch {
    // 非 JSON 错误按纯文本包装，保留上游状态码。
  }
  const message = String(text ?? "")
    .trim()
    .slice(0, 2000);
  return openAiError(message || `Codex 上游请求失败 (HTTP ${status})`, {
    status,
    code: status,
  });
}

function readBody(request, maxBytes = MAX_REQUEST_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(Object.assign(new Error("请求体超过上限"), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function parseJsonBody(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("请求体必须是 JSON 对象");
    }
    return parsed;
  } catch (error) {
    throw Object.assign(new Error(`无法解析请求体: ${formatError(error)}`), { statusCode: 400 });
  }
}

function writeAuthError(response, error) {
  const loginRequired = error instanceof CodexLoginRequiredError;
  sendJson(
    response,
    loginRequired ? 401 : 502,
    openAiError(formatError(error), {
      status: loginRequired ? 401 : 502,
      code: loginRequired ? "chatgpt_login_required" : "chatgpt_auth_error",
    }),
  );
}

async function pipeUpstream(response, upstream) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  if (!upstream.body) {
    response.end();
    return;
  }
  const nodeStream = Readable.fromWeb(upstream.body);
  nodeStream.on("error", () => response.destroy());
  response.on("close", () => nodeStream.destroy());
  nodeStream.pipe(response);
}

async function handleResponses({ request, response, auth, client, logger }) {
  const rawText = await readBody(request);
  const original = parseJsonBody(rawText);
  const sessionId = extractSessionId(request.headers);
  const wantsStream = clientWantsStream(original);
  const body = normalizeRequestBody(original, { sessionId });
  const model = typeof body.model === "string" ? body.model : undefined;
  const startedAt = Date.now();
  const abort = new AbortController();
  request.on("aborted", () => abort.abort());
  response.on("close", () => abort.abort());

  let credentials = await auth.getCredentials();
  let upstream = await client.requestResponses({
    body,
    credentials,
    sessionId,
    signal: abort.signal,
  });
  if (upstream.status === 401) {
    await upstream.body?.cancel().catch(() => undefined);
    credentials = await auth.getCredentials({ forceRefresh: true });
    upstream = await client.requestResponses({
      body,
      credentials,
      sessionId,
      signal: abort.signal,
    });
  }

  logger.info("responses", {
    status: upstream.status,
    model,
    stream: wantsStream,
    elapsedMs: Date.now() - startedAt,
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    sendJson(response, upstream.status, parseUpstreamError(text, upstream.status));
    return;
  }

  if (wantsStream) {
    await pipeUpstream(response, upstream);
    return;
  }

  const text = await upstream.text().catch(() => "");
  try {
    sendJson(response, 200, aggregateResponsesSse(text));
  } catch (error) {
    sendJson(response, 502, openAiError(formatError(error), { code: "codex_stream_incomplete" }));
  }
}

async function handleModels({ response, auth }) {
  const models = await auth.fetchModels();
  sendJson(response, 200, {
    object: "list",
    data: models.map((model) => ({
      id: model.id,
      object: "model",
      created: 0,
      owned_by: "openai",
    })),
  });
}

async function handleHealth({ response, auth }) {
  const status = await auth.getStatus();
  sendJson(response, 200, {
    ok: true,
    provider: "openai-codex",
    loggedIn: status.loggedIn === true,
    ...(status.expiresAt === undefined ? {} : { expiresAt: status.expiresAt }),
  });
}

async function route({ request, response, auth, client, logger }) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const path = url.pathname.replace(/\/+$/u, "") || "/";

  if (request.method === "GET" && (path === "/healthz" || path === "/v1/healthz")) {
    await handleHealth({ response, auth });
    return;
  }
  if (request.method === "GET" && (path === "/v1/models" || path === "/models")) {
    await handleModels({ response, auth });
    return;
  }
  if (request.method === "POST" && (path === "/v1/responses" || path === "/responses")) {
    await handleResponses({ request, response, auth, client, logger });
    return;
  }
  sendJson(response, 404, openAiError(`未知路径: ${request.method} ${path}`, { status: 404 }));
}

export function createProxyServer({ auth, client, logger }) {
  return createServer((request, response) => {
    void route({ request, response, auth, client, logger }).catch((error) => {
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : undefined;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof CodexLoginRequiredError) {
        writeAuthError(response, error);
        return;
      }
      const status = statusCode ?? 500;
      logger.error("请求失败", { status, error: formatError(error) });
      sendJson(response, status, openAiError(formatError(error), { status }));
    });
  });
}
