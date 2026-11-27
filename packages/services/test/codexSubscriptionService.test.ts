import { describe, expect, it, vi } from "vitest";
import {
  createCodexSubscriptionService,
  decodeCodexAccountId,
  isAllowedCodexBaseUrl,
  normalizeCodexModels,
} from "../src/model-provider/codexSubscriptionService.js";
import {
  CodexSubscriptionLoginRequiredError,
  type CodexSubscriptionModel,
} from "../src/model-provider/codexSubscriptionTypes.js";

const CREDENTIAL_KEY = "codex-subscription:auth";

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function accessToken(accountId = "acct_1"): string {
  return `${base64Url({ alg: "none" })}.${base64Url({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    email: "user@example.test",
  })}.signature`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

class MemoryCredentialService {
  readonly values = new Map<string, string>();

  async load(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async save(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function storedAuth(expires: number, access = accessToken()) {
  return JSON.stringify({
    access,
    refresh: "refresh-1",
    expires,
    accountId: "acct_1",
    email: "user@example.test",
    updatedAt: Date.now(),
  });
}

function tokenResponse(access = accessToken("acct_2")) {
  return new Response(
    JSON.stringify({
      access_token: access,
      refresh_token: "refresh-2",
      expires_in: 3600,
      id_token: `${base64Url({ alg: "none" })}.${base64Url({ email: "user@example.test" })}.sig`,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("Codex 订阅凭据边界", () => {
  it("只允许固定 ChatGPT Codex 端点", () => {
    expect(isAllowedCodexBaseUrl("https://chatgpt.com/backend-api/codex")).toBe(true);
    expect(isAllowedCodexBaseUrl("https://chatgpt.com/backend-api/codex/")).toBe(true);
    expect(isAllowedCodexBaseUrl("http://chatgpt.com/backend-api/codex")).toBe(false);
    expect(isAllowedCodexBaseUrl("https://evil.example/backend-api/codex")).toBe(false);
    expect(isAllowedCodexBaseUrl("https://chatgpt.com/backend-api")).toBe(false);
    // 端口/query/hash/userinfo 都会让 CLI 拼出的 /responses 目标失真。
    expect(isAllowedCodexBaseUrl("https://chatgpt.com:8443/backend-api/codex")).toBe(false);
    expect(isAllowedCodexBaseUrl("https://chatgpt.com/backend-api/codex?x=1")).toBe(false);
    expect(isAllowedCodexBaseUrl("https://chatgpt.com/backend-api/codex#x")).toBe(false);
    expect(isAllowedCodexBaseUrl("https://user:pass@chatgpt.com/backend-api/codex")).toBe(false);
    expect(isAllowedCodexBaseUrl(undefined)).toBe(false);
  });

  it("从未登录到 resolveRequestAuth 给出明确错误", async () => {
    const credentials = new MemoryCredentialService();
    const service = createCodexSubscriptionService({ credentialService: credentials });
    await expect(service.resolveRequestAuth()).rejects.toBeInstanceOf(
      CodexSubscriptionLoginRequiredError,
    );
    expect(await service.getStatus()).toMatchObject({ supported: true, state: "signed-out" });
  });

  it("access token 解析 account id", () => {
    expect(decodeCodexAccountId(accessToken("acct_42"))).toBe("acct_42");
    expect(() => decodeCodexAccountId("not-a-jwt")).toThrow(/JWT/u);
  });

  it("有效 token 直接返回 apiKey 与 Codex 头", async () => {
    const credentials = new MemoryCredentialService();
    const access = accessToken();
    await credentials.save(CREDENTIAL_KEY, storedAuth(Date.now() + 3600_000, access));
    const fetchImpl = vi.fn();
    const service = createCodexSubscriptionService({
      credentialService: credentials,
      fetchImpl,
    });
    await expect(service.resolveRequestAuth()).resolves.toEqual({
      apiKey: access,
      headers: {
        "chatgpt-account-id": "acct_1",
        "OpenAI-Beta": "responses=experimental",
        originator: "zcode",
      },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("过期 token 刷新后落盘并返回新 token", async () => {
    const credentials = new MemoryCredentialService();
    const now = Date.now();
    await credentials.save(CREDENTIAL_KEY, storedAuth(now - 1000));
    const fetchImpl = vi.fn(async () => tokenResponse(accessToken("acct_2")));
    const service = createCodexSubscriptionService({
      credentialService: credentials,
      fetchImpl,
      now: () => now,
    });
    const auth = await service.resolveRequestAuth();
    expect(auth.apiKey).toBe(accessToken("acct_2"));
    expect(auth.headers["chatgpt-account-id"]).toBe("acct_2");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://auth.openai.com/oauth/token");
    expect(String(init?.body)).toMatch(/grant_type=refresh_token/u);
    const saved = JSON.parse(credentials.values.get(CREDENTIAL_KEY)!);
    expect(saved.access).toBe(accessToken("acct_2"));
    expect(saved.refresh).toBe("refresh-2");
  });

  it("回调后 token 交换期间状态保持 pending，完成后 signed-in", async () => {
    const credentials = new MemoryCredentialService();
    const token = deferred<Response>();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/oauth/token")) return token.promise;
      throw new Error(`unexpected request: ${url}`);
    });
    const service = createCodexSubscriptionService({
      credentialService: credentials,
      fetchImpl,
      callbackPort: 14556,
    });
    try {
      const { authorizeUrl } = await service.startLogin();
      const state = new URL(authorizeUrl).searchParams.get("state");
      const response = await fetch(
        `http://127.0.0.1:14556/auth/callback?code=test-code&state=${state}`,
      );
      expect(response.status).toBe(200);
      // 回调已到、token 交换未完成：不能提前变成 signed-out，否则 UI 停止轮询。
      expect(await service.getStatus()).toMatchObject({ state: "pending" });
      token.resolve(tokenResponse(accessToken("acct_1")));
      await vi.waitFor(async () => {
        expect(await service.getStatus()).toMatchObject({
          state: "signed-in",
          accountId: "acct_1",
        });
      });
    } finally {
      await service.dispose();
    }
  });

  it("logout 不会被在途 refresh 复活", async () => {
    const credentials = new MemoryCredentialService();
    const now = Date.now();
    await credentials.save(CREDENTIAL_KEY, storedAuth(now - 1000));
    const token = deferred<Response>();
    const fetchImpl = vi.fn(async () => token.promise);
    const service = createCodexSubscriptionService({
      credentialService: credentials,
      fetchImpl,
      now: () => now,
    });
    const pendingAuth = service.resolveRequestAuth();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await service.logout();
    token.resolve(tokenResponse(accessToken("acct_2")));
    await expect(pendingAuth).rejects.toBeInstanceOf(CodexSubscriptionLoginRequiredError);
    expect(await service.getStatus()).toMatchObject({ state: "signed-out" });
    expect(credentials.values.has(CREDENTIAL_KEY)).toBe(false);
  });

  it("旧 refresh 不会覆盖在途完成的新登录", async () => {
    const credentials = new MemoryCredentialService();
    const now = Date.now();
    await credentials.save(CREDENTIAL_KEY, storedAuth(now - 1000, accessToken("acct_old")));
    const token = deferred<Response>();
    const fetchImpl = vi.fn(async () => token.promise);
    const service = createCodexSubscriptionService({
      credentialService: credentials,
      fetchImpl,
      now: () => now,
    });
    const pendingAuth = service.resolveRequestAuth();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const newAccess = accessToken("acct_new");
    await credentials.save(
      CREDENTIAL_KEY,
      JSON.stringify({
        access: newAccess,
        refresh: "refresh-new-login",
        expires: now + 3600_000,
        accountId: "acct_new",
        updatedAt: now,
      }),
    );
    token.resolve(tokenResponse(accessToken("acct_old-2")));
    const auth = await pendingAuth;
    expect(auth.apiKey).toBe(newAccess);
    expect(auth.headers["chatgpt-account-id"]).toBe("acct_new");
    const saved = JSON.parse(credentials.values.get(CREDENTIAL_KEY)!);
    expect(saved.access).toBe(newAccess);
    expect(saved.refresh).toBe("refresh-new-login");
  });

  it("refresh token 失效时明确要求重新登录", async () => {
    const credentials = new MemoryCredentialService();
    const now = Date.now();
    await credentials.save(CREDENTIAL_KEY, storedAuth(now - 1000));
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
    const service = createCodexSubscriptionService({
      credentialService: credentials,
      fetchImpl,
      now: () => now,
    });
    await expect(service.resolveRequestAuth()).rejects.toBeInstanceOf(
      CodexSubscriptionLoginRequiredError,
    );
  });

  it("models 401 时强制刷新并重试一次", async () => {
    const credentials = new MemoryCredentialService();
    const now = Date.now();
    await credentials.save(CREDENTIAL_KEY, storedAuth(now + 3600_000));
    let modelsCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/oauth/token")) return tokenResponse(accessToken("acct_2"));
      modelsCalls += 1;
      const headers = init?.headers as Record<string, string>;
      // 目录请求必须自己带 Bearer；Model 执行层才会把 requestAuth.apiKey 写成 Authorization。
      expect(headers.authorization).toBe(
        `Bearer ${modelsCalls === 1 ? accessToken() : accessToken("acct_2")}`,
      );
      expect(headers["chatgpt-account-id"]).toBe(modelsCalls === 1 ? "acct_1" : "acct_2");
      if (modelsCalls === 1) {
        return new Response(JSON.stringify({ error: { message: "expired" } }), { status: 401 });
      }
      return new Response(
        JSON.stringify({
          models: [
            {
              slug: "gpt-6-astra",
              display_name: "GPT-6 Astra",
              visibility: "list",
              context_window: 272000,
              max_output_tokens: 128000,
              supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
              input_modalities: ["text", "image"],
            },
            { slug: "hidden", visibility: "hide" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const service = createCodexSubscriptionService({
      credentialService: credentials,
      fetchImpl,
      now: () => now,
    });
    const models = await service.listModels();
    expect(models.map((model) => model.id)).toEqual(["gpt-6-astra"]);
    expect(modelsCalls).toBe(2);
  });

  it("normalizeCodexModels 过滤不可见模型并映射能力", () => {
    const models = normalizeCodexModels({
      models: [
        {
          slug: "gpt-6-astra",
          visibility: "list",
          display_name: "Astra",
          input_modalities: ["text", "image"],
        },
        {
          slug: "gpt-6.2-sol",
          visibility: "list",
          supported_reasoning_levels: [{ effort: "ultra" }, { effort: "max" }, { effort: "high" }],
        },
        {
          slug: "ultra-only",
          visibility: "list",
          supported_reasoning_levels: [{ effort: "ultra" }],
        },
        { slug: "hidden", visibility: "hide" },
        { slug: "disabled", visibility: "list", supported_in_api: false },
      ],
    });
    expect(models.map((model) => model.id)).toEqual(["gpt-6-astra", "gpt-6.2-sol", "ultra-only"]);
    const model: CodexSubscriptionModel = models[0]!;
    expect(model.reasoningEfforts).toEqual([]);
    expect(model.supportsImage).toBe(true);
    // ultra 不是 reasoning.effort；只保留 API 合法档位，只有 ultra 时退到 max。
    expect(models[1]!.reasoningEfforts).toEqual(["high", "max"]);
    expect(models[2]!.reasoningEfforts).toEqual(["max"]);
  });

  it("logout 删除凭据并回到未登录", async () => {
    const credentials = new MemoryCredentialService();
    await credentials.save(CREDENTIAL_KEY, storedAuth(Date.now() + 3600_000));
    const service = createCodexSubscriptionService({ credentialService: credentials });
    expect(await service.getStatus()).toMatchObject({ state: "signed-in" });
    await service.logout();
    expect(await service.getStatus()).toMatchObject({ state: "signed-out" });
    expect(credentials.values.has(CREDENTIAL_KEY)).toBe(false);
  });
});
