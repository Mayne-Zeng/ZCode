import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateResponsesSse,
  buildUpstreamHeaders,
  clientWantsStream,
  extractSessionId,
  normalizeRequestBody,
} from "../src/normalize.mjs";

test("normalizeRequestBody 固定无状态流式并补加密推理", () => {
  const body = normalizeRequestBody(
    {
      model: "gpt-6-astra",
      input: [{ role: "user", content: "hi" }],
      include: ["message.output_text.logprobs"],
      max_output_tokens: 8,
    },
    { sessionId: "session-1" },
  );
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.deepEqual(body.include, ["message.output_text.logprobs", "reasoning.encrypted_content"]);
  assert.equal(body.max_output_tokens, 16);
  assert.equal(body.prompt_cache_key, "session-1");
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.parallel_tool_calls, true);
});

test("normalizeRequestBody 把非法的 ultra 推理档位退到 max", () => {
  const body = normalizeRequestBody({
    model: "gpt-6.2-sol",
    reasoning: { effort: "ultra", summary: "auto" },
  });
  assert.deepEqual(body.reasoning, { effort: "max", summary: "auto" });
});

test("normalizeRequestBody 不覆盖客户端显式 tool_choice 和已有 prompt_cache_key", () => {
  const body = normalizeRequestBody({
    model: "gpt-6-astra",
    tool_choice: "required",
    parallel_tool_calls: false,
    prompt_cache_key: "client-key",
  });
  assert.equal(body.tool_choice, "required");
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.prompt_cache_key, "client-key");
});

test("buildUpstreamHeaders 只使用当前凭据构造 Codex 头", () => {
  const headers = buildUpstreamHeaders(
    { access: "token-1", accountId: "acct_1" },
    { sessionId: "session-1" },
  );
  assert.equal(headers.authorization, "Bearer token-1");
  assert.equal(headers["chatgpt-account-id"], "acct_1");
  assert.equal(headers["openai-beta"], "responses=experimental");
  assert.equal(headers.originator, "zcode");
  assert.equal(headers.accept, "text/event-stream");
  assert.equal(headers["session-id"], "session-1");
  assert.equal(headers["x-client-request-id"], "session-1");
});

test("extractSessionId 只接受安全字符并忽略非法值", () => {
  assert.equal(extractSessionId({ "session-id": "abc-123" }), "abc-123");
  assert.equal(extractSessionId({ "x-zcode-session-id": "abc_123" }), "abc_123");
  assert.equal(extractSessionId({ "session-id": "bad value" }), undefined);
  assert.equal(extractSessionId({}), undefined);
});

test("clientWantsStream 只认显式 stream=true", () => {
  assert.equal(clientWantsStream({ stream: true }), true);
  assert.equal(clientWantsStream({ stream: false }), false);
  assert.equal(clientWantsStream({}), false);
});

test("aggregateResponsesSse 从 response.completed 还原 JSON", () => {
  const text = [
    'data: {"type":"response.created","response":{"id":"resp_1"}}',
    "",
    'data: {"type":"response.output_text.delta","delta":"hi"}',
    "",
    'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"hi"}]}]}}',
    "",
  ].join("\n");
  const response = aggregateResponsesSse(text);
  assert.equal(response.id, "resp_1");
  assert.equal(response.output[0].content[0].text, "hi");
});

test("aggregateResponsesSse 在 failed/未完成时抛错", () => {
  assert.throws(
    () =>
      aggregateResponsesSse(
        'data: {"type":"response.failed","response":{"error":{"message":"quota exceeded"}}}',
      ),
    /quota exceeded/u,
  );
  assert.throws(() => aggregateResponsesSse("data: [DONE]"), /未返回 response.completed/u);
});
