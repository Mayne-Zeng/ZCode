import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { ICredentialService } from "../credential/credential.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import {
  CodexSubscriptionError,
  CodexSubscriptionLoginRequiredError,
  type CodexSubscriptionModel,
  type CodexSubscriptionRequestAuth,
  type CodexSubscriptionStatus,
} from "./codexSubscriptionTypes.js";

export type {
  CodexSubscriptionModel,
  CodexSubscriptionRequestAuth,
  CodexSubscriptionStatus,
} from "./codexSubscriptionTypes.js";
export {
  CodexSubscriptionError,
  CodexSubscriptionLoginRequiredError,
  isAllowedCodexBaseUrl,
} from "./codexSubscriptionTypes.js";

const log = createServiceLogger("codex-subscription");

const CREDENTIAL_KEY = "codex-subscription:auth";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE_URL = "https://auth.openai.com";
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
const MODELS_CLIENT_VERSION = "3.2.33";
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const REFRESH_SKEW_MS = 120_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

export interface CodexSubscriptionServiceOptions {
  readonly credentialService: Pick<ICredentialService, "load" | "save" | "delete">;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly now?: () => number;
  /** 仅测试用：回调监听端口可换；OAuth redirect_uri 仍固定 1455。 */
  readonly callbackPort?: number;
}

export interface CodexSubscriptionService {
  getStatus(): Promise<CodexSubscriptionStatus>;
  startLogin(): Promise<{ authorizeUrl: string }>;
  cancelLogin(): Promise<void>;
  logout(): Promise<void>;
  resolveRequestAuth(): Promise<CodexSubscriptionRequestAuth>;
  listModels(): Promise<readonly CodexSubscriptionModel[]>;
  dispose(): Promise<void>;
}

interface StoredCodexAuth {
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly accountId: string;
  readonly email?: string;
  readonly updatedAt: number;
}

interface PendingLogin {
  readonly authorizeUrl: string;
  readonly server: Server;
  readonly timer: NodeJS.Timeout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function safeErrorText(value: string): string {
  return value
    .replace(/("(?:access|refresh|id)_token"\s*:\s*")[^"]+/gu, "$1<redacted>")
    .slice(0, 300);
}

function decodeAuthClaims(accessToken: string): Record<string, unknown> | undefined {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    const auth = isRecord(payload) ? payload[JWT_CLAIM_PATH] : undefined;
    return isRecord(auth) ? auth : undefined;
  } catch {
    return undefined;
  }
}

export function decodeCodexAccountId(accessToken: string): string {
  const auth = decodeAuthClaims(accessToken);
  if (!auth) {
    throw new CodexSubscriptionError("access token 不是可解析的 ChatGPT JWT");
  }
  const accountId = auth.chatgpt_account_id;
  if (!nonEmptyString(accountId)) {
    throw new CodexSubscriptionError("access token 缺少 ChatGPT account id");
  }
  return accountId.trim();
}

function codexPlanType(accessToken: string): string | undefined {
  const auth = decodeAuthClaims(accessToken);
  return nonEmptyString(auth?.chatgpt_plan_type) ? auth.chatgpt_plan_type.trim() : undefined;
}

function decodeEmail(idToken: unknown): string | undefined {
  if (!nonEmptyString(idToken)) return undefined;
  const parts = idToken.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    return isRecord(payload) && nonEmptyString(payload.email) ? payload.email.trim() : undefined;
  } catch {
    return undefined;
  }
}

