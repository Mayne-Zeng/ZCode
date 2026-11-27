import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import {
  TID_MODEL_PROVIDER_MODEL_INPUT,
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_MODEL_PROVIDER_SYNC_MODELS_BUTTON,
  TID_MODEL_PROVIDER_SYNC_MODELS_CANCEL,
  TID_MODEL_PROVIDER_SYNC_MODELS_CONFIRM,
  TID_MODEL_PROVIDER_SYNC_MODELS_DIALOG,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  readModelProviders,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import { openModelProviderSettings } from "#e2e/helpers/custom-openai-provider";
import { createAndConfigurePersonalProvider } from "#e2e/helpers/personal-provider-settings";
import {
  startProviderModelCatalogFixture,
  type ProviderModelCatalogFixture,
} from "#e2e/helpers/provider-model-catalog-server";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const SYNC_DIALOG_ITEM_PREFIX = "model-provider-sync-models-item-";
// 模型行 ID 是 span（index 后缀区分），不是输入框。
const MODEL_ROW_ID_SELECTOR = `[data-testid^="${TID_MODEL_PROVIDER_MODEL_INPUT}-"]`;

const readModelRowIds = () =>
  browser.execute(
    (selector) =>
      Array.from(document.querySelectorAll<HTMLElement>(selector)).map(
        (element) => element.textContent?.trim() ?? "",
      ),
    MODEL_ROW_ID_SELECTOR,
  );

const readSyncDialogItemCount = () =>
  browser.execute(
    (prefix) => document.querySelectorAll(`[data-testid^="${prefix}"]`).length,
    SYNC_DIALOG_ITEM_PREFIX,
  );

describe("自定义供应商模型同步", () => {
  let fixture: ProviderModelCatalogFixture;

  before(async () => {
    fixture = await startProviderModelCatalogFixture({
      models: [
        { id: "sync-alpha" },
        { id: "sync-beta", context_length: 32768, max_output_tokens: 4096 },
        // 端点声明了非聊天类型：同步必须按当前 API 格式过滤掉。
        { id: "sync-embedding", supported_endpoint_types: ["embedding"] },
      ],
    });
  });

  after(async () => {
    await fixture.close();
    await clearAppData();
  });

  it("SYNC-01/02/03/04/05：拉取端点目录、过滤格式、写入推荐配置并保留已有模型", async function () {
    this.timeout(240_000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await openModelProviderSettings();
    await createAndConfigurePersonalProvider({
      apiFormat: "openai-chat-completions",
      apiKey: fixture.apiKey,
      baseURL: fixture.baseUrl,
      providerName: "Sync Gateway",
    });

    await clickTestIdByDom(TID_MODEL_PROVIDER_SYNC_MODELS_BUTTON, {
      timeout: 15_000,
      timeoutMsg: "同步模型按钮没有出现",
    });
    await waitForTestIdByDom(TID_MODEL_PROVIDER_SYNC_MODELS_DIALOG, {
      timeout: 30_000,
      timeoutMsg: "拉取端点目录后没有打开同步弹窗",
    });
    await browser.waitUntil(async () => (await readSyncDialogItemCount()) === 2, {
      timeout: 15_000,
      timeoutMsg: "同步弹窗没有按当前 API 格式过滤掉非聊天模型",
    });
    expect(fixture.authorizations.at(-1)).toBe(`Bearer ${fixture.apiKey}`);

    await clickTestIdByDom(TID_MODEL_PROVIDER_SYNC_MODELS_CONFIRM, {
      timeout: 15_000,
      timeoutMsg: "同步弹窗确认按钮不可点",
    });
    await browser.waitUntil(
      async () =>
        !(await $(`[data-testid="${TID_MODEL_PROVIDER_SYNC_MODELS_DIALOG}"]`).isExisting()),
      { timeout: 30_000, timeoutMsg: "同步完成后弹窗没有关闭" },
    );
    await browser.waitUntil(
      async () => (await readModelRowIds()).sort().join(",") === "sync-alpha,sync-beta",
      { timeout: 30_000, timeoutMsg: "同步后模型列表没有出现端点模型" },
    );

    const firstProvider = (await readModelProviders()).find(
      (provider) => provider.name === "Sync Gateway",
    );
    expect(firstProvider?.models.map((model) => model.id).sort()).toEqual([
      "sync-alpha",
      "sync-beta",
    ]);

    const repository = new NodePersonalProviderConfigRepository({
      filePath: getE2EAppDataPaths().configFile,
      pollingIntervalMs: false,
    });
    try {
      const snapshot = await repository.read();
      const beta = snapshot.models.getExact(firstProvider!.id, "sync-beta")?.toJSON();
      // 端点返回的参数作为稀疏个人覆盖；未返回的模型继续走内置推荐规则。
      expect(beta?.properties?.contextWindow).toBe(32768);
      expect(beta?.optionSpecs?.maxOutputTokens?.max).toBe(4096);
      const alpha = snapshot.models.getExact(firstProvider!.id, "sync-alpha")?.toJSON();
      expect(alpha?.properties?.contextWindow).toBeUndefined();
    } finally {
      repository.dispose();
    }

    // 幂等：再次同步时已有模型置灰，且没有可添加的候选。
    await clickTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, `custom:${firstProvider!.id}`), {
      timeout: 15_000,
      timeoutMsg: "无法切回已同步的供应商",
    });
    await clickTestIdByDom(TID_MODEL_PROVIDER_SYNC_MODELS_BUTTON, { timeout: 15_000 });
    await waitForTestIdByDom(TID_MODEL_PROVIDER_SYNC_MODELS_DIALOG, { timeout: 30_000 });
    await browser.waitUntil(async () => (await readSyncDialogItemCount()) === 2, {
      timeout: 15_000,
      timeoutMsg: "再次同步没有列出已存在的模型",
    });
    expect(
      await $(`[data-testid="${TID_MODEL_PROVIDER_SYNC_MODELS_CONFIRM}"]`).getAttribute("disabled"),
    ).not.toBeNull();
    await clickTestIdByDom(TID_MODEL_PROVIDER_SYNC_MODELS_CANCEL, { timeout: 15_000 });

    // 失败路径：已保存的 Key 被端点拒绝时不写入模型，也不打开确认弹窗。
    await createAndConfigurePersonalProvider({
      apiFormat: "openai-chat-completions",
      apiKey: "e2e-wrong-key",
      baseURL: fixture.baseUrl,
      providerName: "Sync Gateway Bad Key",
    });
    await clickTestIdByDom(TID_MODEL_PROVIDER_SYNC_MODELS_BUTTON, { timeout: 15_000 });
    await browser.waitUntil(
      () => browser.execute(() => (document.body?.innerText ?? "").includes("HTTP 401")),
      { timeout: 30_000, timeoutMsg: "错误的 API Key 没有显示可读错误" },
    );
    expect(await $(`[data-testid="${TID_MODEL_PROVIDER_SYNC_MODELS_DIALOG}"]`).isExisting()).toBe(
      false,
    );
    const badProvider = (await readModelProviders()).find(
      (provider) => provider.name === "Sync Gateway Bad Key",
    );
    expect(badProvider?.models).toEqual([]);
  });
});
