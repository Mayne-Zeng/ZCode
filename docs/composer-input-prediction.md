# 桌面端输入预测（composer ghost hint）

桌面端对话输入框在回合结束后显示一段灰色预测文本（ghost hint），Tab 或点击采纳后写入输入框。
复用手机远控输入预测的既有管线（[mobile-input-prediction.md](./web-remote-control/mobile-input-prediction.md)），
本文只定义桌面渲染层的消费方式；宿主侧（service / CLI / 开关）零改动。

## 决策记录（2026-11-24，用户确认）

| 决策     | 结论                                                                                   |
| -------- | -------------------------------------------------------------------------------------- |
| 触发范围 | 仅回合结束（输入框空 + 会话空闲）；不做打字续写、不做失焦预测（一期非目标）            |
| 展示形态 | 单条幽灵文本（`candidates[0]`），Tab / 点击采纳；不做候选 chips                        |
| 开关默认 | 默认开启；位置 设置 → Agent 能力 → 行为与工具；键 `composerInputPredictionEnabled`     |
| 展示门槛 | 桌面放宽：`suppress_below_threshold` 且 top 候选置信度 ≥ **0.5** 时也展示（D10，见下） |
| 清空恢复 | 输入后清空草稿 → 原地恢复最近展示的 hint（D11，纯内存不调模型；Esc/采纳后不恢复）      |
| 旧插件   | `session-end-suggestions` 插件（Stop 钩子 → 消息流）停用不卸载，留作回退               |

### D10（2026-11-24，实机调试发现）：展示门槛放宽

宿主 show 判定要求 topConfidence ≥ 0.8，而 sidecar 提示词要求模型「校准比乐观重要，拿不准就给低分」，
实测 top 置信度多在 0.2~0.7 → `suppress_below_threshold` 几乎必然，桌面永远无 hint
（model-io 证据：GLM-5.3-Flash 返回 0.6/0.3/0.2，全被 0.8 门槛拦下）。
用户决定：桌面渲染层接受 `suppress_below_threshold` 且 top 候选置信度 ≥ 0.5 的结果并展示 top1；
只影响桌面渲染层，手机端与宿主阈值（0.8）均不变。

### D11（2026-11-24，验证反馈）：清空草稿后恢复 hint

输入字符使 hint 消失后，把草稿删空应**原地恢复最近展示过的 hint**，且不重新调用模型
（用户决定）。实现：hook 内按会话内容缓存最近展示过的文本（见 D12），清空后命中同一键即恢复；
Esc 明确清除、采纳写入草稿两种情况不恢复；会话前进后使用新内容键，旧键仅在同一内容
再次出现（例如切回/回退）时命中。

### D12（2026-11-27，使用反馈）：按会话内容触发，重建 hint 缓存

实际使用时出现两类问题：

1. 切换会话后 hint 先出现一条、很快又变成另一条；
2. 切换/打开会话后预测偶发很慢，迟迟不出现。

日志证据（`~/.zcode/cli/log` 的 `input_prediction` 请求与桌面 renderer 的 store 生命周期）：
一次冷打开/恢复会话会连续发出 2–4 次预测请求，相邻请求间隔正好接近一次模型调用时长；
同时 renderer 记录到 `runtimeInitialization` 变化与 `staleAuthority` store recovery。
根因是旧实现的触发键是 `(sessionId, snapshot.revision)`，而 `revision` 不只随对话内容变化：
运行时初始化、store recovery 等非对话状态也会抬 revision；每次 revision 变化都会重新请求，
后一次响应替换前一次响应，形成“换一条”与重复模型调用。

修复后的口径：

- 触发键改为 **会话内容指纹**：`sessionId` + 最后一条 `realUser` 用户输入与当前轮助手回复的
  `entityId`（缺失时用 rowId）。`revision` 只作为请求参数与宿主缓存键，不再触发新请求。
- 同一内容指纹只请求一次；运行时初始化、store recovery 等导致的 revision 变化不重复请求，
  也不覆盖已展示的 hint。
- 进入会话后的实际渲染门槛：快照存在、`runtimeInitialization` 为 `ready`（旧快照无该字段视为
  ready）、会话空闲、草稿为空。未 ready 时不请求，避免初始化阶段用不完整状态预测。
