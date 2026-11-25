import type { LucideIcon } from "lucide-react";
import { DatabaseIcon, GaugeIcon } from "lucide-react";
import type { ZCodeContextOutputRate } from "@zcode/shared/zcode-protocol-v4";
import { TID_CHAT_CACHE_HIT_RATE_STAT, TID_CHAT_OUTPUT_RATE_STAT } from "@zcode/shared/test-ids";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatContextCacheHitRateLabel } from "@/chat-input-toolbar/contextUsage.js";

interface ComposerUsageStatItem {
  icon: LucideIcon;
  testId: string;
  title: string;
  /** stat 档收起时隐藏的单位；数值始终保留。 */
  unit?: string;
  value: string;
}

function ComposerUsageStat({ icon: Icon, testId, title, unit, value }: ComposerUsageStatItem) {
  return (
    <ControlHintTooltip title={title}>
      <span
        className="group/stat flex h-7 shrink-0 items-center gap-1 rounded-lg px-1.5 text-ui-sm tabular-nums text-foreground-subtle group-data-[composer-stats-hidden=true]/toolbar:hidden"
        // 与扩展插槽同一套收缩机制（composer-toolbar-layout/CONTRACT.md）：stat 档去单位，隐藏阶段整体不显示。
        data-composer-collapse-priority="stat"
        data-composer-stat=""
        data-testid={testId}
      >
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span>{value}</span>
        {unit ? (
          <span className="group-data-[composer-compact=true]/stat:hidden">{unit}</span>
        ) : null}
      </span>
    </ControlHintTooltip>
  );
}

/**
 * 输入框工具栏的内置用量状态项：上下文圆环左边，顺序「输出速率 → 缓存命中率 → 圆环」
 * （docs/ui/chat-input-context.md）。只读展示，不做流式估算；两项各自在字段缺席时不渲染。
 */
export function ComposerUsageStats({
  cacheHitRate,
  outputRate,
}: {
  /** 最近一次主轮请求的缓存命中率（`cache.latestHitRate`）。 */
  cacheHitRate: number | null | undefined;
  outputRate: ZCodeContextOutputRate | undefined;
}) {
  const { intl, locale } = useZCodeIntl();
  const items: ComposerUsageStatItem[] = [];

  if (outputRate && Number.isFinite(outputRate.latestTokensPerSecond)) {
    const latest = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(
      Math.max(0, outputRate.latestTokensPerSecond),
    );
    const average = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
      Math.max(0, outputRate.averageTokensPerSecond),
    );
    items.push({
      icon: GaugeIcon,
      testId: TID_CHAT_OUTPUT_RATE_STAT,
      title: intl.formatMessage(
        { id: "chat.toolbar.outputRate.tooltip" },
        { average, count: outputRate.requestCount, latest },
      ),
      unit: "tok/s",
      value: latest,
    });
  }

  const cacheLabel = formatContextCacheHitRateLabel(cacheHitRate, locale, {
    maximumFractionDigits: 0,
    showBelowThreshold: import.meta.env.DEV,
  });
  if (cacheLabel) {
    items.push({
      icon: DatabaseIcon,
      testId: TID_CHAT_CACHE_HIT_RATE_STAT,
      title: intl.formatMessage({ id: "chat.toolbar.cacheHitRate.tooltip" }),
      value: cacheLabel,
    });
  }

  if (items.length === 0) return null;
  return (
    <>
      {items.map((item) => (
        <ComposerUsageStat key={item.testId} {...item} />
      ))}
    </>
  );
}
