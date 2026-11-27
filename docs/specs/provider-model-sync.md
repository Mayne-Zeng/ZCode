# 自定义供应商模型同步

状态：v1 已实现
日期：2026-11-27

## 1. 背景

自定义供应商（`access.type` 为 `api-key` / `zhipu-coding-plan-api-key`）的模型列表目前只能手动
逐个「添加模型」。大多数 OpenAI-compatible 网关提供 `GET {baseUrl}/models`，可以一次返回该
API Key 可见的模型目录；手动填写模型 ID、上下文窗口等参数既慢又容易拼错。

本功能在模型列表标题行新增「同步模型」：Host 使用已保存的 Base URL、API 格式与 API Key 拉取
模型目录，用户在弹窗中勾选后批量写入该供应商的个人模型列表。

## 2. 目标与非目标

### 目标（v1）

- 仅对 API Key 接入的供应商显示「同步模型」；Codex 订阅继续使用既有账号目录同步。
- 调用 `GET {baseUrl}/models` 拉取模型 ID；兼容 OpenAI 列表、Anthropic 列表、`models` 数组与
  裸数组四种响应形态。
- 弹窗展示可搜索、可勾选的模型列表，默认勾选当前 API 格式兼容且本地不存在的模型。
- 只增不删：已存在的模型及其参数完全不变；同步不会修改或删除任何已有模型。
- 新模型按「推荐配置」写入，由内置模型匹配规则自动补齐上下文窗口、输出上限、能力与
  reasoning 档位；端点返回了 `context_length` / `max_*_tokens` / 输入模态时作为稀疏个人覆盖。
- API Key 只在 Host 内使用，不进入 Renderer、日志或错误消息。

### 非目标（v1）

- 不探测模型能力（不发聊天请求）；端点不返回的元数据不做网络补全。
- 不支持 `zhipu-account` 与 `codex-oauth` 两类 Access；它们有各自的账号权益目录。
- 不做定时自动同步，也不在 Provider 保存时隐式同步。
- 不删除端点已下架的本地模型。

## 3. 状态所有权

| 状态                                       | 所有者                      | 持久化                 |
| ------------------------------------------ | --------------------------- | ---------------------- |
| Provider 名称、Base URL、API 格式、API Key | Provider Config（个人层）   | `provider_config.json` |
| 模型成员、模型规则                         | Provider Config（个人层）   | `provider_config.json` |
| 本次拉取的模型目录                         | Host 进程内（单次请求结果） | 不持久化               |
| 弹窗勾选、搜索与错误                       | Renderer 局部状态           | 不持久化               |

- 模型列表唯一写入路径是 Provider Config；Renderer 只提交勾选的模型 ID，不提交 URL、Key 或配置。
- Host 在同步时重新读取已保存的 Effective Config，并在一次 Personal 事务内完成全部新增。

## 4. 接口

### 4.1 Provider Settings Service

```ts
interface ProviderModelSyncCandidate {
  modelId: string;
  /** 端点声明当前 API 格式可用的模型才会进入候选。 */
  alreadyConfigured: boolean;
}

interface ProviderModelSyncPreview {
  providerId: string;
  apiType: ProviderApiType;
  /** 仅用于展示，不包含 API Key。 */
  baseUrl: string;
  models: readonly ProviderModelSyncCandidate[];
}

interface ProviderModelSyncResult {
  view: ProviderSettingsView;
  added: number;
  skipped: number;
}

fetchProviderModels(providerId: string): Promise<ProviderModelSyncPreview>;
syncProviderModels(
  providerId: string,
  modelIds?: readonly string[],
): Promise<ProviderModelSyncResult>;
```

- `modelIds` 省略表示加入全部候选；传入时只加入“本次重新拉取且勾选”的候选。
- 两个方法都先等待该 Provider 的既有操作队列，再读取 Effective Config。
- Provider 不存在、Access 不是 API Key 类型、Base URL 非 `http(s)`、API Key 为空时抛错。
- `syncProviderModels` 重新拉取目录，不信任 Renderer 传入的模型名单；目录中不存在的 ID 计入
  `skipped`。

### 4.2 Provider Config 批量写入

`ProviderConfigService.addPersonalModels(providerId, models, useRecommendedConfig)`：

- 与 `addPersonalModel` 相同的成员/顺序/规则校验，但在一次 `#updatePersonal` 内完成。
- 任一模型已存在（Built-in 继承或个人成员）时整批失败，不产生部分写入。
- 全部模型使用同一种配置模式（同步固定为推荐模式）。

### 4.3 目录请求

