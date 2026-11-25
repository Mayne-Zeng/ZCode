// COR01 工具栏在上下文圆环左边显示输出速率与缓存命中率，圆环右侧显示上下文占用百分比
// （docs/conversation-session-case-catalog.md「COR」）。口径见 docs/context-output-rate.md：
// 与开发者工具面板同一公式，取最近一次主轮请求。
// replay 首输出在 2s、结束在 5s、output=120、cache_read=114，速率约为 40 tok/s、缓存命中率 95%；
// 用量 240 / 13 万，占用百分比取整后为 0%。完成请求前两项都不出现；工具栏变窄时先去掉速率单位，
// 各档文字都收起后仍放不下则两项与百分比整体隐藏，放宽后恢复。
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_CHAT_CACHE_HIT_RATE_STAT,
  TID_CHAT_CONTEXT_USAGE_PERCENT,
  TID_CHAT_CONTEXT_USAGE_TRIGGER,
  TID_CHAT_OUTPUT_RATE_STAT,
  TID_V4_COMPOSER_INPUT,
} from "@zcode/shared/test-ids";
import { clearAppData, switchToNewestWindow } from "#e2e/helpers/desktop-app";
import { setPluginPresentation } from "#e2e/helpers/plugin-management-lifecycle";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  setV4ElectronWindowSize,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

const CASE_NAME = "conversation-session-context-output-rate";
const evidence = join(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? join(process.cwd(), ".e2e-artifacts"),
  CASE_NAME,
);
const MARKER = "E2E_CONTEXT_OUTPUT_RATE";
const REPLY = "context-output-rate-ok";
const CACHE_HIT_RATE_LABEL = "95%";
const CONTEXT_PERCENT_LABEL = "0%";

interface StatsLayout {
  /** 缓存命中率状态项的文字；该项未渲染时为 null。 */
  cacheText: null | string;
  /** 输出速率已进入 stat 档：单位收起，只留图标与数值。 */
  compact: boolean;
  /** 已渲染的状态项与圆环百分比全部不可见。 */
  hidden: boolean;
  /** 已渲染的状态项按「输出速率 → 缓存命中率 → 圆环」从左到右排列且互不重叠。 */
  inOrder: boolean;
  /** 圆环百分比位于圆环图标右侧、同一个触发器之内。 */
  percentAfterRing: boolean;
  /** 圆环百分比的文字；未渲染时为 null。 */
  percentText: null | string;
  percentVisible: boolean;
  rateText: string;
}

async function readStatsLayout(): Promise<StatsLayout> {
  return browser.execute(
    (rateTestId, cacheTestId, ringTestId, percentTestId) => {
      const find = (testId: string) =>
        document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
      const rate = find(rateTestId);
      const cache = find(cacheTestId);
      const trigger = find(ringTestId);
      const ringLeft = trigger?.getBoundingClientRect().left ?? null;
      const percent = find(percentTestId);
      const box = (element: Element | null) => element?.getBoundingClientRect() ?? null;
      const rateBox = box(rate);
      const cacheBox = box(cache);
      const percentBox = box(percent);
      const ringIconBox = box(trigger?.querySelector("svg") ?? null);
      const shown = (rect: DOMRect | null): rect is DOMRect => rect !== null && rect.width > 0;
      // 隐藏（display:none）时所有矩形为 0，顺序判定恒为真，由 hidden 单独表达。
      const inOrder =
        ringLeft !== null &&
        rateBox !== null &&
        rateBox.right <= ringLeft + 1 &&
        (cacheBox === null ||
          (rateBox.right <= cacheBox.left + 1 && cacheBox.right <= ringLeft + 1));
      const percentAfterRing =
        shown(percentBox) &&
        ringIconBox !== null &&
        ringIconBox.right <= percentBox.left + 1 &&
        percentBox.right <= (trigger?.getBoundingClientRect().right ?? 0) + 1;
      return {
        cacheText: cache?.innerText.trim() ?? null,
        compact: rate?.dataset.composerCompact === "true",
        hidden: !shown(rateBox) && !shown(cacheBox) && !shown(percentBox),
        inOrder,
        percentAfterRing,
        percentText: percent?.innerText.trim() ?? null,
        percentVisible: shown(percentBox),
        rateText: rate?.innerText.trim() ?? "",
      };
    },
    TID_CHAT_OUTPUT_RATE_STAT,
    TID_CHAT_CACHE_HIT_RATE_STAT,
    TID_CHAT_CONTEXT_USAGE_TRIGGER,
    TID_CHAT_CONTEXT_USAGE_PERCENT,
  );
}

