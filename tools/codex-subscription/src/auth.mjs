import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import {
  DEVICE_CODE_TIMEOUT_MS,
  JWT_CLAIM_PATH,
  LOGIN_TIMEOUT_MS,
  MODEL_CACHE_MAX_AGE_MS,
  PACKAGE_NAME,
  REFRESH_SKEW_MS,
  VERSION,
} from "./constants.mjs";
import { createAuthState } from "./auth-store.mjs";
import { createLogger, formatError } from "./log.mjs";

const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
const MODELS_REQUEST_TIMEOUT_MS = 30_000;
const TOKEN_ERROR_PREVIEW = 300;

export class CodexAuthError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "CodexAuthError";
  }
}

export class CodexLoginRequiredError extends CodexAuthError {
  constructor(message = "ChatGPT 尚未登录，请先运行 login 命令") {
    super(message);
    this.name = "CodexLoginRequiredError";
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function base64Url(buffer) {
  return buffer.toString("base64url");
}

export function decodeJwt(token) {
  if (!nonEmptyString(token)) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function extractAccountId(accessToken) {
  const payload = decodeJwt(accessToken);
  const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
  if (!nonEmptyString(accountId)) {
    throw new CodexAuthError("无法从 access token 中解析 ChatGPT account id，请重新登录");
  }
  return accountId.trim();
}

export function extractEmail(idToken) {
  const payload = decodeJwt(idToken);
  return nonEmptyString(payload?.email) ? payload.email.trim() : undefined;
}

export function createPkcePair() {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return Object.freeze({ verifier, challenge });
}

export function createAuthorizationUrl({ config, state, challenge, originator = "codex_cli_rs" }) {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", originator);
  return url.toString();
}

export function parseAuthorizationInput(input) {
  const value = String(input ?? "").trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // 不是完整 URL，继续按 code / query 片段解析。
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }
  return { code: value };
}

function truncate(text) {
  const value = String(text ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  return value.length > TOKEN_ERROR_PREVIEW ? `${value.slice(0, TOKEN_ERROR_PREVIEW)}…` : value;
}

async function requestWithTimeout(fetchImpl, url, init, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetchImpl(url, { ...init, signal });
}

async function readTokenResponse(response, operation) {
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    throw new CodexAuthError(
      `ChatGPT ${operation}失败 (HTTP ${response.status}): ${truncate(text) || response.statusText}`,
    );
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CodexAuthError(`ChatGPT ${operation}返回了无法解析的 JSON`);
  }
  if (!isRecord(json) || !nonEmptyString(json.access_token)) {
    throw new CodexAuthError(`ChatGPT ${operation}响应缺少 access_token`);
  }
  if (!nonEmptyString(json.refresh_token)) {
    throw new CodexAuthError(`ChatGPT ${operation}响应缺少 refresh_token`);
  }
  if (!Number.isFinite(json.expires_in) || json.expires_in <= 0) {
    throw new CodexAuthError(`ChatGPT ${operation}响应缺少有效的 expires_in`);
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    idToken: nonEmptyString(json.id_token) ? json.id_token : undefined,
  };
}

async function exchangeToken({ config, form, operation, fetchImpl, signal }) {
  const response = await requestWithTimeout(
    fetchImpl,
    config.tokenUrl,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: form,
      ...(signal ? { signal } : {}),
    },
    TOKEN_REQUEST_TIMEOUT_MS,
  );
  return readTokenResponse(response, operation);
}

async function exchangeAuthorizationCode({ config, code, verifier, redirectUri, fetchImpl }) {
  return exchangeToken({
    config,
    operation: "token 交换",
    fetchImpl,
    form: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  });
}

function respondHtml(response, status, message) {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(
    `<!doctype html><meta charset="utf-8"><title>Codex 订阅</title>` +
      `<body style="font-family:system-ui;padding:3rem;line-height:1.6">${message}</body>`,
  );
}

async function startCallbackListener({ port, path, expectedState, timeoutMs }) {
  let resolveCode;
  let rejectCode;
  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  let settled = false;
  const server = createServer((request, response) => {
    let url;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    if (url.pathname !== path) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    const error = url.searchParams.get("error");
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (error) {
      respondHtml(response, 400, `登录失败：${error}`);
      if (!settled) {
        settled = true;
        rejectCode(new CodexAuthError(`ChatGPT 登录被拒绝: ${error}`));
      }
      return;
    }
    if (state !== expectedState) {
      respondHtml(response, 400, "OAuth state 校验失败，请回到终端重新登录。");
      if (!settled) {
        settled = true;
        rejectCode(new CodexAuthError("OAuth state 不匹配，请重新登录"));
      }
      return;
    }
    if (!code) {
      respondHtml(response, 400, "回调缺少 authorization code。");
      return;
    }
    respondHtml(response, 200, "登录完成，可以关闭此页面并回到 ZCode。");
    if (!settled) {
      settled = true;
      resolveCode({ code });
    }
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectCode(new CodexAuthError("ChatGPT 登录超时，请重新运行 login"));
  }, timeoutMs);
  timer.unref?.();

  return {
    codePromise,
    close() {
      clearTimeout(timer);
      server.close();
    },
  };
}

function defaultOpenBrowser(url) {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // 无法拉起浏览器不是失败路径：终端已经打印授权 URL，可手动打开。
  }
}

