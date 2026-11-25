// COR01 上下文容量卡片显示平均输出速率（docs/conversation-session-case-catalog.md「COR」）。
// 口径与归属见 docs/context-output-rate.md：与开发者工具面板同一公式，
// output tokens ÷（首输出到请求结束的秒数）。replay 首输出在 2s、结束在 5s、output=120，
// 卡片行应落在 40 tok/s 附近。token 加权、旁路隔离与缺失计时由 CLI focused tests 覆盖。
import {
  TID_CHAT_CONTEXT_USAGE_OUTPUT_RATE,
  TID_CHAT_CONTEXT_USAGE_TRIGGER,
  TID_V4_COMPOSER_INPUT,
} from "@zcode/shared/test-ids";
import { clearAppData, switchToNewestWindow } from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

const MARKER = "E2E_CONTEXT_OUTPUT_RATE";
const REPLY = "context-output-rate-ok";

async function readOutputRateTokPerSecond(): Promise<number> {
  const cell = await $(`[data-testid="${TID_CHAT_CONTEXT_USAGE_OUTPUT_RATE}"]`);
  const text = (await cell.getText()).trim();
  expect(text).toContain("tok/s");
  return Number(text.replace("tok/s", "").replace(/[\s,]/g, ""));
}

describe("COR 上下文容量卡片输出速率", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("COR01：主轮请求完成后悬停上下文圆环，卡片显示平均输出速率", async function () {
    this.timeout(120_000);
    // 隔离用户目录首次启动会进入引导页，先退出再进入真实任务。
    await browser.waitUntil(
      async () => {
        await switchToNewestWindow();
        return (
          (await $('[data-testid="onboarding-page"]').isDisplayed()) ||
          (await $(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`).isDisplayed())
        );
      },
      { timeout: 30_000, timeoutMsg: "首次引导或 Composer 没有出现" },
    );
    if (await $('[data-testid="onboarding-page"]').isDisplayed()) await browser.keys("Escape");
    await prepareV4ConversationE2E();
    await sendV4Prompt(`${MARKER}: Reply with exactly ${REPLY}.`);
    await waitForV4AssistantMessageContaining(REPLY);
    await waitForV4ConversationState((state) => state.state === "idle", "主请求尚未结束");

    const trigger = await $(`[data-testid="${TID_CHAT_CONTEXT_USAGE_TRIGGER}"]`);
    await trigger.waitForDisplayed({
      timeout: 15_000,
      timeoutMsg: "Context usage trigger 没有出现",
    });
    await trigger.moveTo();
    await browser.waitUntil(async () => (await readOutputRateTokPerSecond()) > 0, {
      timeout: 15_000,
      timeoutMsg: "Context 面板未显示平均输出速率",
    });
    const tps = await readOutputRateTokPerSecond();
    // replay 首输出在 2s，结束在 5s，output=120；留给 SDK/调度少量时间误差。
    expect(tps).toBeGreaterThan(35);
    expect(tps).toBeLessThan(45);
  });
});