| 项     | 规则                                                                                                      |
| ------ | --------------------------------------------------------------------------------------------------------- |
| URL    | `{baseUrl}/models`（折叠末尾 `/`；保留 Base URL 中的路径前缀）                                            |
| 鉴权   | OpenAI 格式：`Authorization: Bearer {key}`；Anthropic 格式：`x-api-key` + `anthropic-version: 2023-06-01` |
| 网络   | 复用 Host `hostApiNetworkTransport.fetch`（系统代理 / No Proxy / 自定义 CA）                              |
| 超时   | 15 秒                                                                                                     |
| 重定向 | `redirect: "error"`，禁止把 API Key 带到其它 Origin                                                       |
| 响应体 | 上限 4 MB，超出即失败                                                                                     |
| 分页   | 支持 `has_more` + `last_id`，最多 10 页                                                                   |
| 数量   | 单次最多 1000 个模型，超出截断                                                                            |

响应解析：

- 列表位置依次识别 `data`、`models`、根数组；元素为字符串或对象。
- 元素 ID 依次识别 `id`、`model`、`name`（去掉 `models/` 前缀）。
- 可选参数：`context_length` / `context_window` / `max_context_length` / `max_model_len` /
  `max_input_tokens` → 上下文窗口；`max_output_tokens` / `max_completion_tokens` → 输出上限；
  `input_modalities` / `architecture.input_modalities` → 输入模态。
- `supported_endpoint_types`（new-api 等网关）用于格式过滤：
  `openai` → `openai-chat-completions`，`openai-response` → `openai-responses`，
  `anthropic` → `anthropic-messages`。不含 `supported_endpoint_types` 的响应不过滤。

错误消息区分：401/403（Key 无效或无权限）、404（端点未提供 `/models`）、其他 HTTP 状态、
响应不是模型列表。错误文本不包含 API Key 与响应体全文。

### 4.4 写入规则

- 候选按「当前 API 格式兼容」过滤后返回；`alreadyConfigured` 用于 UI 置灰，不参与默认勾选。
- 新模型写入 `useRecommendedConfig: true` 的稀疏配置；端点元数据存在时写入
  `properties.contextWindow` / `inputFormat` 与 `optionSpecs.maxOutputTokens`。
- 所有新模型按目录顺序追加到 `personalModelIds` 与 `modelOrder` 末尾。
- 重复同步幂等：第二次同步不会产生重复模型，`added` 为 0。

## 5. UI 规则

- 按钮位于「模型列表」标题行、「添加模型」左侧，空列表时同样可见。
- 仅当 `access` 为 API Key 类型时显示；Base URL 或 API Key 为空时按钮禁用并提示先完善配置。
- 点击顺序：先 flush 当前 Provider 草稿（与「测试连接」一致），再拉取目录；草稿保存失败则不拉取。
- 弹窗：标题「同步模型」，展示 Base URL 与候选数量；搜索框；每个模型一行复选框；
  已存在模型置灰并标注「已存在」；提供全选/取消全选；确认按钮显示将添加的数量。
- 成功后关闭弹窗并在模型列表下方显示「已添加 N 个模型」；没有新增时显示「没有需要新增的模型」。
- 拉取/写入失败保留弹窗或列表状态并显示错误文本；不自动重试。
- 同步进行中禁止重复点击；Provider 切换后丢弃迟到的拉取结果。

## 6. 事件顺序

```text
点击同步 → flush Provider 草稿 → Host 读取 Effective Config → GET {baseUrl}/models
        → 返回候选（不含 Key）→ 用户勾选 → Host 重新拉取并过滤
        → 单次 Personal 事务批量写入 → Registry 刷新 → ProviderSettingsView 广播 → UI 更新列表
```

- 迟到结果以 Provider ID 为边界：弹窗属于发起时的 Provider，切换后不得写入其它 Provider。
- 写入使用 Provider Settings 现有 revision/membership 校验；冲突时整批失败并提示重试。

## 7. 验收场景

| ID      | 场景                                            | 预期                                                          |
| ------- | ----------------------------------------------- | ------------------------------------------------------------- |
| SYNC-01 | 空模型列表的自定义供应商点击同步                | 弹窗列出端点模型；确认后模型行出现，参数按推荐规则补齐        |
| SYNC-02 | 本地已有模型再次同步                            | 已有模型置灰且参数不变；只新增缺失模型；再次同步 `added` 为 0 |
| SYNC-03 | 端点返回 `context_length` / `max_output_tokens` | 新模型使用端点值覆盖对应参数，其余仍走推荐规则                |
| SYNC-04 | 端点返回 `supported_endpoint_types`             | 只显示当前 API 格式兼容的模型                                 |
| SYNC-05 | API Key 错误或端点无 `/models`                  | 显示可读错误；不写入任何模型                                  |
| SYNC-06 | 用户取消勾选或关闭弹窗                          | 不写入任何模型                                                |
| SYNC-07 | Base URL / API Key 为空                         | 按钮禁用或提示先完善配置；不发请求                            |
