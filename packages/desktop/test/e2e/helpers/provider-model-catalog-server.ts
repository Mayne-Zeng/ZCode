import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface ProviderModelCatalogFixtureModel {
  id: string;
  context_length?: number;
  max_output_tokens?: number;
  supported_endpoint_types?: readonly string[];
}

export interface ProviderModelCatalogFixture {
  /** 与 runtime SDK 一致，Base URL 已包含 /v1。 */
  baseUrl: string;
  apiKey: string;
  /** 记录收到的 /models Authorization，用于断言 Host 使用已保存的 Key。 */
  authorizations: Array<string | undefined>;
  close(): Promise<void>;
}

/**
 * 最小 OpenAI-compatible /v1/models 夹具：只服务目录请求，便于验证同步链路。
 */
export async function startProviderModelCatalogFixture(options: {
  models: readonly ProviderModelCatalogFixtureModel[];
  apiKey?: string;
}): Promise<ProviderModelCatalogFixture> {
  const apiKey = options.apiKey ?? "e2e-sync-key";
  const authorizations: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    const path = request.url ?? "";
    if (request.method === "GET" && path === "/v1/models") {
      authorizations.push(request.headers.authorization);
      if (request.headers.authorization !== `Bearer ${apiKey}`) {
        writeJson(response, 401, { error: { message: "Invalid token" } });
        return;
      }
      writeJson(response, 200, { object: "list", data: options.models });
      return;
    }
    writeJson(response, 404, { error: { message: "not found" } });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey,
    authorizations,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