- renderer 内维护有界（16 条）的 hint 缓存，键为 `sessionId + 内容指纹`：切回同一会话时
  先用缓存**立即展示**，不再发请求；缓存未命中才发一次请求。Esc/采纳删除当前键。
- 在途请求按 `(requestId, sessionId, 内容指纹)` 校验；会话或内容指纹变化、草稿变为非空、
  开始运行、开关关闭、卸载时立即失效，迟到回包不得写入新会话或新内容。
- renderer 等待上限从 25s 收紧到 8s：超过即丢弃，不再让 hint 在用户已经继续操作后迟到弹出。
  宿主侧 20s 上限与移动端语义保持不变；宿主仍可能把迟到结果写入缓存供后续命中。

## 链路

```text
渲染层 useComposerInputPrediction（packages/ui/src/v4/composer）
  → IZodeAgentService.conversationInputPredictionV4（packages/services，已存在）
      开关关闭 → unavailable（既有行为，桌面侧另有渲染层开关先行拦截）
  → CLI v4/conversation/inputPrediction → ConversationInputPredictionHandler
  → input-prediction-sidecar → app.generateWorkspaceText(querySource="input_prediction")
```

只读、无状态；一次预测在会话事件日志追加 ModelRequest/ModelComplete（与标题生成同级），
不进入对话转录。语义细节（线格式、decision、失败语义、缓存、降级）全部以
mobile-input-prediction.md 为准，本文不重复。

## 触发规则（渲染层）

- 触发键是 `(sessionId, 会话内容指纹)`，不是 `(sessionId, revision)`（D12）：
  - 内容指纹 = 最后一条 `origin === "realUser"` 的 userInput 行 + 该行之后最后一条
    assistantText 行的稳定身份（`entityId`，缺失时回退 rowId）；内容变化（新一轮、重试、
    edit/rewind）才产生新键。
  - `snapshot.revision` 只作为请求参数和宿主缓存键；运行时初始化、store recovery 等
    非对话状态的 revision 变化不触发新请求。
- 触发时机：
  - 会话变为空闲（`snapshot.control.canStop` 为 false）、草稿为空、内容指纹与上次请求不同；
  - 挂载/切回空闲会话且缓存未命中同一内容指纹；
  - 运行中（`canStop === true`）不发请求，已有 hint 立即清除。
- 实际渲染门槛：
  - 该 composer 是会话当前活跃 composer（SessionPane 挂载的那个）；
  - 开关 `composerInputPredictionEnabled` 开启；
  - 快照已应用、`snapshot.sessionId` 与当前 `sessionId` 一致（切换过渡帧不请求）；
  - 会话运行时已就绪：`snapshot.runtimeInitialization.status === "ready"`；旧快照没有该字段
    时视为 ready。`initializing`/`failed` 不请求。
  - 会话空闲、草稿为空、内容指纹非空。
- 切会话过渡帧防护：`snapshot.sessionId` 与当前 `sessionId` 不一致（快照尚未跟上）时不请求，
  等对齐后自然触发，避免拿旧 revision 给新会话发预测。
- 请求参数：`sessionId`、`revision = snapshot.revision`（发送时的快照水位，供宿主缓存与
  对齐）、`draft` 缺省（预测下一条完整输入）、`requestId` 渲染层自增字符串。
- 同一会话同时只保留一个在途请求；会话或内容指纹变化时本地立即失效旧请求。宿主仍按同会话
  替代语义中止旧请求，但渲染层不再因 revision 抖动主动制造替代。
- hint 缓存：键为 `sessionId + 内容指纹`，有界 16 条；命中即立即展示且不发请求。
  Esc 明确清除或采纳后删除当前键，后续清空草稿不恢复。

## 响应处理

- 展示条件（桌面放宽，见 D10）：`candidates[0]` 存在，且
  `decision === "show"`，或 `decision === "suppress_below_threshold"` 且 `candidates[0].confidence ≥ 0.5`；
  展示 `candidates[0].text`。