function outputRateTokPerSecond(text: string): number {
  return Number(text.replace("tok/s", "").replace(/[\s,]/g, ""));
}

async function viewportSize(): Promise<{ height: number; width: number }> {
  return browser.execute(() => ({ height: window.innerHeight, width: window.innerWidth }));
}

// 逐级变窄直到谓词成立，返回成立时的宽度与状态；到下限仍不成立则失败。
async function narrowUntil(
  description: string,
  predicate: (layout: StatsLayout) => boolean,
  floorWidth: number,
): Promise<{ layout: StatsLayout; width: number }> {
  let width = (await viewportSize()).width;
  for (; width >= floorWidth; width -= 40) {
    const next = Math.max(width - 40, floorWidth);
    await setV4ElectronWindowSize(next, 800);
    const layout = await browser
      .waitUntil(
        async () => {
          const current = await readStatsLayout();
          return predicate(current) ? current : false;
        },
        { interval: 100, timeout: 2_000 },
      )
      .catch(() => readStatsLayout());
    if (predicate(layout)) return { layout, width: next };
  }
  throw new Error(`窗口收窄到 ${floorWidth}px 仍未出现：${description}`);
}

async function capture(label: string): Promise<void> {
  // 截图要反映稳定态：等有限时长的过渡动画结束，避免截到收起前后的中间帧。
  await browser
    .waitUntil(
      () =>
        browser.execute(
          () =>
            document
              .getAnimations()
              .filter(
                (animation) =>
                  animation.playState === "running" &&
                  animation.effect?.getTiming().iterations !== Infinity,
              ).length === 0,
        ),
      { interval: 100, timeout: 3_000 },
    )
    .catch(() => undefined);
  await mkdir(evidence, { recursive: true });
  await browser.saveScreenshot(join(evidence, `${label}.png`));
}

