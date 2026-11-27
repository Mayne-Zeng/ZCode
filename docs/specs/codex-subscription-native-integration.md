# Codex 订阅原生集成（B 方案）

状态：v1 已实现
日期：2026-11-27
关联：[本地网关方案](../../tools/codex-subscription/README.md)

## 1. 背景

ZCode 已原生支持 `openai-responses`，但 ChatGPT/Codex 订阅后端还要求：

- ChatGPT OAuth 的短期 `access_token`，每次到期前需要 `refresh_token` 刷新；
- `chatgpt-account-id`、`OpenAI-Beta: responses=experimental`、`originator` 等请求头；
- 请求体固定 `store:false`、`stream:true`、`include:["reasoning.encrypted_content"]`；
- 模型目录来自账号实际权益，不是固定模型表。

A 方案（`tools/codex-subscription`）用本地网关解决了这些问题；B 方案把这套能力做进
ZCode，使用户在设置页登录一次即可使用，不需要常驻外部进程。

## 2. 目标与非目标

### 目标（v1）

- 新增 Provider Access 类型 `codex-oauth`；Provider 仍使用 `openai-responses`。
- Desktop Host 拥有 OAuth 登录、令牌存储与刷新；Renderer 和 Provider Config 不保存令牌。
- 设置页创建「Codex 订阅」Provider，显示登录状态，支持登录/退出/同步模型。
- 登录后自动读取账号模型目录，并把模型写入该个人 Provider。
- 每个模型请求前由 CLI 向 Host 取一次动态鉴权；Host 返回短期 token 与 Codex 请求头。
- 登录失败、未登录、额度/限流错误保持显式，不静默回退其它 Provider。

### 非目标（v1）

- 多 ChatGPT 账号、账号切换、额度面板、Fast/Ultra 速度档位。
- 远程 workspace 使用本机 ChatGPT 登录（Host 无本机凭据时明确报不支持）。
- 独立 CLI（无 Desktop Host）的原生登录；该场景继续使用 A 方案。
- 图片生成、ChatGPT connectors、手机远控等 dsh 插件的高级能力。

## 3. 状态所有权

| 状态                                                    | 所有者                                | 持久化                                                      |
| ------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------- |
| OAuth access/refresh token、过期时间、account id、email | Local Host `CodexSubscriptionService` | `ICredentialService` 单键 `codex-subscription:auth`（加密） |
| 登录进行中状态、authorize URL、最近错误                 | `CodexSubscriptionService` 进程内     | 不持久化                                                    |
| Provider access 类型、baseUrl、模型列表、模型规则       | Provider Config（个人层）             | `provider_config.json`                                      |
| 模型请求的实际 token 与头                               | Host 每次解析后经协议下发             | 不持久化                                                    |

不新增第二份 token 文件；A 方案的文件与 B 的凭据互不依赖。

## 4. 接口

### 4.1 Provider Access

```json
{
  "providerId": "codex-subscription",
  "providerName": "Codex 订阅",
  "config": {
    "group": "standard-personal",
    "access": { "type": "codex-oauth" },
    "api": {
      "type": "openai-responses",
      "baseUrl": "https://chatgpt.com/backend-api/codex"
    },
    "personalModelIds": ["gpt-6-astra"],
    "modelOrder": ["gpt-6-astra"]
  }
}
```

- `codex-oauth` 没有可编辑字段，不允许携带 `apiKey`。
- Host 只为 `baseUrl` 属于 `https://chatgpt.com/backend-api/codex` 的 Provider 下发 token，
  防止个人 Provider 改地址后把订阅 token 发到第三方端点。
- Provider 的 `api.headers` 不承载 Codex 必需头；这些头统一由 Host 下发。

### 4.2 Host 服务

`CodexSubscriptionService`（`packages/services/src/model-provider/`）：

```ts
interface CodexSubscriptionStatus {
  supported: boolean;
  state: "signed-out" | "pending" | "signed-in" | "error";
  email?: string;
  accountId?: string;
  expiresAt?: number;
  errorMessage?: string;
}

interface CodexSubscriptionService {
  getStatus(): Promise<CodexSubscriptionStatus>;
  startLogin(): Promise<{ authorizeUrl: string }>;
  cancelLogin(): Promise<void>;
  logout(): Promise<void>;
  resolveRequestAuth(): Promise<{ apiKey: string; headers: Record<string, string> }>;
  listModels(): Promise<CodexSubscriptionModel[]>;
  dispose(): Promise<void>;
}
```

### 4.3 Renderer 能力

复用 `IProviderSettingsService`（`ServiceChannels.ProviderSettings`），增加：

```ts
getCodexSubscriptionStatus(): Promise<CodexSubscriptionStatus>;
startCodexSubscriptionLogin(): Promise<{ authorizeUrl: string }>;
cancelCodexSubscriptionLogin(): Promise<void>;
logoutCodexSubscription(): Promise<void>;
syncCodexSubscriptionModels(providerId: ProviderId): Promise<ProviderSettingsView>;
```

远端 Host 未装配该能力时，状态返回 `supported:false`，其它方法抛出明确错误；UI 隐藏入口。

### 4.4 CLI 动态鉴权