async function defaultPrompt(message) {
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await readline.question(`${message}\n> `);
  } finally {
    readline.close();
  }
}

async function requestDeviceUserCode({ config, fetchImpl }) {
  const response = await requestWithTimeout(
    fetchImpl,
    config.deviceUserCodeUrl,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id: config.clientId }),
    },
    TOKEN_REQUEST_TIMEOUT_MS,
  );
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    throw new CodexAuthError(
      `ChatGPT 设备码申请失败 (HTTP ${response.status}): ${truncate(text) || response.statusText}`,
    );
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CodexAuthError("ChatGPT 设备码响应不是有效 JSON");
  }
  if (
    !isRecord(json) ||
    !nonEmptyString(json.device_auth_id) ||
    !nonEmptyString(json.user_code) ||
    !Number.isFinite(json.interval) ||
    json.interval < 0
  ) {
    throw new CodexAuthError("ChatGPT 设备码响应缺少 device_auth_id/user_code/interval");
  }
  return {
    deviceAuthId: json.device_auth_id,
    userCode: json.user_code,
    intervalSeconds: json.interval,
  };
}

function devicePollFailureCode(json) {
  const error = json?.error;
  if (isRecord(error)) return error.code;
  return typeof error === "string" ? error : undefined;
}

async function pollDeviceAuthorization({ config, device, fetchImpl, now, sleepImpl }) {
  const deadline = now() + DEVICE_CODE_TIMEOUT_MS;
  let delayMs = Math.max(device.intervalSeconds, 1) * 1000;
  while (now() < deadline) {
    await sleepImpl(delayMs);
    const response = await requestWithTimeout(
      fetchImpl,
      config.deviceTokenUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          device_auth_id: device.deviceAuthId,
          user_code: device.userCode,
        }),
      },
      TOKEN_REQUEST_TIMEOUT_MS,
    );
    if (response.ok) {
      const json = await response.json().catch(() => undefined);
      if (!nonEmptyString(json?.authorization_code) || !nonEmptyString(json?.code_verifier)) {
        throw new CodexAuthError("ChatGPT 设备码登录响应缺少 authorization_code/code_verifier");
      }
      return { code: json.authorization_code, verifier: json.code_verifier };
    }
    if (response.status === 403 || response.status === 404) continue;
    const text = await response.text().catch(() => "");
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const code = devicePollFailureCode(json);
    if (code === "deviceauth_authorization_pending") continue;
    if (code === "slow_down") {
      delayMs += 5000;
      continue;
    }
    throw new CodexAuthError(
      `ChatGPT 设备码登录失败 (HTTP ${response.status}): ${truncate(text) || response.statusText}`,
    );
  }
  throw new CodexAuthError("ChatGPT 设备码登录超时，请重新运行 login --device-code");
}