describe("COR 工具栏输出速率与缓存命中率", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("COR01：请求完成后圆环左边按「速率 → 缓存率 → 圆环」显示、圆环右侧显示占用百分比，变窄时先去单位、再整体隐藏，放宽后恢复", async function () {
    this.timeout(240_000);
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
    const original = await viewportSize();

    // 本次加载还没有主轮请求：没有用量数据，圆环、两项状态项和占用百分比都不渲染。
    expect(await $(`[data-testid="${TID_CHAT_OUTPUT_RATE_STAT}"]`).isExisting()).toBe(false);
    expect(await $(`[data-testid="${TID_CHAT_CACHE_HIT_RATE_STAT}"]`).isExisting()).toBe(false);
    expect(await $(`[data-testid="${TID_CHAT_CONTEXT_USAGE_PERCENT}"]`).isExisting()).toBe(false);

    await sendV4Prompt(`${MARKER}: Reply with exactly ${REPLY}.`);
    await waitForV4AssistantMessageContaining(REPLY);
    await waitForV4ConversationState((state) => state.state === "idle", "主请求尚未结束");

    const rateStat = await $(`[data-testid="${TID_CHAT_OUTPUT_RATE_STAT}"]`);
    await rateStat.waitForDisplayed({ timeout: 15_000, timeoutMsg: "工具栏未显示输出速率" });
    const cacheStat = await $(`[data-testid="${TID_CHAT_CACHE_HIT_RATE_STAT}"]`);
    await cacheStat.waitForDisplayed({ timeout: 15_000, timeoutMsg: "工具栏未显示缓存命中率" });
    const percentLabel = await $(`[data-testid="${TID_CHAT_CONTEXT_USAGE_PERCENT}"]`);
    await percentLabel.waitForDisplayed({
      timeout: 15_000,
      timeoutMsg: "圆环右侧未显示上下文占用百分比",
    });
    const wide = await readStatsLayout();
    expect(wide.inOrder).toBe(true);
    expect(wide.percentAfterRing).toBe(true);
    expect(wide.compact).toBe(false);
    expect(wide.rateText).toContain("tok/s");
    // replay 首输出在 2s，结束在 5s，output=120；留给 SDK/调度少量时间误差。
    const tps = outputRateTokPerSecond(wide.rateText);
    expect(tps).toBeGreaterThan(35);
    expect(tps).toBeLessThan(45);
    // fixture 的 cache_read 为 114/120。
    expect(wide.cacheText).toBe(CACHE_HIT_RATE_LABEL);
    // 用量 240 / 13 万，取整后为 0%。
    expect(wide.percentText).toBe(CONTEXT_PERCENT_LABEL);
    await capture("wide-default");

    // stat 档：先去掉速率单位，只留图标与数值，顺序不变；占用百分比仍紧跟圆环。
    const compact = await narrowUntil("stat 档收起速率单位", (layout) => layout.compact, 360);
    expect(compact.layout.hidden).toBe(false);
    expect(compact.layout.inOrder).toBe(true);
    expect(compact.layout.rateText).not.toContain("tok/s");
    expect(outputRateTokPerSecond(compact.layout.rateText)).toBe(tps);
    expect(compact.layout.cacheText).toBe(CACHE_HIT_RATE_LABEL);
    expect(compact.layout.percentAfterRing).toBe(true);
    await capture(`compact-${compact.width}`);

    // 各档文字都收起后仍放不下：两项与占用百分比整体隐藏，把宽度留给模型名。
    const hidden = await narrowUntil("状态项整体隐藏", (layout) => layout.hidden, 360);
    expect(hidden.layout.percentVisible).toBe(false);
    await capture(`hidden-${hidden.width}`);

    // 放宽回原尺寸：两项与占用百分比恢复完整显示。
    await setV4ElectronWindowSize(original.width, original.height);
    await browser.waitUntil(
      async () => {
        const layout = await readStatsLayout();
        return !layout.hidden && !layout.compact;
      },
      { interval: 100, timeout: 10_000, timeoutMsg: "放宽后状态项没有恢复完整显示" },
    );
    expect(await readStatsLayout()).toMatchObject({
      cacheText: CACHE_HIT_RATE_LABEL,
      compact: false,
      hidden: false,
      inOrder: true,
      percentAfterRing: true,
      percentText: CONTEXT_PERCENT_LABEL,
      percentVisible: true,
      rateText: wide.rateText,
    });

    // 人工评审证据：1200（完整）与 800（收起）× 深浅主题 × 中英文。
    // 窄屏允许收起或隐藏，但不得压到圆环上。手机远控页面是另一套外壳，不在桌面用例里验证。
    for (const theme of ["zai-light", "zai-dark"] as const) {
      for (const locale of ["zh-CN", "en-US"] as const) {
        for (const width of [1200, 800]) {
          await setPluginPresentation({ height: 800, locale, theme, width });
          await browser.waitUntil(
            async () => {
              const layout = await readStatsLayout();
              return layout.inOrder || layout.hidden;
            },
            { interval: 100, timeout: 5_000, timeoutMsg: "状态项压到了圆环上" },
          );
          await capture(`${width}-${locale}-${theme}`);
        }
      }
    }
  });
});
