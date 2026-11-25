# 工具栏输出速率（tok/s）

聊天输入框工具栏在上下文圆环左边显示主会话模型请求的输出 token 速率，与缓存命中率并排。
数据与缓存命中率走同一条通道：CLI core 运行时聚合，随 `ModelComplete` 发出，由 V4 snapshot 的
`usage.contextWindow` 承载。本文定义口径、归属与恢复边界；展示规则见
[chat-input-context.md](./ui/chat-input-context.md)，单次请求的速率公式以
[context-cache-hit-rate.md](./context-cache-hit-rate.md)「Output TPS」为唯一定义。

## 决策记录（2026-11-25）

| 决策       | 结论                                                                                | 来源                         |
| ---------- | ----------------------------------------------------------------------------------- | ---------------------------- |
| 展示位置   | 工具栏圆环左边，顺序「输出速率 → 缓存命中率 → 圆环」；不在悬浮卡片里显示            | 用户确认                     |
| 展示值     | 最近一次主轮请求的速率（`latestTokensPerSecond`），取整                             | 用户确认（要更接近当前速度） |
| 平均与计数 | 不直接展示，只出现在速率的悬停说明里                                                | 实现者默认                   |
| 流式阶段   | 保持上一次请求结束后的值，不做估算（与 2026-11-06 对 `composer.status` 的决定一致） | 实现者默认，用户未表态       |
| 归属       | core `AgentRuntime` 聚合；投影与 UI 只透传，不各自推导                              | 用户确认                     |

## 口径

单次请求的速率与开发者工具面板同一公式，共用 `calculateOutputTps`：

```text
outputTokens / ((durationMs - timeToFirstContentMs) / 1000)
```

- `outputTokens` 取 `model_request_completed` 自带的 provider usage，不叠加 reasoning tokens。
- 生成时长 = `durationMs - timeToFirstContentMs`，两者来自同一请求时钟。缺少 `timeToFirstContentMs`、
  出现非有限值或生成时长不为正时，该请求不参与统计；不得用 `durationMs` 或 UI 侧时间兜底。
- 平均按 token 加权：`totalOutputTokens / (totalGenerationMs / 1000)`，与缓存命中率的
  `sum(cacheReadTokens) / sum(inputTokens)` 同一种聚合方式。
- 计时有效但 output tokens 为 0 的请求按 0 tok/s 计入样本，与开发者工具面板「观察到零输出显示零」
  一致；`latestTokensPerSecond` 取最近一次有效样本。

载荷字段：

```ts
outputRate: {
  /** 最近一次有效样本的速率（tok/s）。 */
  latestTokensPerSecond: number;
  /** token 加权平均（tok/s）。 */
  averageTokensPerSecond: number;
  /** 参与平均的主轮请求数量。 */
  requestCount: number;
  totalOutputTokens: number;
  totalGenerationMs: number;
}
```

`averageTokensPerSecond` 必须能由三个计数器复算；工具栏的数值只读 `latestTokensPerSecond`。

## 归属与事件顺序

唯一所有者是 `AgentRuntime.mainTurnOutputRateAggregate`。`ModelComplete` 载荷里的 `outputRate`
是发出当时的聚合快照；投影和 UI 没有第二份聚合状态。

```text
adapter 流结束
  └─ publish(model_request_completed {requestId, durationMs, timeToFirstContentMs, usage})
       └─ core createModelStatusSink.publish
            ├─ onStatus → recordModelNetworkStatus（同步，先于请求返回）
            │    └─ 主轮步骤：recordMainTurnOutputRate 累加计数器
            └─ appendEvent（瞬态 ModelNetworkStatus，不参与恢复）
  └─ runModelTextRequest 返回
runtime 发出 ModelComplete {cacheHit, outputRate ← 聚合快照, usage, contextWindow}
  └─ V4 ProductProjection.onModelComplete → state.updated usage.contextWindow
       ├─ desktop continuous：收到 patch
       └─ mobile replayable：经 snapshot / 恢复拿到同一份
```

- 统计范围与 `cacheHit` 同源：只累加 `querySource === "main_turn"` 模型步骤收到的
  `model_request_completed`。标题、compact、子代理、工具内部调用等旁路请求不经过主轮模型步骤的
  状态回调，不进入聚合。输出续写等多物理请求的步骤，每个物理请求各计一次。
- 幂等：计数器只在 live `model_request_completed` 到达时更新。事件重放只恢复 `ModelComplete`
  携带的快照，不再次累加。
- 重试与断流恢复：失败或被丢弃的尝试只发 `model_request_failed` / `model_retry_scheduled`，没有
  completed 事件，因此每个被接受的物理请求最多计一次。

## 传输与版本偏差

- `ModelComplete.outputRate` 可选：只在主轮且运行实例已有有效样本时出现。
- V4 `usage.contextWindow.outputRate` 与 `cache` 平级。`contextWindow` 不是 strict 对象，旧 App
  解析时丢弃未知键，新 App 接受旧 CLI 的缺省。
- legacy `runtime.contextUsage` 与 `usage_update` 是 strict schema，且已不再供工具栏读取，不扩展。

## 恢复边界

- 速率不落盘。transcript 冷恢复合成的 `ModelComplete` 不带 `outputRate`：transcript 不持久化网络
  计时，不得伪造。冷恢复后工具栏不显示速率，直到当前运行实例第一次主轮请求完成。
- 运行实例重建（resume、rewind）后聚合从空开始，不从消息或历史事件重算。悬停说明里的平均值的范围是
  「当前运行实例内已完成的主轮请求」。
- 同一进程内按事件重放重建的投影得到相同的 `outputRate`。
- compact 成功会整体重建 `usage.contextWindow`，此时 `outputRate` 与 `cache` 一样暂不携带，下一次
  主轮 `ModelComplete` 恢复；运行实例的聚合不因 compact 清零。

## 验收

- 120 output tokens、首输出 2 秒、总耗时 5 秒，单次请求为 40 tok/s。
- 两次请求分别为 120 tok / 3 秒和 300 tok / 1 秒，平均是 105 tok/s（token 加权），不是 170。
- 缺少 `timeToFirstContentMs` 的请求不参与统计，不得退回 `durationMs`。
- 旁路请求与旧事件（无 `outputRate`）不产出该字段；冷恢复后的 `usage.contextWindow` 没有该键。
- 工具栏在字段存在时显示速率，不存在时不渲染；`stat` 档收起单位，隐藏阶段整体不显示。
