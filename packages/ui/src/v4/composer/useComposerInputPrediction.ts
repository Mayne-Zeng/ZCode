import { useCallback, useEffect, useRef, useState } from "react";
import type { IZCodeAgentService } from "@zcode/services";
import type {
  ConversationSnapshot,
  V4ConversationInputPredictionResult,
} from "@zcode/shared/zcode-protocol-v4";

// 桌面端输入预测（composer ghost hint）；规格：docs/composer-input-prediction.md。
// 管线与降级语义见 docs/web-remote-control/mobile-input-prediction.md，此处只做渲染层消费。

/** 渲染层等待上限。迟到 hint 没有价值，也不该在用户继续操作后弹出（D12）。 */
const REQUEST_TIMEOUT_MS = 8_000;

/**
 * 桌面端展示门槛。宿主 show 判定要求 topConfidence ≥ 0.8，但实测模型校准保守
 * （提示词要求"拿不准就给低分"，top 多在 0.2~0.7），几乎永远到不了 0.8 → 桌面永远无 hint。
 * 桌面放宽：suppress_below_threshold（宿主已过滤空候选/重复并排序）且 top 置信度
 * ≥ 0.5 时也展示 top1。只影响桌面渲染层，手机端不经过这里（2026-11-24 用户决定）。
 */
const DESKTOP_MIN_TOP_CONFIDENCE = 0.5;

/** hint 缓存条数；只保留内容键，不保留会话转录。 */
const HINT_CACHE_MAX_ENTRIES = 16;

export interface UseComposerInputPredictionArgs {
  /** 设置 → 行为与工具 → 输入区预测；关闭时不发请求、清除已有 hint。 */
  enabled: boolean;
  sessionId: string | null | undefined;
  /** 会话运行态（snapshot.control.canStop）；运行中不发请求并清除 hint。 */
  running: boolean;
  /** 草稿是否为空（trim 后）；非空时不请求并清除 hint。 */
  composerEmpty: boolean;
  /** 会话运行时已就绪（runtimeInitialization ready 或旧快照无该字段）。 */
  sessionReady: boolean;
  /** 会话内容指纹；见 composerInputPredictionContentKey。 */
  contentKey: string;
  /** 会话快照 revision（缓存键的一部分）；undefined 时不请求。 */
  revision: number | undefined;
  /** 快照归属的会话 id；与 sessionId 不一致（切换过渡帧）时不请求。 */
  snapshotSessionId?: string | undefined;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  service: IZCodeAgentService | undefined;
  /** 采纳：把候选文本追加进编辑器（含英文续写候选的前导空格，不 trim）。 */
  acceptText: (text: string) => void;
}

export interface ComposerInputPredictionController {
  /** 当前展示的 ghost hint 文本；null = 不展示。 */
  hint: string | null;
  /** Tab / 点击采纳：写入编辑器并清除。 */
  accept: () => void;
  /** Escape / 生命周期清除。 */
  dismiss: () => void;
}

/**
 * 会话内容指纹：最后一条真实用户输入 + 该轮最后一条助手回复的稳定身份。
 *
 * 用内容而不是 snapshot.revision 触发预测（D12）：revision 也会被运行时初始化、
 * store recovery 等非对话状态推进，拿它当触发键会在切换/冷打开会话时连续发预测，
 * 后一次响应覆盖前一次，表现为 hint 先出现再变成另一条。内容没变就不重新预测。
 * 重试、edit/rewind、新回合都会改变 userInput 或 assistantText 的 entityId，从而换键。
 */
export function composerInputPredictionContentKey(
  snapshot: ConversationSnapshot | null | undefined,
): string {
  if (!snapshot) return "";
  const rows = snapshot.rows.window;
  let assistantKey = "";
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.kind === "assistantText") {
      if (assistantKey === "") assistantKey = row.entityId ?? String(row.rowId);
      continue;
    }
    if (row.kind === "userInput" && row.origin === "realUser") {
      const userKey = row.entityId ?? String(row.rowId);
      return `${userKey}\u0000${assistantKey}`;
    }
  }
  return "";
}

function predictionCacheKey(sessionId: string, contentKey: string): string {
  return `${sessionId}\u0000${contentKey}`;
}

/**
 * 回合结束后在输入框预测下一条输入（空草稿 → 整条预测）。
 * 触发键是 (sessionId, 会话内容指纹)：同一内容只请求一次，revision 变化本身不重复请求；
 * 切回已展示过 hint 的会话直接命中本地缓存，不再产生模型调用。
 */
