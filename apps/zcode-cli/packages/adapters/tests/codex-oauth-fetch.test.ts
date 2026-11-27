import { describe, expect, it, vi } from "vitest";
import { createCodexOAuthFetch } from "../src/model/codex-oauth-fetch.js";

const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const SSE = [
  'data: {"type":"response.created","response":{"id":"resp_1"}}',
  "",
  'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"hi"}]}]}}',
  "",
].join("\n");

async function requestBody(init: RequestInit | undefined): Promise<Record<string, unknown>> {
  return JSON.parse(String(init?.body));
}

describe("createCodexOAuthFetch", () => {
  it("流式请求补 store/include 并透传 SSE", async () => {
    const inner = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = await requestBody(init);
      expect(body.store).toBe(false);
      expect(body.stream).toBe(true);
      expect(body.include).toContain("reasoning.encrypted_content");
      return new Response(SSE, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const wrapped = createCodexOAuthFetch(inner);
    const response = await wrapped(CODEX_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6-astra", stream: true, input: [] }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("response.completed");
  });

  it("非流式请求把上游 SSE 聚合为 JSON", async () => {
    const inner = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = await requestBody(init);
      expect(body.stream).toBe(true);
      return new Response(SSE, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const wrapped = createCodexOAuthFetch(inner);
    const response = await wrapped(CODEX_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6-astra", input: [] }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const payload = await response.json();
    expect(payload.id).toBe("resp_1");
    expect(payload.output[0].content[0].text).toBe("hi");
  });

  it("ultra 推理档位在发送前退到 API 支持的 max", async () => {
    const inner = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = await requestBody(init);
      expect(body.reasoning).toEqual({ effort: "max", summary: "auto" });
      return new Response(SSE, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const wrapped = createCodexOAuthFetch(inner);
    const response = await wrapped(CODEX_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-6.2-sol",
        stream: true,
        reasoning: { effort: "ultra", summary: "auto" },
        input: [],
      }),
    });
    expect(response.status).toBe(200);
  });

  it("上游错误保持状态码，不改写正文", async () => {
    const inner = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "quota" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
    );
    const wrapped = createCodexOAuthFetch(inner);
    const response = await wrapped(CODEX_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6-astra", stream: true, input: [] }),
    });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: { message: "quota" } });
  });

  it("其它 URL 原样透传", async () => {
    const inner = vi.fn(async () => new Response("ok", { status: 200 }));
    const wrapped = createCodexOAuthFetch(inner);
    const response = await wrapped("https://example.test/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true }),
    });
    expect(await response.text()).toBe("ok");
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
