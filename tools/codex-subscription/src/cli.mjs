#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  DEFAULT_MODELS_CLIENT_VERSION,
  PACKAGE_NAME,
  PROVIDER_ID,
  PROVIDER_NAME,
  VERSION,
  resolveRuntimeConfig,
} from "./constants.mjs";
import { createAuthStore } from "./auth-store.mjs";
import { CodexLoginRequiredError, createAuthManager } from "./auth.mjs";
import { createCodexClient } from "./codex-client.mjs";
import { createLogger, formatError } from "./log.mjs";
import { createProxyServer } from "./proxy-server.mjs";
import {
  buildManualModelRule,
  buildProviderRule,
  loopbackHost,
  readProviderConfigFile,
  writeProviderConfig,
} from "./setup.mjs";

const USAGE = `zcode Codex 订阅网关 ${VERSION}

用法:
  codex-sub login [--device-code] [--manual]
  codex-sub logout
  codex-sub status
  codex-sub models [--refresh] [--json]
  codex-sub serve [--port 17870] [--host 127.0.0.1] [--verbose]
  codex-sub setup [--write] [--port 17870] [--models id1,id2] [--name 名称]
  codex-sub doctor [--verbose]

登录后 serve 保持运行，再执行 setup --write 把个人 Provider 写入 ZCode。
环境变量覆盖: CODEX_SUB_AUTH_FILE / CODEX_SUB_PROVIDER_CONFIG_FILE /
CODEX_SUB_PORT / CODEX_SUB_HOST / CODEX_SUB_RESPONSES_URL / CODEX_SUB_MODELS_URL
`;

function print(value) {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

function parseCli(args) {
  return parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      verbose: { type: "boolean" },
      "device-code": { type: "boolean" },
      manual: { type: "boolean" },
      refresh: { type: "boolean" },
      json: { type: "boolean" },
      write: { type: "boolean" },
      offline: { type: "boolean" },
      port: { type: "string" },
      host: { type: "string" },
      models: { type: "string" },
      name: { type: "string" },
      "config-file": { type: "string" },
      originator: { type: "string" },
    },
  });
}

function buildContext(values) {
  const base = resolveRuntimeConfig();
  const port = values.port === undefined ? base.port : Number(values.port);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`无效端口: ${values.port}`);
  }
  const host = values.host?.trim() || base.host;
  const config = {
    ...base,
    host,
    port,
    providerConfigFile: values["config-file"]?.trim() || base.providerConfigFile,
  };
  const logger = createLogger({ verbose: values.verbose === true });
  const store = createAuthStore({ filePath: config.authFile });
  const auth = createAuthManager({ config, store, logger });
  const client = createCodexClient({ responsesUrl: config.responsesUrl });
  return { config, logger, store, auth, client };
}

async function login(values, context) {
  const result =
    values["device-code"] === true
      ? await context.auth.loginDeviceCode()
      : await context.auth.loginBrowser({
          manual: values.manual === true,
          ...(values.originator ? { originator: values.originator } : {}),
        });
  print(`已登录 ChatGPT${result.email ? `：${result.email}` : ""}`);
  print(`account id: ${result.accountId}`);
  try {
    const models = await context.auth.fetchModels({ force: true });
    print(`可用模型 ${models.length} 个：${models.map((model) => model.id).join(", ")}`);
  } catch (error) {
    context.logger.warn("登录成功，但读取模型目录失败；setup 时可稍后重试", {
      error: formatError(error),
    });
  }
}

async function status(context) {
  const state = await context.auth.getStatus();
  if (!state.loggedIn) {
    print("未登录。运行 codex-sub login");
    return;
  }
  print({
    loggedIn: true,
    accountId: state.accountId,
    email: state.email,
    expiresAt: new Date(state.expiresAt).toISOString(),
    refreshDue: state.expired === true,
    ...(state.modelCache ? { modelCache: state.modelCache } : {}),
  });
}

async function models(values, context) {
  const list = await context.auth.fetchModels({ force: values.refresh === true });
  if (values.json === true) {
    print(list);
    return;
  }
  for (const model of list) {
    print(
      [
        model.id,
        model.name === model.id ? "" : model.name,
        `context=${model.contextWindow ?? "?"}`,
        `max=${model.maxOutputTokens ?? "?"}`,
        model.reasoningEfforts.length
          ? `effort=${model.reasoningEfforts.join("/")}`
          : "no-reasoning",
      ]
        .filter(Boolean)
        .join("  "),
    );
  }
}