export function useComposerInputPrediction(
  args: UseComposerInputPredictionArgs,
): ComposerInputPredictionController {
  const {
    enabled,
    sessionId,
    running,
    composerEmpty,
    sessionReady,
    contentKey,
    revision,
    snapshotSessionId,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    service,
    acceptText,
  } = args;

  const [hint, setHint] = useState<string | null>(null);
  /**
   * 当前 (sessionId, 内容指纹) 的缓存键。渲染期也用它挡住「effect 尚未执行」的过渡帧：
   * 切会话/内容前进后，旧 hint 在同一帧就不再渲染，不会先闪一下旧会话的预测。
   */
  const cacheKey =
    sessionId !== null && sessionId !== undefined && contentKey !== ""
      ? predictionCacheKey(sessionId, contentKey)
      : null;
  /** 最新一次请求的身份；迟到回包按它丢弃。超时/切换会话/内容前进时置空。 */
  const latestRequestRef = useRef<{
    requestId: string;
    sessionId: string;
    contentKey: string;
  } | null>(null);
  /** 已请求过的 (sessionId, 内容指纹) 键；同一键不重复请求，避免 unavailable 循环。 */
  const requestedKeyRef = useRef<string | null>(null);
  const requestSeqRef = useRef(0);
  /** 当前展示的 hint 对应的缓存键；Esc/采纳只删这一条，避免误删新会话的缓存。 */
  const shownHintKeyRef = useRef<string | null>(null);
  /**
   * 最近展示过的 hint（D11）：输入后清空草稿时原地恢复，不重新调用模型；
   * 按会话内容键缓存，切回旧会话也能立即恢复；Esc/采纳删除当前键。
   */
  const hintCacheRef = useRef(new Map<string, string>());

  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const contentKeyRef = useRef(contentKey);
  contentKeyRef.current = contentKey;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const runningRef = useRef(running);
  runningRef.current = running;
  const composerEmptyRef = useRef(composerEmpty);
  composerEmptyRef.current = composerEmpty;
  /** 上一次 effect 看到的会话/内容身份；身份变化时先清掉旧 hint，再决定是否请求。 */
  const ownerRef = useRef<{ sessionId: string | null | undefined; contentKey: string } | null>(
    null,
  );
  /**
   * 只有仍属于当前会话/内容、且当下可交互的 hint 才渲染。effect 在提交后才跑，
   * 这里先挡住切会话、内容前进、开始运行、用户输入的同一帧，避免旧提示闪现或压在正文上。
   */
  const visibleHint =
    cacheKey !== null &&
    enabled &&
    !running &&
    composerEmpty &&
    hint !== null &&
    shownHintKeyRef.current === cacheKey
      ? hint
      : null;
  /** 采纳时引用的最新可见 hint（accept 回调不依赖 state 时序）。 */
  const hintRef = useRef<string | null>(null);
  hintRef.current = visibleHint;

  const clearVisibleHint = useCallback(() => {
    shownHintKeyRef.current = null;
    setHint(null);
  }, []);

  const invalidateInFlight = useCallback(() => {
    // 让在途回包全部失效：后续响应不再覆盖用户刚做的清除/切换动作。
    latestRequestRef.current = null;
  }, []);

  const dismiss = useCallback(() => {
    invalidateInFlight();
    const key = shownHintKeyRef.current;
    if (key !== null) hintCacheRef.current.delete(key);
    // Esc 是明确拒绝：同一内容清空草稿也不再恢复这条 hint。
    clearVisibleHint();
  }, [clearVisibleHint, invalidateInFlight]);

  const accept = useCallback(() => {
    const text = hintRef.current;
    if (!text) return;
    invalidateInFlight();
    const key = shownHintKeyRef.current;
    if (key !== null) hintCacheRef.current.delete(key);
    // 已写入草稿：不再恢复同一条（否则清空后会重复出现）。
    clearVisibleHint();
    acceptText(text);
  }, [acceptText, clearVisibleHint, invalidateInFlight]);

  useEffect(() => {
    // 会话/内容身份变化先作废旧 hint 与在途回包（即使新会话尚未 ready，也不能让旧会话
    // 的 hint 停在新会话输入框里）。同一身份的 revision 抖动不会走到这里。
    const owner = ownerRef.current;
    if (owner === null || owner.sessionId !== sessionId || owner.contentKey !== contentKey) {
      ownerRef.current = { sessionId, contentKey };
      invalidateInFlight();
      clearVisibleHint();
    }
    // 任何失效条件（关闭、运行中、草稿非空、无会话/revision）都立即清除。
    if (
      !enabled ||
      running ||
      !composerEmpty ||
      !sessionId ||
      cacheKey === null ||
      revision === undefined ||
      !service
    ) {
      invalidateInFlight();
      clearVisibleHint();
      return;
    }
    // 运行时未就绪（冷恢复的 initializing 窗口）只暂停请求，不销毁已有 hint/在途请求：
    // 这是过渡态，内容并没有变化，ready 后同一内容键仍可命中缓存或继续等待回包。
    if (!sessionReady) return;
    // 切会话的过渡帧里 sessionId 可能已切换而 snapshot 仍是旧会话的：键必须对齐才请求，
    // 避免拿旧 revision 给新会话发预测（下一帧对齐后自然触发）。
    if (snapshotSessionId !== undefined && snapshotSessionId !== sessionId) {
      invalidateInFlight();
      clearVisibleHint();
      return;
    }
    // 同一会话同一内容只请求一次；revision 抖动（运行时初始化、store recovery 等）
    // 不重复请求，也不覆盖已展示的 hint。
    if (requestedKeyRef.current === cacheKey) {
      const shown = hintCacheRef.current.get(cacheKey);
      if (shown !== undefined) {
        if (hintRef.current !== shown) {
          shownHintKeyRef.current = cacheKey;
          setHint(shown);
        }
      }
      return;
    }
    // 内容前进/切换会话：旧内容的回包与 hint 全部作废。
    invalidateInFlight();
    requestedKeyRef.current = cacheKey;
    const cached = hintCacheRef.current.get(cacheKey);
    if (cached !== undefined) {
      shownHintKeyRef.current = cacheKey;
      setHint(cached);
      return;
    }
    clearVisibleHint();

    const requestId = `composer-${++requestSeqRef.current}`;
    latestRequestRef.current = { requestId, sessionId, contentKey };
    // 超时后失效本请求：迟到的 show 不再弹出。
    const timer = window.setTimeout(() => {
      if (latestRequestRef.current?.requestId === requestId) {
        latestRequestRef.current = null;
      }
    }, REQUEST_TIMEOUT_MS);
    void service
      .conversationInputPredictionV4({
        workspacePath,
        workspaceIdentity,
        ...(remoteSessionId ? { remoteSessionId } : {}),
        sessionId,
        revision,
        requestId,
      })
      .then((result: V4ConversationInputPredictionResult) => {
        if (latestRequestRef.current?.requestId !== requestId) return;
        // 会话/内容已前进，或用户已输入、开始运行、关闭开关：丢弃，不写新会话。
        if (sessionIdRef.current !== sessionId || contentKeyRef.current !== contentKey) return;
        if (!enabledRef.current || runningRef.current || !composerEmptyRef.current) {
          return;
        }
        const top = result.candidates[0];
        // show = 宿主 0.8 门槛放行；suppress_below_threshold 且 top ≥ 0.5 = 桌面放宽展示。
        // 其余（suppress_no_context / unavailable / cancelled）一律静默。
        const shouldShow =
          top !== undefined &&
          (result.decision === "show" ||
            (result.decision === "suppress_below_threshold" &&
              top.confidence >= DESKTOP_MIN_TOP_CONFIDENCE));
        if (shouldShow) {
          // 记入恢复缓存：输入又清空草稿或切回同一内容时原地恢复，不再调模型。
          rememberHint(hintCacheRef.current, cacheKey, top.text);
          shownHintKeyRef.current = cacheKey;
          setHint(top.text);
        } else {
          clearVisibleHint();
        }
      })
      .catch(() => {
        // 任何异常（通道断开、超时）都视为无 hint：静默清除，不重试。
        if (latestRequestRef.current?.requestId === requestId) clearVisibleHint();
      })
      .finally(() => {
        window.clearTimeout(timer);
      });
  }, [
    enabled,
    running,
    composerEmpty,
    sessionId,
    sessionReady,
    contentKey,
    cacheKey,
    revision,
    snapshotSessionId,
    service,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    clearVisibleHint,
    invalidateInFlight,
  ]);

  // 卸载时失效在途请求，避免切会话后迟到回包写进新会话的 hint。
  useEffect(() => {
    return () => {
      latestRequestRef.current = null;
    };
  }, []);

  return { hint: visibleHint, accept, dismiss };
}

/** 有界 LRU：同一键重新展示时移到队尾。 */
function rememberHint(cache: Map<string, string>, key: string, text: string): void {
  cache.delete(key);
  cache.set(key, text);
  while (cache.size > HINT_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}
