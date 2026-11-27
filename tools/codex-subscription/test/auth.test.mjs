import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import {
  CodexLoginRequiredError,
  createAuthManager,
  createAuthorizationUrl,
  decodeJwt,
  extractAccountId,
  normalizeModelCatalog,
  parseAuthorizationInput,
} from "../src/auth.mjs";
import { createAuthState, createAuthStore } from "../src/auth-store.mjs";
import { accessToken, createTempDir, fakeJwt, jsonResponse, silentLogger } from "./helpers.mjs";

const AUTH_CONFIG = {
  clientId: "client_test",
  tokenUrl: "https://auth.example.test/oauth/token",
  modelsUrl: "https://codex.example.test/models",
  modelsClientVersion: "9.9.9",
};

function createTestStore(directory) {
  return createAuthStore({ filePath: join(directory, "auth.json") });
}

function createManager({ store, fetchImpl, now }) {
  return createAuthManager({
    config: AUTH_CONFIG,
    store,
    fetchImpl,
    now,
    logger: silentLogger(),
  });
}

function tokenResponse({ access, refresh = "refresh-2", idToken } = {}) {
  return jsonResponse({
    access_token: access ?? accessToken(),
    refresh_token: refresh,
    expires_in: 3600,
    ...(idToken ? { id_token: idToken } : {}),
  });
}

test("decodeJwt 和 extractAccountId 读取 ChatGPT claim", () => {
  const token = accessToken({ accountId: "acct_123" });
  assert.equal(decodeJwt(token)["https://api.openai.com/auth"].chatgpt_account_id, "acct_123");
  assert.equal(extractAccountId(token), "acct_123");
  assert.throws(() => extractAccountId(fakeJwt({}), /account id/u));
});

test("createAuthorizationUrl 带 PKCE 与 Codex 客户端参数", () => {
  const url = new URL(
    createAuthorizationUrl({
      config: { authorizeUrl: "https://auth.example.test/oauth/authorize" },
      state: "state-1",
      challenge: "challenge-1",
      originator: "codex_cli_rs",
    }),
  );
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "state-1");
  assert.equal(url.searchParams.get("codex_cli_simplified_flow"), "true");
  assert.equal(url.searchParams.get("id_token_add_organizations"), "true");
  assert.equal(url.searchParams.get("originator"), "codex_cli_rs");
});

test("parseAuthorizationInput 支持完整 URL、query 片段和裸 code", () => {
  assert.deepEqual(
    parseAuthorizationInput("http://localhost:1455/auth/callback?code=abc&state=s1"),
    { code: "abc", state: "s1" },
  );
  assert.deepEqual(parseAuthorizationInput("code=abc&state=s1"), { code: "abc", state: "s1" });
  assert.deepEqual(parseAuthorizationInput("abc"), { code: "abc" });
});

test("normalizeModelCatalog 只保留 list 可见模型并映射能力", () => {
  const models = normalizeModelCatalog({
    models: [
      {
        slug: "gpt-6-astra",
        display_name: "GPT-6 Astra",
        visibility: "list",
        context_window: 272000,
        max_output_tokens: 128000,
        input_modalities: ["text", "image"],
        supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
        priority: 2,
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
      { slug: "hidden-model", visibility: "hide" },
      { slug: "api-disabled", visibility: "list", supported_in_api: false },
      {
        slug: "gpt-reserve",
        visibility: "list",
        supported_reasoning_levels: ["low", "medium"],
      },
    ],
  });
  assert.deepEqual(
    models.map((model) => model.id),
    ["gpt-6.2-sol", "gpt-reserve", "ultra-only", "gpt-6-astra"],
  );
  const astra = models.find((model) => model.id === "gpt-6-astra");
  assert.equal(astra.name, "GPT-6 Astra");
  assert.equal(astra.contextWindow, 272000);
  assert.deepEqual(astra.reasoningEfforts, ["low", "high"]);
  assert.equal(astra.supportsImage, true);
  // ultra 不是 reasoning.effort；只保留合法档位，只有 ultra 时退到 max。
  assert.deepEqual(models.find((model) => model.id === "gpt-6.2-sol").reasoningEfforts, [
    "high",
    "max",
  ]);
  assert.deepEqual(models.find((model) => model.id === "ultra-only").reasoningEfforts, ["max"]);
});

test("未登录时 getCredentials 抛 CodexLoginRequiredError", async (t) => {
  const directory = await createTempDir(t);
  const auth = createManager({ store: createTestStore(directory) });
  await assert.rejects(() => auth.getCredentials(), CodexLoginRequiredError);
});

test("未过期 access token 不触发刷新", async (t) => {
  const directory = await createTempDir(t);
  const store = createTestStore(directory);
  const now = Date.now();
  const access = accessToken();
  await store.write(
    createAuthState({
      access,
      refresh: "refresh-1",
      expires: now + 3600_000,
      accountId: "acct_test",
    }),
  );
  let calls = 0;
  const auth = createManager({
    store,
    now: () => now,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("不应刷新");
    },
  });
  const credentials = await auth.getCredentials();
  assert.equal(credentials.access, access);
  assert.equal(calls, 0);
});

test("过期 access token 自动刷新并持久化轮换后的 refresh token", async (t) => {
  const directory = await createTempDir(t);
  const store = createTestStore(directory);
  const now = Date.now();
  const oldAccess = accessToken({ accountId: "acct_old" });
  await store.write(
    createAuthState({
      access: oldAccess,
      refresh: "refresh-old",
      expires: now - 1000,
      accountId: "acct_old",
    }),
  );
  const requests = [];
  const newAccess = accessToken({ accountId: "acct_new" });
  const auth = createManager({
    store,
    now: () => now,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return tokenResponse({
        access: newAccess,
        refresh: "refresh-new",
        idToken: fakeJwt({ email: "user@example.test" }),
      });
    },
  });
  const credentials = await auth.getCredentials();
  assert.equal(credentials.access, newAccess);
  assert.equal(credentials.accountId, "acct_new");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, AUTH_CONFIG.tokenUrl);
  assert.equal(requests[0].init.method, "POST");
  assert.match(String(requests[0].init.body), /grant_type=refresh_token/u);
  const saved = await store.read();
  assert.equal(saved.access, newAccess);
  assert.equal(saved.refresh, "refresh-new");
  assert.equal(saved.email, "user@example.test");
});

test("fetchModels 使用账号头并缓存结果", async (t) => {
  const directory = await createTempDir(t);
  const store = createTestStore(directory);
  const now = Date.now();
  const access = accessToken({ accountId: "acct_models" });
  await store.write(
    createAuthState({
      access,
      refresh: "refresh-1",
      expires: now + 3600_000,
      accountId: "acct_models",
    }),
  );
  const requests = [];
  const auth = createManager({
    store,
    now: () => now,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), headers: init.headers });
      return jsonResponse({
        models: [
          {
            slug: "gpt-6-astra",
            display_name: "GPT-6 Astra",
            visibility: "list",
            context_window: 272000,
            supported_reasoning_levels: [{ effort: "high" }],
          },
        ],
      });
    },
  });
  const first = await auth.fetchModels();
  assert.equal(first.length, 1);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /client_version=9\.9\.9/u);
  assert.equal(requests[0].headers.authorization, `Bearer ${access}`);
  assert.equal(requests[0].headers["chatgpt-account-id"], "acct_models");
  const second = await auth.fetchModels();
  assert.deepEqual(second, first);
  assert.equal(requests.length, 1, "缓存命中不应再次请求目录");
});