async function serve(values, context) {
  const { auth, client, logger, config } = context;
  const server = createProxyServer({ auth, client, logger });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  const status = await auth.getStatus();
  print(`Codex 订阅网关已启动: http://${loopbackHost(config.host)}:${config.port}`);
  print(`Responses: http://${loopbackHost(config.host)}:${config.port}/v1/responses`);
  print(`Models:    http://${loopbackHost(config.host)}:${config.port}/v1/models`);
  print(`登录状态:  ${status.loggedIn ? "已登录" : "未登录（先运行 codex-sub login）"}`);
  print("保持此进程运行；Ctrl+C 停止。");
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function selectModels(all, requested) {
  if (!requested) return all;
  const ids = requested
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const byId = new Map(all.map((model) => [model.id, model]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) {
    throw new Error(`模型目录中不存在: ${missing.join(", ")}；先运行 codex-sub models 查看`);
  }
  return ids.map((id) => byId.get(id));
}

async function setup(values, context) {
  const { auth, config, logger } = context;
  const cachedOnly = values.offline === true;
  const all = cachedOnly
    ? await readCachedModels(context)
    : await auth.fetchModels({ force: false });
  const selected = selectModels(all, values.models);
  if (selected.length === 0) throw new Error("没有可用模型，无法写入 Provider 配置");
  const providerRule = buildProviderRule({
    providerId: PROVIDER_ID,
    providerName: values.name?.trim() || PROVIDER_NAME,
    host: config.host,
    port: config.port,
    models: selected,
  });
  const manualRules = selected.map((model) =>
    buildManualModelRule({ providerId: PROVIDER_ID, model }),
  );
  const snippet = { providerRule, manualRules };

  if (values.write !== true) {
    print("以下配置将合并到 ZCode 的个人 Provider 配置（加 --write 才会写盘）：");
    print(snippet);
    print(`目标文件: ${config.providerConfigFile}`);
    print(`Provider: ${PROVIDER_ID} / ${providerRule.providerName}`);
    print(`Base URL: ${providerRule.config.api.baseUrl}`);
    return;
  }

  const result = await writeProviderConfig({
    filePath: config.providerConfigFile,
    providerId: PROVIDER_ID,
    providerRule,
    manualRules,
  });
  print(`已写入 ${config.providerConfigFile}`);
  if (result.backupPath) print(`原文件备份: ${result.backupPath}`);
  print(`Provider: ${PROVIDER_ID} / ${providerRule.providerName}`);
  print(`Base URL: ${providerRule.config.api.baseUrl}`);
  print(`模型 ${selected.length} 个: ${selected.map((model) => model.id).join(", ")}`);
  const healthy = await probeProxy(config);
  print(healthy ? "网关健康检查: 可访问" : "网关健康检查: 不可访问（先运行 codex-sub serve）");
  logger.info("Provider 配置已合并", { models: selected.length });
}

async function readCachedModels(context) {
  const state = await context.store.read();
  if (!state) throw new CodexLoginRequiredError();
  if (!Array.isArray(state.models?.models) || state.models.models.length === 0) {
    throw new Error("没有离线模型缓存；先联网运行 codex-sub models --refresh");
  }
  return state.models.models;
}

async function probeProxy(config) {
  try {
    const response = await fetch(`http://${loopbackHost(config.host)}:${config.port}/healthz`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function doctor(values, context) {
  const { auth, config, logger } = context;
  const checks = [];
  const record = (name, ok, detail) => {
    checks.push({ name, ok, ...(detail ? { detail } : {}) });
    print(`${ok ? "✓" : "✗"} ${name}${detail ? `: ${detail}` : ""}`);
  };
  const state = await auth.getStatus();
  record(
    "ChatGPT 登录",
    state.loggedIn === true,
    state.loggedIn ? state.email || state.accountId : "未登录",
  );
  if (state.loggedIn) {
    try {
      await auth.getCredentials();
      record("access token", true, `刷新截止 ${new Date(state.expiresAt).toISOString()}`);
    } catch (error) {
      record("access token", false, formatError(error));
    }
    try {
      const list = await auth.fetchModels({ force: true });
      record("模型目录", list.length > 0, `${list.length} 个模型`);
    } catch (error) {
      record("模型目录", false, formatError(error));
    }
  }
  try {
    const providerConfig = await readProviderConfigFile(config.providerConfigFile);
    const rule = providerConfig.config.providerConfigRules.providerRules.find(
      (candidate) => candidate?.providerId === PROVIDER_ID,
    );
    record(
      "ZCode Provider 配置",
      Boolean(rule),
      rule ? rule.config?.api?.baseUrl : `未找到 ${PROVIDER_ID}，运行 setup --write`,
    );
  } catch (error) {
    record("ZCode Provider 配置", false, formatError(error));
  }
  record("网关", await probeProxy(config), `http://${loopbackHost(config.host)}:${config.port}`);
  record("模型目录 client_version", true, DEFAULT_MODELS_CLIENT_VERSION);
  logger.debug("doctor 完成", { checks });
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

async function main() {
  const { values, positionals } = parseCli(process.argv.slice(2));
  if (values.help === true || positionals.length === 0) {
    print(USAGE);
    return;
  }
  if (values.version === true) {
    print(`${PACKAGE_NAME} ${VERSION}`);
    return;
  }
  const command = positionals[0];
  const context = buildContext(values);
  switch (command) {
    case "login":
      await login(values, context);
      return;
    case "logout":
      await context.auth.logout();
      print("已退出 ChatGPT 登录");
      return;
    case "status":
      await status(context);
      return;
    case "models":
      await models(values, context);
      return;
    case "serve":
      await serve(values, context);
      return;
    case "setup":
      await setup(values, context);
      return;
    case "doctor":
      await doctor(values, context);
      return;
    default:
      throw new Error(`未知命令: ${command}`);
  }
}

main().catch((error) => {
  process.stderr.write(`错误: ${formatError(error)}\n`);
  if (error instanceof CodexLoginRequiredError) {
    process.stderr.write("提示: 先运行 codex-sub login\n");
  }
  process.exitCode = 1;
});
