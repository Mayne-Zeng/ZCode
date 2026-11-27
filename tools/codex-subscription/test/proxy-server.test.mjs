import assert from "node:assert/strict";
import { test } from "node:test";
import { createProxyServer } from "../src/proxy-server.mjs";
import { createCodexClient } from "../src/codex-client.mjs";
import { readJsonBody, silentLogger, startHttpServer } from "./helpers.mjs";

const COMPLETED_SSE = [
  'data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}',
  "",
  'data: {"type":"response.output_text.delta","delta":"hello"}',
  "",
  'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"hello"}]}],"usage":{"input_tokens":1,"output_tokens":1}}}',
  "",
  "",
].join("\n");

async function createProxy(t, upstreamHandler) {
  const upstream = await startHttpServer(upstreamHandler);
  t.after(() => upstream.close());
  const authCalls = [];
  let tokenCounter = 0;
  const auth = {
    async getCredentials({ forceRefresh = false } = {}) {
      authCalls.push({ forceRefresh });
      tokenCounter += 1;
      return {
        access: `token-${tokenCounter}`,
        accountId: "acct_proxy",
        expires: Date.now() + 3600_000,
      };
    },
    async fetchModels() {
      return [{ id: "gpt-6-astra" }, { id: "gpt-6-luna" }];
    },
    async getStatus() {
      return { loggedIn: true, expiresAt: Date.now() + 3600_000 };
    },
  };
  const client = createCodexClient({ responsesUrl: `${upstream.origin}/codex/responses` });
  const server = createProxyServer({ auth, client, logger: silentLogger() });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return { origin: `http://127.0.0.1:${address.port}`, authCalls, upstream };
}

test("流式请求透传 SSE，并补齐 Codex 头和请求体", async (t) => {
  const captured = [];
  const proxy = await createProxy(t, async (request, response) => {
    captured.push({ headers: request.headers, body: await readJsonBody(request) });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(COMPLETED_SSE);
  });
  const response = await fetch(`${proxy.origin}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", "session-id": "session-1" },
    body: JSON.stringify({
      model: "gpt-6-astra",
      stream: true,
      input: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/u);
  const text = await response.text();
  assert.match(text, /response\.completed/u);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].headers.authorization, "Bearer token-1");
  assert.equal(captured[0].headers["chatgpt-account-id"], "acct_proxy");
  assert.equal(captured[0].headers["openai-beta"], "responses=experimental");
  assert.equal(captured[0].body.store, false);
  assert.equal(captured[0].body.stream, true);
  assert.ok(captured[0].body.include.includes("reasoning.encrypted_content"));
  assert.equal(captured[0].body.prompt_cache_key, "session-1");
});

test("非流式请求把上游 SSE 聚合为 JSON", async (t) => {
  const captured = [];
  const proxy = await createProxy(t, async (request, response) => {
    captured.push({ body: await readJsonBody(request) });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(COMPLETED_SSE);
  });
  const response = await fetch(`${proxy.origin}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-6-astra", stream: false, input: [] }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.id, "resp_1");
  assert.equal(payload.output[0].content[0].text, "hello");
  assert.equal(captured[0].body.stream, true, "上游始终走 SSE");
});

test("上游 401 时强制刷新并重试一次", async (t) => {
  let calls = 0;
  const seenTokens = [];
  const proxy = await createProxy(t, async (request, response) => {
    calls += 1;
    seenTokens.push(request.headers.authorization);
    if (calls === 1) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "expired", type: "unauthorized" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(COMPLETED_SSE);
  });
  const response = await fetch(`${proxy.origin}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-6-astra", stream: true, input: [] }),
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.deepEqual(seenTokens, ["Bearer token-1", "Bearer token-2"]);
  assert.deepEqual(proxy.authCalls, [{ forceRefresh: false }, { forceRefresh: true }]);
});

test("上游错误保留状态码和 OpenAI 错误结构", async (t) => {
  const proxy = await createProxy(t, async (_request, response) => {
    response.writeHead(429, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: { message: "usage limit reached", type: "insufficient_quota", code: "quota" },
      }),
    );
  });
  const response = await fetch(`${proxy.origin}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-6-astra", stream: true, input: [] }),
  });
  assert.equal(response.status, 429);
  const payload = await response.json();
  assert.equal(payload.error.message, "usage limit reached");
  assert.equal(payload.error.type, "insufficient_quota");
});

test("models 和 healthz 可用", async (t) => {
  const proxy = await createProxy(t, async (_request, response) => {
    response.writeHead(500);
    response.end();
  });
  const models = await fetch(`${proxy.origin}/v1/models`);
  assert.equal(models.status, 200);
  const payload = await models.json();
  assert.deepEqual(
    payload.data.map((model) => model.id),
    ["gpt-6-astra", "gpt-6-luna"],
  );
  const health = await fetch(`${proxy.origin}/healthz`);
  assert.equal(health.status, 200);
  const status = await health.json();
  assert.equal(status.ok, true);
  assert.equal(status.provider, "openai-codex");
  assert.equal(status.loggedIn, true);
  assert.equal(typeof status.expiresAt, "number");
});

test("缺省路径返回 404", async (t) => {
  const proxy = await createProxy(t, async (_request, response) => {
    response.writeHead(500);
    response.end();
  });
  const response = await fetch(`${proxy.origin}/nope`);
  assert.equal(response.status, 404);
});