- `suppress_no_context` / `unavailable` / `cancelled`：清除 hint，不提示、不重试。
- 回包校验按 `(requestId, sessionId, 内容指纹)`：任一与最新请求不一致（迟到、被替代、
  会话已切换、内容已前进）则丢弃；即使新请求尚未发出，旧内容的回包也不得展示。
- 回包到达时如果草稿已非空、会话已开始运行或开关已关闭，只丢弃，不展示；运行时在
  initializing/ready 之间瞬时切换不清除在途请求，内容未变时结果仍有效。
- 渲染层等待上限为 8s（D12）；超时后失效本请求，后续迟到回包全部丢弃。任何异常视为无 hint：
  静默清除，不重试、不打断输入。

## UI

- 幽灵文本渲染在编辑器容器内与 placeholder 同位的绝对定位层（`left-0 top-0`）；
  hint 可见时隐藏 placeholder。
- 文案颜色用 subtle 前景色，单行截断（`truncate`），不拦截编辑器点击；
  末尾附 `Tab` 键帽提示，键帽区域可点击采纳。
- 采纳：`LexicalChatInputHandle.appendText(text)` 追加到当前草稿（含前导空格由管线保证：
  英文续写候选可以空格开头），随后清除 hint 并聚焦编辑器。
- 渲染期只展示与当前 `(sessionId, 内容指纹)` 一致、且当下可交互（开启、空闲、草稿为空）的
  hint；切会话/内容前进/开始运行/用户输入后的过渡帧直接不渲染旧 hint，避免闪现或压在正文上。
- 清除时机：用户输入任意内容、`Escape`、发送、开始新回合、切换会话、开关关闭、卸载。
- Tab 采纳：hint 可见时在编辑器容器上捕获 keydown——无修饰键且非 IME 组合中的 `Tab`
  被 `preventDefault` 后采纳；其余按键行为不变。

## 开关

| 项     | 值                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------ |
| 设置键 | `composerInputPredictionEnabled`（shared settings 完整 schema `default(true)`，patch schema optional） |
| 位置   | 设置 → Agent 能力 → 行为与工具，搜索索引同步登记                                                       |
| 缺省   | **开启**（2026-11-24 用户决定，与 Host 侧 2026-10-23「所有渠道默认打开」一致）                         |
| 生效   | 渲染层拦截：关闭时完全不发请求，已显示的 hint 清除                                                     |
| i18n   | `settings.composerInputPrediction` / `settings.composerInputPredictionDescription`，5 语言齐备         |

Host 侧 `ZCODE_REMOTE_INPUT_PREDICTION`（手机远控总开关）保持不变；两个开关独立：
Host 关闭时桌面请求会得到 `unavailable`（静默无 hint），桌面开关关闭时不发请求（零成本）。

## 成本

每次满足触发规则的请求 = 1 次辅助档位模型调用（会话当前模型，最低公开推理档，
宿主 20s 超时、渲染层 8s 等待上限）。同一会话内容指纹只发一次；切回已缓存内容不发请求。
置信度不足或上下文不足时调用照常发生、只是不展示；宿主缓存与降级策略见
mobile spec。开关描述中向用户说明该成本。

## 兼容性

- hello 能力位 `inputPrediction` 已由 Host 按开关计算（缺省 true），桌面渲染层不依赖该位
  （桌面与 Host 同进程部署），请求失败统一走 `unavailable` 静默路径。
- 远端会话（SSH 旧 CLI）：service 层回 `unavailable`，静默无 hint。
- 不改手机端行为；手机端仍只消费自己的 service 通道。

## 验证

- `pnpm typecheck`、`pnpm lint`（含 React hooks 专项复核）必须通过。
- 交互验收（手动）：回合结束出现灰字 → Tab 采纳写入草稿；输入即清除；关闭开关后新回合
  不再出现且不再发起请求（网络面板无 `inputPrediction` 流量）。
- 切换会话验收（D12）：冷打开/切回会话只出现一条 hint，且不再在同一会话内自行变成另一条；
  切回已展示过 hint 的会话应立即恢复同一条，不再发起模型调用；切换过渡帧中旧会话的迟到
  回包不得出现在新会话。
- E2E：归入既有 composer 交互用例族补一条「回合结束出现 ghost hint 并可采纳」；
  环境受限时如实说明未跑范围。