function modelHeaders(credentials) {
  return {
    authorization: `Bearer ${credentials.access}`,
    "chatgpt-account-id": credentials.accountId,
    accept: "application/json",
    originator: "zcode",
    "user-agent": `${PACKAGE_NAME}/${VERSION}`,
  };
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function uniqueStrings(values) {
  return [...new Set(values)];
}

/**
 * Codex 模型目录是账号实际权益的权威来源；只保留 visibility=list 且 supported_in_api 的模型。
 */
/** Responses API 接受的 reasoning.effort；Codex 目录的 ultra 是执行预设，不是合法档位。 */
const NATIVE_CODEX_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export function normalizeModelCatalog(raw) {
  const list = Array.isArray(raw?.models) ? raw.models : [];
  const seen = new Set();
  const models = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const id = nonEmptyString(item.slug) ? item.slug.trim() : "";
    if (!id || seen.has(id)) continue;
    if (item.visibility !== "list") continue;
    if (item.supported_in_api === false) continue;
    const advertisedEfforts = Array.isArray(item.supported_reasoning_levels)
      ? item.supported_reasoning_levels.flatMap((level) => {
          const effort = isRecord(level) ? level.effort : level;
          return nonEmptyString(effort) ? [effort.trim()] : [];
        })
      : [];
    // 只保留 API 合法档位；目录只给 ultra 时退到 max，避免写出上游必然拒绝的模型配置。
    const efforts = NATIVE_CODEX_EFFORTS.filter((effort) => advertisedEfforts.includes(effort));
    if (efforts.length === 0 && advertisedEfforts.includes("ultra")) efforts.push("max");
    const inputs = Array.isArray(item.input_modalities)
      ? item.input_modalities.filter((value) => typeof value === "string")
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
      priority: Number.isFinite(item.priority) ? item.priority : 0,
    });
    seen.add(id);
  }
  return models.sort(
    (left, right) =>
      left.priority - right.priority || left.id.localeCompare(right.id, "en", { numeric: true }),
  );
}

function credentialsFromState(state) {
  return Object.freeze({
    access: state.access,
    accountId: state.accountId,
    expires: state.expires,
    email: state.email,
  });
}

/**
 * 登录、刷新与模型目录都集中在这里；网络和时钟可注入，测试不碰真实账号。
 */