function parseStoredAuth(raw: string, key: string): StoredCodexAuth {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CodexSubscriptionError(`Codex 登录凭据损坏，请重新登录: ${key}`, { cause: error });
  }
  if (
    !isRecord(parsed) ||
    !nonEmptyString(parsed.access) ||
    !nonEmptyString(parsed.refresh) ||
    !Number.isFinite(parsed.expires) ||
    !nonEmptyString(parsed.accountId)
  ) {
    throw new CodexSubscriptionError(`Codex 登录凭据字段不完整，请重新登录: ${key}`);
  }
  return {
    access: parsed.access,
    refresh: parsed.refresh,
    expires: parsed.expires as number,
    accountId: parsed.accountId,
    ...(nonEmptyString(parsed.email) ? { email: parsed.email } : {}),
    updatedAt: Number.isFinite(parsed.updatedAt) ? (parsed.updatedAt as number) : 0,
  };
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Responses API 接受的 reasoning.effort；Codex 目录里的 ultra 是执行预设，不是合法档位。 */
const NATIVE_CODEX_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 账号目录是可用模型的唯一权威；只保留可见且支持 API 的条目。 */
export function normalizeCodexModels(raw: unknown): CodexSubscriptionModel[] {
  const list = isRecord(raw) && Array.isArray(raw.models) ? raw.models : [];
  const seen = new Set<string>();
  const models: CodexSubscriptionModel[] = [];
  for (const item of list) {
    if (!isRecord(item) || !nonEmptyString(item.slug)) continue;
    const id = item.slug.trim();
    if (seen.has(id) || item.visibility !== "list" || item.supported_in_api === false) continue;
    seen.add(id);
    const advertisedEfforts = Array.isArray(item.supported_reasoning_levels)
      ? item.supported_reasoning_levels.flatMap((level) => {
          const effort = isRecord(level) ? level.effort : level;
          return nonEmptyString(effort) ? [effort.trim()] : [];
        })
      : [];
    // Ultra 只能作为速度/执行预设，绝不能原样写进 reasoning.effort；目录只给 ultra
    // 时退到 API 支持的 max，避免模型配置出现上游必然拒绝的档位。
    const efforts = NATIVE_CODEX_EFFORTS.filter((effort) => advertisedEfforts.includes(effort));
    if (efforts.length === 0 && advertisedEfforts.includes("ultra")) efforts.push("max");
    const inputs = Array.isArray(item.input_modalities)
      ? item.input_modalities.filter((value): value is string => typeof value === "string")
      : ["text"];
    const contextWindow =
      positiveInteger(item.context_window) ?? positiveInteger(item.max_context_window);
    const maxOutputTokens = positiveInteger(item.max_output_tokens);
    models.push({
      id,
      name: nonEmptyString(item.display_name) ? item.display_name.trim() : id,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      reasoningEfforts: uniqueStrings(efforts),
      supportsImage: inputs.includes("image"),
      supportsPdf: inputs.includes("pdf"),
    });
  }
  return models;
}

function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function buildAuthorizeUrl(state: string, challenge: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "codex_cli_rs");
  return url.toString();
}

function respondHtml(response: import("node:http").ServerResponse, status: number, text: string) {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(
    `<!doctype html><meta charset="utf-8"><title>Codex 订阅</title>` +
      `<body style="font-family:system-ui;padding:3rem;line-height:1.6">${text}</body>`,
  );
}

