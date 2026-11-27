import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const DEFAULT_LOCK_TIMEOUT_MS = 8_000;
const DEFAULT_OWNERLESS_STALE_MS = 10_000;
const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800];

function errorCode(error) {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

async function renameWithRetry(from, to) {
  for (const delay of [...RENAME_RETRY_DELAYS_MS, undefined]) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (delay === undefined || !["EPERM", "EBUSY", "EACCES"].includes(errorCode(error))) {
        throw error;
      }
      await sleep(delay);
    }
  }
}

/**
 * 与 ZCode 的 privateFilePersistence 共用同一私有文件写法：目录 0700、文件 0600、临时文件原子替换。
 */
export async function atomicWritePrivateFile(filePath, content) {
  const directory = dirname(filePath);
  const tempPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
    await renameWithRetry(tempPath, filePath);
    await chmod(filePath, 0o600).catch(() => undefined);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function ownerIsAlive(ownerFile) {
  try {
    const raw = await readFile(ownerFile, "utf8");
    const parsed = JSON.parse(raw);
    return isProcessAlive(parsed?.pid);
  } catch {
    return false;
  }
}

async function removeAbandonedLock(lockDir, ownerlessStaleMs) {
  let entries;
  try {
    entries = await readdir(lockDir);
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
  const owners = entries.filter((entry) => entry.startsWith("owner-") && entry.endsWith(".json"));
  if (owners.length > 0) {
    for (const owner of owners) {
      if (await ownerIsAlive(join(lockDir, owner))) return false;
    }
    await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
    return true;
  }
  try {
    const info = await stat(lockDir);
    if (Date.now() - info.mtimeMs < ownerlessStaleMs) return false;
  } catch {
    return false;
  }
  await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

/**
 * 兼容 ZCode 的 `<file>.lock` 目录锁：ZCode 自身写 provider_config.json 时也用同一约定，
 * 外部 setup 必须拿同一把锁，避免和运行中的 Desktop 进程互相覆盖。
 */
export async function withFileLock(filePath, operation, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const ownerlessStaleMs = options.ownerlessStaleMs ?? DEFAULT_OWNERLESS_STALE_MS;
  const lockDir = `${filePath}.lock`;
  const token = `${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const ownerFile = join(lockDir, `owner-${token}.json`);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      await mkdir(dirname(lockDir), { recursive: true, mode: 0o700 });
      await mkdir(lockDir);
      await writeFile(
        ownerFile,
        `${JSON.stringify({ pid: process.pid, createdAt: Date.now(), token })}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      if (await removeAbandonedLock(lockDir, ownerlessStaleMs)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`等待 ZCode 配置文件锁超时: ${lockDir}`);
      }
      await sleep(50 + Math.floor(Math.random() * 100));
    }
  }

  try {
    return await operation();
  } finally {
    // 只有当目录里仍是本次 owner 时才释放，避免删除另一个进程刚接管的锁。
    const entries = await readdir(lockDir).catch(() => []);
    if (entries.includes(`owner-${token}.json`)) {
      await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