export function createAuthManager({
  config,
  store,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  logger = createLogger(),
  openBrowser = defaultOpenBrowser,
  prompt = defaultPrompt,
  sleepImpl = sleep,
}) {
  let refreshInFlight = null;

  async function saveLogin(tokens, accountId) {
    const next = createAuthState({
      access: tokens.access,
      refresh: tokens.refresh,
      expires: tokens.expires,
      accountId,
      email: extractEmail(tokens.idToken),
    });
    return store.write(next);
  }

  async function refresh(state) {
    const tokens = await exchangeToken({
      config,
      operation: "token 刷新",
      fetchImpl,
      form: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: state.refresh,
        client_id: config.clientId,
      }),
    });
    const accountId = extractAccountId(tokens.access);
    const next = createAuthState({
      access: tokens.access,
      refresh: tokens.refresh || state.refresh,
      expires: tokens.expires,
      accountId,
      email: state.email ?? extractEmail(tokens.idToken),
      models: state.models,
    });
    const saved = await store.update((current) => {
      if (!current) return undefined;
      // 另一进程已经完成新登录：不要把旧刷新轮换出的 token 覆盖到新账号上。
      if (current.access !== state.access && current.expires - REFRESH_SKEW_MS > now()) {
        return undefined;
      }
      return next;
    });
    if (!saved) throw new CodexLoginRequiredError("登录已在其它进程退出，请重新登录");
    return saved;
  }

  async function getCredentials({ forceRefresh = false } = {}) {
    const state = await store.read();
    if (!state) throw new CodexLoginRequiredError();
    if (!forceRefresh && state.expires - REFRESH_SKEW_MS > now()) {
      return credentialsFromState(state);
    }
    if (!refreshInFlight) {
      refreshInFlight = refresh(state).finally(() => {
        refreshInFlight = null;
      });
    }
    return credentialsFromState(await refreshInFlight);
  }

  async function fetchModels({ force = false, maxAgeMs = MODEL_CACHE_MAX_AGE_MS } = {}) {
    const state = await store.read();
    if (!state) throw new CodexLoginRequiredError();
    if (
      !force &&
      Number.isFinite(state.models?.fetchedAt) &&
      now() - state.models.fetchedAt < maxAgeMs &&
      Array.isArray(state.models.models)
    ) {
      return state.models.models;
    }
    const credentials = await getCredentials();
    const url = new URL(config.modelsUrl);
    url.searchParams.set("client_version", config.modelsClientVersion);
    const response = await requestWithTimeout(
      fetchImpl,
      url,
      { headers: modelHeaders(credentials) },
      MODELS_REQUEST_TIMEOUT_MS,
    );
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new CodexAuthError(
        `读取 Codex 模型目录失败 (HTTP ${response.status}): ${truncate(text) || response.statusText}`,
      );
    }
    const raw = await response.json().catch(() => undefined);
    if (!isRecord(raw) || !Array.isArray(raw.models)) {
      throw new CodexAuthError("Codex 模型目录响应缺少 models 数组");
    }
    const models = normalizeModelCatalog(raw);
    await store.update((current) =>
      current ? { ...current, models: { fetchedAt: now(), models } } : undefined,
    );
    return models;
  }

  async function loginBrowser({ originator = "codex_cli_rs", manual = false } = {}) {
    const state = randomBytes(16).toString("hex");
    const { verifier, challenge } = createPkcePair();
    const url = createAuthorizationUrl({ config, state, challenge, originator });
    process.stderr.write(`\n请在浏览器完成 ChatGPT 登录：\n${url}\n\n`);
    let listener;
    if (!manual) {
      const redirect = new URL(config.redirectUri);
      try {
        listener = await startCallbackListener({
          port: Number(redirect.port || (redirect.protocol === "https:" ? 443 : 80)),
          path: redirect.pathname,
          expectedState: state,
          timeoutMs: LOGIN_TIMEOUT_MS,
        });
      } catch (error) {
        logger.warn("本地 OAuth 回调端口不可用，改用粘贴授权码", {
          error: formatError(error),
        });
      }
    }
    try {
      openBrowser(url);
      let code;
      if (listener) {
        logger.info("等待浏览器回调…");
        ({ code } = await listener.codePromise);
      } else {
        const input = await prompt(
          "完成登录后，把浏览器地址栏的完整跳转 URL（或其中的 code）粘贴到这里：",
        );
        const parsed = parseAuthorizationInput(input);
        if (parsed.state && parsed.state !== state) {
          throw new CodexAuthError("OAuth state 不匹配，请重新登录");
        }
        code = parsed.code;
      }
      if (!code) throw new CodexAuthError("缺少授权码，请重新登录");
      const tokens = await exchangeAuthorizationCode({
        config,
        code,
        verifier,
        redirectUri: config.redirectUri,
        fetchImpl,
      });
      const saved = await saveLogin(tokens, extractAccountId(tokens.access));
      logger.info("ChatGPT 登录成功", { accountId: saved.accountId, email: saved.email });
      return saved;
    } finally {
      listener?.close();
    }
  }

  async function loginDeviceCode() {
    const device = await requestDeviceUserCode({ config, fetchImpl });
    process.stderr.write(
      `\n请在浏览器打开 ${config.deviceVerificationUri} 并输入代码：${device.userCode}\n\n`,
    );
    const authorization = await pollDeviceAuthorization({
      config,
      device,
      fetchImpl,
      now,
      sleepImpl,
    });
    const tokens = await exchangeAuthorizationCode({
      config,
      code: authorization.code,
      verifier: authorization.verifier,
      redirectUri: config.deviceRedirectUri,
      fetchImpl,
    });
    const saved = await saveLogin(tokens, extractAccountId(tokens.access));
    logger.info("ChatGPT 登录成功", { accountId: saved.accountId, email: saved.email });
    return saved;
  }

  async function logout() {
    await store.clear();
  }

  async function getStatus() {
    const state = await store.read();
    if (!state) return { loggedIn: false };
    return {
      loggedIn: true,
      accountId: state.accountId,
      email: state.email,
      expiresAt: state.expires,
      expired: state.expires - REFRESH_SKEW_MS <= now(),
      modelCache: Array.isArray(state.models?.models)
        ? { fetchedAt: state.models.fetchedAt, count: state.models.models.length }
        : undefined,
    };
  }

  return Object.freeze({
    getCredentials,
    fetchModels,
    getStatus,
    loginBrowser,
    loginDeviceCode,
    logout,
    store,
  });
}
