import { describe, expect, it } from "vitest";
import type { ModelNetworkStatusEvent } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import {
  mainTurnOutputRateSnapshot,
  recordMainTurnOutputRate,
} from "../src/runtime/methods/turn-model-step-usage.js";

type CompletedEvent = Extract<ModelNetworkStatusEvent, { type: "model_request_completed" }>;

// 聚合函数只读写 runtime.mainTurnOutputRateAggregate，其余运行时状态不参与。
function createRuntime(): AgentRuntimeInternal {
  return {
    mainTurnOutputRateAggregate: {
      latestTokensPerSecond: 0,
      requestCount: 0,
      totalGenerationMs: 0,
      totalOutputTokens: 0,
    },
  } as unknown as AgentRuntimeInternal;
}

function completed(overrides: Partial<CompletedEvent>): CompletedEvent {
  return {
    attempt: 1,
    durationMs: 5_000,
    maxAttempts: 1,
    modelId: "test-model" as CompletedEvent["modelId"],
    providerId: "test-provider" as CompletedEvent["providerId"],
    requestId: "request-1",
    timeToFirstContentMs: 2_000,
    timestamp: "2026-11-25T00:00:00.000Z",
    traceId: "trace-1" as CompletedEvent["traceId"],
    transport: "sse",
    type: "model_request_completed",
    usage: { outputTokens: 120 },
    ...overrides,
  };
}

describe("main turn output rate aggregate (docs/context-output-rate.md)", () => {
  it("尚无有效样本时不产出快照", () => {
    expect(mainTurnOutputRateSnapshot(createRuntime())).toBeUndefined();
  });

  it("120 output tokens、首输出 2s、总耗时 5s 得到 40 tok/s", () => {
    const runtime = createRuntime();
    expect(recordMainTurnOutputRate(runtime, completed({}))).toBe(40);
    expect(mainTurnOutputRateSnapshot(runtime)).toEqual({
      averageTokensPerSecond: 40,
      latestTokensPerSecond: 40,
      requestCount: 1,
      totalGenerationMs: 3_000,
      totalOutputTokens: 120,
    });
  });

  it("平均值按 token 加权，不是各次速率的算术平均", () => {
    const runtime = createRuntime();
    recordMainTurnOutputRate(runtime, completed({}));
    // 300 tok / 1s 生成 → 300 tok/s；加权平均 420 tok / 4s = 105，而不是 (40 + 300) / 2 = 170。
    recordMainTurnOutputRate(
      runtime,
      completed({
        durationMs: 4_000,
        requestId: "request-2",
        timeToFirstContentMs: 3_000,
        usage: { outputTokens: 300 },
      }),
    );
    expect(mainTurnOutputRateSnapshot(runtime)).toEqual({
      averageTokensPerSecond: 105,
      latestTokensPerSecond: 300,
      requestCount: 2,
      totalGenerationMs: 4_000,
      totalOutputTokens: 420,
    });
  });

  it("缺少首输出计时的请求不参与，不退回请求总耗时", () => {
    const runtime = createRuntime();
    const { timeToFirstContentMs: _omitted, ...withoutTiming } = completed({});
    expect(recordMainTurnOutputRate(runtime, withoutTiming)).toBeNull();
    expect(mainTurnOutputRateSnapshot(runtime)).toBeUndefined();
  });

  it("生成时长不为正或 output tokens 非法的请求不参与", () => {
    const runtime = createRuntime();
    expect(recordMainTurnOutputRate(runtime, completed({ durationMs: 2_000 }))).toBeNull();
    expect(recordMainTurnOutputRate(runtime, completed({ usage: undefined }))).toBeNull();
    expect(
      recordMainTurnOutputRate(runtime, completed({ usage: { outputTokens: -1 } })),
    ).toBeNull();
    expect(recordMainTurnOutputRate(runtime, completed({ durationMs: Number.NaN }))).toBeNull();
    expect(mainTurnOutputRateSnapshot(runtime)).toBeUndefined();
  });

  it("计时时零输出按 0 tok/s 计入样本", () => {
    const runtime = createRuntime();
    expect(recordMainTurnOutputRate(runtime, completed({ usage: { outputTokens: 0 } }))).toBe(0);
    expect(mainTurnOutputRateSnapshot(runtime)).toMatchObject({
      averageTokensPerSecond: 0,
      requestCount: 1,
      totalOutputTokens: 0,
    });
  });
});
