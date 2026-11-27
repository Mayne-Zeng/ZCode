# Codex 订阅网关（ZCode 个人 Provider 版）

把 ChatGPT Plus/Pro 订阅里的 Codex 模型接进 ZCode。ZCode 侧只把它当成一个普通的
`openai-responses` 个人 Provider；OAuth、令牌刷新和 Codex 后端所需的请求头都由本工具负责。

> 这是对 OpenAI 未公开承诺兼容的第三方用法，接口可能随时变化。建议只在本机自用，不要把
> 网关暴露到局域网或公网。ChatGPT 订阅的可用模型、额度和限流完全由账号实际权益决定。

## 与 ZCode 原生集成的关系

本仓库同时提供 B 方案（ZCode 原生 `codex-oauth` Provider）：在 Desktop 设置页登录后，
Host 直接向 Agent 下发短期 token，不需要常驻进程。A 方案仍然是独立 CLI、远程 workspace
不可用原生能力时的通用回退，也是排查上游 wire 变化的最小复现环境。

## 为什么需要网关

ZCode 已经原生支持 `openai-responses`（`store:false`、`reasoning.effort`、加密推理回传），
但 Codex 订阅后端还要求：

- ChatGPT OAuth 的 `access_token`，且每小时过期、需要 `refresh_token` 刷新；
- `chatgpt-account-id` 请求头（从 access token 的 `https://api.openai.com/auth` claim 解出）；
- `OpenAI-Beta: responses=experimental`、`originator` 等头；
- 请求体固定 `store:false`、`stream:true`、`include:["reasoning.encrypted_content"]`。

这些都不适合写进 ZCode 的静态 Provider 配置，所以放进一个只监听 `127.0.0.1` 的小网关。

## 前置条件

- 本仓库的 Node（`mise.toml` 固定为 24.x）。
- 有 Codex 权益的 ChatGPT Plus/Pro 账号。
- ZCode 使用默认数据目录 `~/.zcode/v2`；如果使用独立数据目录，给命令加
  `CODEX_SUB_PROVIDER_CONFIG_FILE` 或 `--config-file`。

## 快速开始

```bash
# 1. 浏览器登录 ChatGPT（设备码模式: --device-code）
node tools/codex-subscription/src/cli.mjs login

# 2. 保持网关运行（另开一个终端，或交给 launchd/systemd）
node tools/codex-subscription/src/cli.mjs serve

# 3. 把 Provider 和账号实际可用的模型写进 ZCode 配置
node tools/codex-subscription/src/cli.mjs setup --write
```

然后在 ZCode → 设置 → Model Provider 里选择「Codex 订阅」，或在模型选择器里直接选
`gpt-6-astra` 等模型。`setup --write` 会备份原 `provider_config.json`，并且只替换
`codex-subscription` 这个 Provider 及其模型规则，不影响其它 Provider。

如果只想看将要写入的内容，先不加 `--write`，命令会打印配置片段。

## 命令

| 命令                                      | 说明                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| `login [--device-code] [--manual]`        | 浏览器 PKCE 登录；端口 1455 被占用时自动改为粘贴授权码；`--device-code` 走设备码 |
| `logout`                                  | 删除本地凭据                                                                     |
| `status`                                  | 查看账号、过期时间、模型缓存                                                     |
| `models [--refresh] [--json]`             | 拉取账号实际可用的模型目录                                                       |
| `serve [--port 17870] [--host 127.0.0.1]` | 启动本地网关（前台运行）                                                         |
| `setup [--write] [--models id1,id2]`      | 生成/写入 ZCode 个人 Provider 与模型规则                                         |
| `doctor`                                  | 检查登录、刷新、模型目录、ZCode 配置和网关连通性                                 |

常用参数：`--port`、`--host`、`--name`、`--config-file`、`--verbose`。

## 手动配置 ZCode（等价做法）

不使用 `setup --write` 时，在 ZCode 设置里新建一个 Provider：

- API 格式：`OpenAI Responses`
- Base URL：`http://127.0.0.1:17870/v1`
- API Key：任意非空字符串（网关不校验）
- 模型：填 `codex-sub models` 输出的 ID，上下文窗口和推理档位按输出填写

`setup --write` 只是把这件事自动化，并写入账号目录返回的模型元数据。

## 给其它 Agent 客户端使用

`serve` 是一个本地 OpenAI **Responses API** 网关，不依赖 ZCode 桌面端：