- `access.type === "codex-oauth"` 的模型视为 runtime-auth 模型：
  - 请求前通过既有 `ProviderRuntimeHeadersPort` 向 Host 请求；
  - Host 返回 `requestAuth = { apiKey: accessToken, headers: { "chatgpt-account-id", "OpenAI-Beta", "originator" } }`；
  - CLI 不读取、不持久化 token。
- Host 侧校验顺序：Provider 存在 → `access.type === "codex-oauth"` → `baseUrl` 在允许前缀内 →
  解析 token。任一步不通过都返回不可用，不降级为静态 API Key。

## 5. 请求时序

```text
Renderer                Agent CLI                  Local Host
   |  syncModels           |                            |
   |---------------------->| (Renderer -> Host RPC)     |
   |                       |                            |-- 读取 token / 刷新
   |                       |                            |-- GET /codex/models
   |                       |                            |-- 写 Provider 模型配置
   |<----------------------|----------------------------|
   |
   |  用户发送消息           |                            |
   |                       |-- model request ---------->|
   |                       |   interaction/requestProviderRuntimeHeaders
   |                       |<---------------------------| requestAuth(token, headers)
   |                       |-- POST /codex/responses ----> ChatGPT
```

- 刷新串行化：同一 Host 内一个 `refreshInFlight`；过期阈值 120 秒。
- 上游 401 不在 v1 做强制二次刷新；依赖过期前刷新。登录失效时 UI 显示重新登录。

## 6. 模型同步规则

- 只取 `visibility === "list"` 且 `supported_in_api !== false` 的模型。
- 同步是“替换”语义：重写该 Provider 的 `personalModelIds`、`modelOrder` 和该 Provider 的
  `manualProviderModelRules`；不影响其它 Provider、`defaultModelSelection`。
- 模型元数据来自目录：`context_window`、`max_output_tokens`、`supported_reasoning_levels`、
  `input_modalities`；缺省上下文 272000、最大输出 128000。
- 推理档位直接使用目录 effort，映射到 `reasoning.effort`；非推理模型写空 patch。
- 目录里的 `ultra` 是 Codex 执行/速度预设，不是合法的 `reasoning.effort`；同步时过滤，只有 `ultra` 时退到 `max`，请求层也做同样的兜底。
- 用户手动改过的模型元数据会在同步时被覆盖，README/UI 需提示。

## 7. 验收场景

1. 设置页创建「Codex 订阅」→ 登录 → 浏览器完成授权 → 状态变为已登录并显示 email。
2. 登录后同步模型 → Provider 出现账号实际可用模型；重启 App 后仍存在，登录状态仍在。
3. 选择 Codex 模型发消息 → Host 下发 token/account id/Codex 头 → 上游返回流式回复。
4. 未登录或 token 失效 → 模型请求收到明确的“请重新登录”错误，不发送到其它 Provider。
5. Provider 的 baseUrl 被改成第三方地址 → Host 拒绝下发 token，请求失败并提示地址不被允许。
6. 退出登录 → 凭据删除，状态回到未登录，模型仍保留但请求明确失败。
7. 远端 Host 未装配能力 → UI 不显示 Codex 登录入口，直接调用返回明确不支持错误。
8. OAuth 回调端口 1455 被占用 → 登录启动失败并提示关闭 Codex CLI 后重试。

## 8. 测试

- Provider Schema：`codex-oauth` 解析、序列化、拒绝携带 apiKey。
- `CodexSubscriptionService`：PKCE/account id、刷新、凭据脱敏、baseUrl 校验、模型过滤。
- CLI Adapter：`codex-oauth` 进入 runtime-auth 分支，请求前取到 requestAuth 并应用。
- 设置服务：未装配能力时 `supported:false`；同步模型只替换目标 Provider。
- 手工验收：真实 ChatGPT 账号完成一次登录 + 一条消息（无法自动化，需用户执行）。

## 9. 使用方式（v1）

1. 使用本仓库构建并启动 Desktop（`pnpm dev:desktop` 或自建安装包）。原生入口只在
   `desktop-local` Host 装配；远端 workspace、共享 Server 和独立 CLI 不显示该入口。
2. 设置 → Model Provider → 添加供应商 → 「使用 ChatGPT 订阅」。
3. 点击「登录 ChatGPT」；Host 在 `127.0.0.1:1455` 启动一次性回调并打开系统浏览器。
4. 登录成功后 UI 自动同步一次模型；之后可手动「同步模型」。
5. 在模型选择器中选择账号实际可用的 Codex 模型。

排障：

- `1455` 被占用：关闭正在登录的 Codex CLI/其它终端后重试；v1 没有粘贴授权码的 UI 回退。
- 状态显示「未登录」但刚完成登录：等待 1–2 秒的状态轮询；仍失败时检查 Host 日志
  `codex-subscription` scope。
- 模型请求报 Base URL 不被允许：Provider 的 API 地址必须保持
  `https://chatgpt.com/backend-api/codex`；Host 不会把订阅 token 发往其它地址。
- 独立 CLI：使用 A 方案（`tools/codex-subscription`），原生登录依赖 Desktop Host 的凭据服务。