export function createCodexSubscriptionService(
  options: CodexSubscriptionServiceOptions,
): CodexSubscriptionService {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const callbackPort = options.callbackPort ?? 1455;
  let pending: PendingLogin | null = null;
  let lastError: string | null = null;
  // 登录阶段跨越 callback 与 token 交换，getStatus 在两个阶段都必须保持 pending；
  // 否则 UI 会在回调已到、凭据未写时停止轮询，自动同步也永远不会触发。
  let loginPhase: "idle" | "waiting" | "exchanging" = "idle";
  // 登录换代令牌：新登录、取消或退出后，迟到的 token 交换不能再覆盖当前凭据。
  let loginGeneration = 0;
  // 凭据换代令牌：logout/新登录/刷新写回都要让更早的在途刷新失效，避免退出后被复活。
  let credentialGeneration = 0;
  let refreshInFlight: Promise<StoredCodexAuth> | null = null;
  let disposed = false;

  async function readStored(): Promise<StoredCodexAuth | null> {
    const raw = await options.credentialService.load(CREDENTIAL_KEY);
    if (raw === null || raw.trim() === "") return null;
    return parseStoredAuth(raw, CREDENTIAL_KEY);
  }

  async function writeStored(auth: StoredCodexAuth): Promise<StoredCodexAuth> {
    await options.credentialService.save(CREDENTIAL_KEY, JSON.stringify(auth));
    credentialGeneration += 1;
    return auth;
  }

  function baseHeaders(accountId: string): Record<string, string> {
    return {
      "chatgpt-account-id": accountId,
      originator: "zcode",
    };
  }

  function responseHeaders(accountId: string): Record<string, string> {
    return {
      ...baseHeaders(accountId),
      "OpenAI-Beta": "responses=experimental",
    };
  }

  async function postToken(form: URLSearchParams): Promise<{
    access: string;
    refresh: string;
    expires: number;
    email?: string;
  }> {
    const response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      throw new CodexSubscriptionError(
        text.includes("unsupported_country_region_territory")
          ? `ChatGPT 拒绝当前出口地区（HTTP ${response.status}）；请把代理出口切到支持的地区，或在 ZCode 设置中配置同一个代理。`
          : `ChatGPT token 请求失败 (HTTP ${response.status}): ${safeErrorText(text)}`,
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new CodexSubscriptionError("ChatGPT token 响应不是有效 JSON", { cause: error });
    }
    if (
      !isRecord(json) ||
      !nonEmptyString(json.access_token) ||
      !nonEmptyString(json.refresh_token) ||
      !Number.isFinite(json.expires_in)
    ) {
      throw new CodexSubscriptionError("ChatGPT token 响应缺少 access/refresh/expires_in");
    }
    return {
      access: json.access_token,
      refresh: json.refresh_token,
      expires: now() + (json.expires_in as number) * 1000,
      ...(nonEmptyString(json.id_token) ? { email: decodeEmail(json.id_token) } : {}),
    };
  }

  async function exchangeCode(code: string, verifier: string): Promise<StoredCodexAuth> {
    const tokens = await postToken(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      }),
    );
    return {
      access: tokens.access,
      refresh: tokens.refresh,
      expires: tokens.expires,
      accountId: decodeCodexAccountId(tokens.access),
      ...(tokens.email ? { email: tokens.email } : {}),
      updatedAt: now(),
    };
  }

  async function refresh(auth: StoredCodexAuth): Promise<StoredCodexAuth> {
    const generation = credentialGeneration;
    let tokens: Awaited<ReturnType<typeof postToken>>;
    try {
      tokens = await postToken(
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: auth.refresh,
          client_id: CLIENT_ID,
        }),
      );
    } catch (error) {
      // refresh token 被撤销/过期时不能只给通用 400，让用户知道需要重新登录。
      if (
        error instanceof CodexSubscriptionError &&
        /invalid_grant|invalid_token|token_expired/iu.test(error.message)
      ) {
        throw new CodexSubscriptionLoginRequiredError("ChatGPT 登录已失效，请重新登录");
      }
      throw error;
    }
    const next = {
      access: tokens.access,
      refresh: tokens.refresh,
      expires: tokens.expires,
      accountId: decodeCodexAccountId(tokens.access),
      email: auth.email ?? tokens.email,
      updatedAt: now(),
    } satisfies StoredCodexAuth;
    // 网络期间可能发生 logout 或另一次登录；只有仍是发起刷新时的那份凭据才写回。
    const current = await readStored();
    if (!current) throw new CodexSubscriptionLoginRequiredError();
    if (generation !== credentialGeneration || current.refresh !== auth.refresh) {
      if (current.expires - REFRESH_SKEW_MS > now()) return current;
      throw new CodexSubscriptionLoginRequiredError("登录状态已变化，请重新登录");
    }
    return writeStored(next);
  }

  async function resolveStored(forceRefresh = false): Promise<StoredCodexAuth> {
    const auth = await readStored();
    if (!auth) throw new CodexSubscriptionLoginRequiredError();
    if (!forceRefresh && auth.expires - REFRESH_SKEW_MS > now()) return auth;
    if (!refreshInFlight) {
      refreshInFlight = refresh(auth).finally(() => {
        refreshInFlight = null;
      });
    }
    return refreshInFlight;
  }

  function closePending(): void {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.server.close();
    pending = null;
  }

  async function getStatus(): Promise<CodexSubscriptionStatus> {
    // callback 已到、token 交换尚未完成时仍属 pending；不能提前落到 signed-out。
    if (loginPhase !== "idle") return { supported: true, state: "pending" };
    try {
      const auth = await readStored();
      if (auth) {
        return {
          supported: true,
          state: "signed-in",
          ...(auth.email ? { email: auth.email } : {}),
          accountId: auth.accountId,
          expiresAt: auth.expires,
        };
      }
    } catch (error) {
      return {
        supported: true,
        state: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      supported: true,
      state: lastError ? "error" : "signed-out",
      ...(lastError ? { errorMessage: lastError } : {}),
    };
  }

  async function startLogin(): Promise<{ authorizeUrl: string }> {
    if (disposed) throw new CodexSubscriptionError("Codex 订阅服务已释放");
    closePending();
    lastError = null;
    loginPhase = "waiting";
    const generation = ++loginGeneration;
    const state = randomBytes(16).toString("hex");
    const { verifier, challenge } = createPkcePair();
    const authorizeUrl = buildAuthorizeUrl(state, challenge);
    const server = createServer((request, response) => {
      let url: URL;
      try {
        url = new URL(request.url ?? "/", "http://127.0.0.1");
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }
      if (url.pathname !== "/auth/callback") {
        response.writeHead(404);
        response.end("Not found");
        return;
      }
      const error = url.searchParams.get("error");
      const returnedState = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      // 同一端口可能收到上一次登录遗留标签页的回调；只有当前 generation 才能
      // 改写状态/关闭当前 pending，避免旧标签把新登录打断。
      const isCurrent = () => generation === loginGeneration;
      if (error) {
        if (isCurrent()) {
          lastError =
            error === "unsupported_country_region_territory"
              ? "ChatGPT 登录被地区限制：请把浏览器代理切到支持的地区（如美国/日本/新加坡）后重试。"
              : `ChatGPT 登录被拒绝: ${error}`;
          loginPhase = "idle";
          closePending();
        }
        log.warn(undefined, "Codex 订阅 OAuth 回调返回错误", {
          error,
          errorDescription: url.searchParams.get("error_description") ?? undefined,
          stale: !isCurrent(),
        });
        respondHtml(response, 400, "登录失败，可以关闭此页面。");
        return;
      }
      if (returnedState !== state) {
        // 错 state 可能来自旧标签或本机探测；只拒绝这次回调，不能取消仍在等待的合法登录。
        log.warn(undefined, "Codex 订阅 OAuth state 不匹配", { stale: !isCurrent() });
        respondHtml(response, 400, "state 校验失败或登录已过期，请回到 ZCode 重新登录。");
        return;
      }
      if (!code) {
        respondHtml(response, 400, "回调缺少 authorization code。");
        return;
      }
      if (!isCurrent()) {
        respondHtml(response, 409, "这次登录已失效，请回到 ZCode 重新发起登录。");
        return;
      }
      respondHtml(response, 200, "登录完成，可以关闭此页面并回到 ZCode。");
      loginPhase = "exchanging";
      closePending();
      void exchangeCode(code, verifier)
        .then(async (auth) => {
          if (generation !== loginGeneration) return;
          await writeStored(auth);
          loginPhase = "idle";
          // 只记录套餐类型，不记录 token/account id；用于区分 Codex OAuth token 与
          // 普通 ChatGPT 网页会话 token。
          log.info(undefined, "Codex 订阅登录完成", {
            planType: codexPlanType(auth.access),
          });
        })
        .catch((error: unknown) => {
          if (generation !== loginGeneration) return;
          lastError = error instanceof Error ? error.message : String(error);
          loginPhase = "idle";
          log.warn(undefined, "Codex 订阅 token 交换失败", { error: lastError });
        });
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        reject(
          new CodexSubscriptionError(
            error.code === "EADDRINUSE"
              ? `本地 OAuth 回调端口 ${callbackPort} 被占用；请先关闭 Codex CLI、其它登录中的终端或 codex-sub 网关后重试`
              : `启动 ChatGPT 登录回调失败: ${error.message}`,
            { cause: error },
          ),
        );
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(callbackPort, "127.0.0.1");
    }).catch((error: unknown) => {
      loginPhase = "idle";
      lastError = error instanceof Error ? error.message : String(error);
      throw error;
    });
    const timer = setTimeout(() => {
      lastError = "ChatGPT 登录超时，请重新发起登录";
      loginPhase = "idle";
      closePending();
    }, LOGIN_TIMEOUT_MS);
    timer.unref?.();
    pending = { authorizeUrl, server, timer };
    log.info(undefined, "Codex 订阅登录已发起");
    return { authorizeUrl };
  }

  async function cancelLogin(): Promise<void> {
    // token 交换在途时 pending 已清空，但取消仍必须作废这次 exchange。
    if (!pending && loginPhase !== "exchanging") return;
    loginGeneration += 1;
    loginPhase = "idle";
    lastError = null;
    closePending();
  }

  async function logout(): Promise<void> {
    loginGeneration += 1;
    // 先推进凭据代次再删除；在途 refresh 即使拿到响应也不能把旧 token 写回。
    credentialGeneration += 1;
    loginPhase = "idle";
    closePending();
    lastError = null;
    await options.credentialService.delete(CREDENTIAL_KEY);
  }

  async function resolveRequestAuth(): Promise<CodexSubscriptionRequestAuth> {
    const auth = await resolveStored();
    return {
      apiKey: auth.access,
      headers: responseHeaders(auth.accountId),
    };
  }

  async function listModels(): Promise<readonly CodexSubscriptionModel[]> {
    let auth = await resolveStored();
    const request = async () => {
      const url = new URL(MODELS_URL);
      url.searchParams.set("client_version", MODELS_CLIENT_VERSION);
      return fetchImpl(url, {
        headers: {
          ...baseHeaders(auth.accountId),
          // resolveRequestAuth 的 apiKey 由 Model 执行层写成 Bearer；目录请求没有
          // 那条路径，必须在这里显式带上，否则会被 Codex 当成未登录请求。
          authorization: `Bearer ${auth.access}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    };
    let response = await request();
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      auth = await resolveStored(true);
      response = await request();
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new CodexSubscriptionError(
        text.includes("unsupported_country_region_territory")
          ? `Codex 拒绝当前出口地区（HTTP ${response.status}）；请把代理出口切到支持的地区，或在 ZCode 设置中配置同一个代理。`
          : `读取 Codex 模型目录失败 (HTTP ${response.status}): ${safeErrorText(text)}`,
      );
    }
    const raw: unknown = await response.json().catch(() => undefined);
    if (!isRecord(raw) || !Array.isArray(raw.models)) {
      throw new CodexSubscriptionError("Codex 模型目录响应缺少 models 数组");
    }
    return normalizeCodexModels(raw);
  }

  async function dispose(): Promise<void> {
    disposed = true;
    loginGeneration += 1;
    credentialGeneration += 1;
    loginPhase = "idle";
    closePending();
  }

  return Object.freeze({
    getStatus,
    startLogin,
    cancelLogin,
    logout,
    resolveRequestAuth,
    listModels,
    dispose,
  });
}
