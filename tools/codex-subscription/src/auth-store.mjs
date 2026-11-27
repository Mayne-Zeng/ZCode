import { readFile, rm } from "node:fs/promises";
import { atomicWritePrivateFile } from "./lock.mjs";

const AUTH_VERSION = 1;
const PROVIDER = "openai-codex";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateAuthState(value) {
  if (!isRecord(value)) throw new Error("Codex 登录凭据不是 JSON 对象");
  if (value.version !== AUTH_VERSION) {
    throw new Error(`Codex 登录凭据版本不受支持: ${String(value.version)}`);
  }
  if (value.provider !== PROVIDER) {
    throw new Error(`Codex 登录凭据 provider 不匹配: ${String(value.provider)}`);
  }
  if (!nonEmptyString(value.access)) throw new Error("Codex 登录凭据缺少 access token");
  if (!nonEmptyString(value.refresh)) throw new Error("Codex 登录凭据缺少 refresh token");
  if (!Number.isFinite(value.expires)) throw new Error("Codex 登录凭据缺少过期时间");
  if (!nonEmptyString(value.accountId)) throw new Error("Codex 登录凭据缺少 account id");
  return value;
}

export function createAuthState(input) {
  return {
    version: AUTH_VERSION,
    provider: PROVIDER,
    access: input.access,
    refresh: input.refresh,
    expires: input.expires,
    accountId: input.accountId,
    ...(nonEmptyString(input.email) ? { email: input.email.trim() } : {}),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    ...(input.models === undefined ? {} : { models: input.models }),
  };
}

/**
 * 单文件凭据存储。写入走 0600 原子替换；同一进程内的读改写串行化。
 * 跨进程（serve 刷新 vs login 重登）以 updatedAt 较新的一份为准，避免旧刷新覆盖新登录。
 */
export function createAuthStore({ filePath }) {
  let chain = Promise.resolve();

  async function read() {
    let raw;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Codex 登录凭据损坏，请重新登录: ${filePath}`, { cause: error });
    }
    return validateAuthState(parsed);
  }

  async function write(state) {
    await atomicWritePrivateFile(filePath, `${JSON.stringify(state, null, 2)}\n`);
    return state;
  }

  function update(mutator) {
    const run = chain.then(async () => {
      const current = await read();
      const next = await mutator(current);
      if (next === undefined || next === current) return current;
      return write(next);
    });
    chain = run.catch(() => undefined);
    return run;
  }

  async function clear() {
    await rm(filePath, { force: true });
  }

  return Object.freeze({ filePath, read, write, update, clear });
}
