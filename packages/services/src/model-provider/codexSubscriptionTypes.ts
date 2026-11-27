/**
 * Codex 订阅的跨进程公共类型。此文件必须保持 browser-safe：Renderer 只消费状态与模型描述，
 * 不导入 Host 的 OAuth/凭据实现（见 codexSubscriptionService.ts）。
 */
export type CodexSubscriptionLoginState = "signed-out" | "pending" | "signed-in" | "error";

const CODEX_RESPONSES_ORIGIN = "chatgpt.com";
const CODEX_RESPONSES_PATH = "/backend-api/codex";

/**
 * Host 只为固定 Codex 端点下发 token。个人 Provider 改 baseUrl 后不能再复用订阅凭据，
 * 这是凭据边界而不是可配置策略。
 */
export function isAllowedCodexBaseUrl(baseUrl: string | null | undefined): boolean {
  if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) return false;
  try {
    const url = new URL(baseUrl.trim());
    // url.host 含端口：chatgpt.com:8443 也必须拒绝；query/hash/userinfo 会让 CLI
    // 拼出的 /responses 路径失真，同样不属于固定端点。
    if (
      url.protocol !== "https:" ||
      url.host !== CODEX_RESPONSES_ORIGIN ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return false;
    }
    return url.pathname.replace(/\/+$/u, "") === CODEX_RESPONSES_PATH;
  } catch {
    return false;
  }
}

export interface CodexSubscriptionStatus {
  readonly supported: boolean;
  readonly state: CodexSubscriptionLoginState;
  readonly email?: string;
  readonly accountId?: string;
  readonly expiresAt?: number;
  readonly errorMessage?: string;
}

export interface CodexSubscriptionModel {
  readonly id: string;
  readonly name: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly reasoningEfforts: readonly string[];
  readonly supportsImage: boolean;
  readonly supportsPdf: boolean;
}

export interface CodexSubscriptionRequestAuth {
  readonly apiKey: string;
  readonly headers: Record<string, string>;
}

export class CodexSubscriptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexSubscriptionError";
  }
}

export class CodexSubscriptionLoginRequiredError extends CodexSubscriptionError {
  constructor(message = "ChatGPT 未登录，请在设置中登录 Codex 订阅") {
    super(message);
    this.name = "CodexSubscriptionLoginRequiredError";
  }
}
