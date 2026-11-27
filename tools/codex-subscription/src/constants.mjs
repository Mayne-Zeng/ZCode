import { homedir } from "node:os";
import { join } from "node:path";

export const PACKAGE_NAME = "zcode-codex-subscription";
export const VERSION = "0.1.0";
export const PROVIDER_ID = "codex-subscription";
export const PROVIDER_NAME = "Codex 订阅";
export const DEFAULT_PORT = 17870;
export const DEFAULT_HOST = "127.0.0.1";

// 与 Codex CLI 相同的公开 OAuth 客户端；第三方客户端只能复用这一份。
export const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const DEFAULT_AUTH_BASE_URL = "https://auth.openai.com";
export const DEFAULT_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const DEFAULT_SCOPE = "openid profile email offline_access";
export const JWT_CLAIM_PATH = "https://api.openai.com/auth";
export const DEFAULT_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
export const DEFAULT_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
// dsh-codex-subscription 用自身包版本查询目录且可正常返回；目录服务并不校验 Codex CLI 版本。
export const DEFAULT_MODELS_CLIENT_VERSION = "3.2.33";

export const REFRESH_SKEW_MS = 120_000;
export const MODEL_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
export const DEVICE_CODE_TIMEOUT_MS = 15 * 60 * 1000;
export const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

export function defaultAuthFile() {
  return join(homedir(), ".zcode", "v2", "codex-subscription", "auth.json");
}

export function defaultProviderConfigFile(env = process.env) {
  return env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim()
    ? env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE.trim()
    : join(homedir(), ".zcode", "v2", "provider_config.json");
}

function trimmed(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value) {
  const parsed = typeof value === "string" ? Number(value) : value;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * 全部可变端点都从环境读取一次，测试可注入本地 mock，运行期不在请求路径重复读环境。
 */
export function resolveRuntimeConfig(env = process.env) {
  const authBaseUrl = (trimmed(env.CODEX_SUB_AUTH_BASE_URL) || DEFAULT_AUTH_BASE_URL).replace(
    /\/+$/u,
    "",
  );
  return Object.freeze({
    clientId: trimmed(env.CODEX_SUB_CLIENT_ID) || DEFAULT_CLIENT_ID,
    authBaseUrl,
    authorizeUrl: `${authBaseUrl}/oauth/authorize`,
    tokenUrl: `${authBaseUrl}/oauth/token`,
    deviceUserCodeUrl: `${authBaseUrl}/api/accounts/deviceauth/usercode`,
    deviceTokenUrl: `${authBaseUrl}/api/accounts/deviceauth/token`,
    deviceVerificationUri: `${authBaseUrl}/codex/device`,
    deviceRedirectUri: `${authBaseUrl}/deviceauth/callback`,
    redirectUri: trimmed(env.CODEX_SUB_REDIRECT_URI) || DEFAULT_REDIRECT_URI,
    scope: DEFAULT_SCOPE,
    responsesUrl: trimmed(env.CODEX_SUB_RESPONSES_URL) || DEFAULT_RESPONSES_URL,
    modelsUrl: trimmed(env.CODEX_SUB_MODELS_URL) || DEFAULT_MODELS_URL,
    modelsClientVersion: trimmed(env.CODEX_SUB_CLIENT_VERSION) || DEFAULT_MODELS_CLIENT_VERSION,
    authFile: trimmed(env.CODEX_SUB_AUTH_FILE) || defaultAuthFile(env),
    providerConfigFile:
      trimmed(env.CODEX_SUB_PROVIDER_CONFIG_FILE) || defaultProviderConfigFile(env),
    host: trimmed(env.CODEX_SUB_HOST) || DEFAULT_HOST,
    port: positiveInteger(env.CODEX_SUB_PORT) || DEFAULT_PORT,
  });
}