- Base URL：`http://127.0.0.1:17870/v1`
- API Key：任意非空字符串（网关忽略，会替换成 ChatGPT token）
- Wire/API 格式：`OpenAI Responses`（`POST /v1/responses`）
- Model：`codex-sub models` 输出的 ID；`GET /v1/models` 也可列出
- 流式与非流式都支持；非流式由网关把上游 SSE 聚合回 JSON

限制：

- 只有 Responses API；只支持 `/v1/chat/completions` 的客户端不能直接用
- 不支持 `previous_response_id` / 服务端会话历史：上游固定 `store:false`，每次要带完整上下文
- 没有 embeddings / files / images 等其它 OpenAI 端点
- 默认只绑定 `127.0.0.1`，且没有客户端鉴权；不要暴露到局域网/公网
- 建议只跑一个网关实例；多实例会争用同一个 auth 文件的刷新

## 自动启动

macOS 可以用 launchd（把路径换成你的仓库绝对路径）：

```xml
<!-- ~/Library/LaunchAgents/com.zcode.codex-subscription.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.zcode.codex-subscription</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>node</string>
    <string>/absolute/path/to/ZCode/tools/codex-subscription/src/cli.mjs</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/tmp/codex-subscription.log</string>
  <key>StandardOutPath</key><string>/tmp/codex-subscription.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.zcode.codex-subscription.plist
```

Linux 可以用 systemd user service，Windows 可以用任务计划程序；核心都是执行
`node .../cli.mjs serve`。

## 工作原理

1. `login` 用 Codex CLI 同一 OAuth 客户端 `app_EMoamEEZ73f0CkXaXp7hrann` 走 PKCE，
   回调 `http://localhost:1455/auth/callback`，换取 access/refresh token。
2. 凭据写到 `~/.zcode/v2/codex-subscription/auth.json`（目录 0700、文件 0600），
   access token 到期前 2 分钟自动刷新；刷新轮换后的 refresh token 立即落盘。
3. `serve` 只监听 `127.0.0.1`：
   - `POST /v1/responses`：补 `chatgpt-account-id`、`OpenAI-Beta`、`originator` 等头，
     请求体补 `store:false`、`stream:true`、`include:["reasoning.encrypted_content"]`，
     然后转发到 `https://chatgpt.com/backend-api/codex/responses`；
   - 上游 401 时强制刷新 token 并重试一次；
   - 客户端要流式就透传 SSE；要非流式就把 SSE 聚合为 `response.completed` 的 JSON；
   - `GET /v1/models`：返回账号模型目录（缓存 24 小时）；
   - `GET /healthz`：健康检查。
4. `setup` 读取模型目录，写入个人 Provider 和每个模型的
   `contextWindow` / 图片能力 / 推理档位 / 最大输出。

## 故障排查

- **401 / `chatgpt_login_required`**：重新 `login`；确认账号有 Codex 权益。
- **429 / quota**：订阅额度或窗口用尽，网关不切换其它付费路由，ZCode 会直接显示上游错误。
- **`unsupported_country_region_territory`**：OpenAI 按请求出口 IP 判定地区，不是本工具加了地区头。Node 默认不读系统代理，浏览器能访问不代表 Node 也走同一出口；请让浏览器 OAuth 页面和终端使用同一个受支持地区（如美国/日本/新加坡）。
- **`EADDRINUSE: 1455`**：Codex CLI 正在登录。等它结束，或用 `login --manual` 粘贴授权码。
- **`EADDRINUSE: 17870`**：网关已在运行；`status`/`doctor` 会探测同一端口。
- **ZCode 里看不到模型**：确认 `setup --write` 的目标文件是当前 App 使用的
  `provider_config.json`；开发版如果使用独立数据目录，需要加 `--config-file`。
- **上游改了接口**：`serve --verbose` 查看请求结果；本工具与 dsh-codex-subscription 一样
  依赖 ChatGPT 后端，接口变化时只需更新本目录。

## 安全与隐私

- 网关只绑定 `127.0.0.1`，不提供鉴权；本机其它进程可以访问它，这是本机工具的固有边界。
- 凭据文件权限 0600；日志不打印 token、请求体或响应体。
- `logout` 只删除本地凭据，不吊销服务端会话；需要吊销时去 ChatGPT 账号设置里操作。

## 测试

```bash
node --test tools/codex-subscription/test/*.test.mjs
```

测试用本地 mock 覆盖 PKCE/account id、token 刷新、请求体规范化、SSE 聚合、
401 重试和 `provider_config.json` 合并；不需要真实 ChatGPT 账号。
