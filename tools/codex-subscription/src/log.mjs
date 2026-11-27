const SECRET_KEYS = [
  "authorization",
  "access",
  "access_token",
  "refresh",
  "refresh_token",
  "id_token",
  "code",
  "code_verifier",
  "apiKey",
];

const BEARER_PATTERN = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gu;
const JSON_TOKEN_PATTERN = /("(?:access|refresh|id)_token"\s*:\s*")[^"]+/gu;

function redactValue(value) {
  return `${String(value).slice(0, 6)}…<redacted>`;
}

export function redactSecrets(value) {
  if (typeof value === "string") {
    return value
      .replace(BEARER_PATTERN, "$1<redacted>")
      .replace(JSON_TOKEN_PATTERN, "$1<redacted>");
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SECRET_KEYS.includes(key) ? redactValue(entry) : redactSecrets(entry),
    ]),
  );
}

export function formatError(error) {
  if (!(error instanceof Error)) return redactSecrets(String(error));
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return redactSecrets(`${error.message}${cause}`);
}

/**
 * 网关日志只写 stderr，避免污染 stdout 的配置片段/机器可读输出。
 */
export function createLogger({ verbose = false, sink = process.stderr } = {}) {
  const write = (level, message, details) => {
    const suffix = details === undefined ? "" : ` ${JSON.stringify(redactSecrets(details))}`;
    sink.write(`[codex-sub] ${new Date().toISOString()} ${level} ${message}${suffix}\n`);
  };
  return Object.freeze({
    debug: verbose ? (message, details) => write("debug", message, details) : () => {},
    info: (message, details) => write("info", message, details),
    warn: (message, details) => write("warn", message, details),
    error: (message, details) => write("error", message, details),
  });
}
