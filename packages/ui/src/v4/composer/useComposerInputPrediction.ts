import { useCallback, useEffect, useRef, useState } from "react";
import type { IZCodeAgentService } from "@zcode/services";
import type { V4ConversationInputPredictionResult } from "@zcode/shared/zcode-protocol-v4";

// 桌面端输入预测（composer ghost hint）；规格：docs/composer-input-prediction.md。
// 管线与降级语义见 docs/web-remote-control/mobile-input-prediction.md，此处只做渲染层消费。

/** 与手机端一致：略长于 CLI 的 20s 模型超时，让服务端降级结果先到达。 */
const REQUEST_TIMEOUT_MS = 25_000;

/**
 * 桌面端展示门槛。宿主 show 判定要求 topConfidence ≥ 0.8，但实测模型校准保守
 * （提示词要求"拿不准就给低分"，top 多在 0.2~0.7），几乎永远到不了 0.8 → 桌面永远无 hint。
 * 桌面放宽：suppress_below_threshold（宿主已过滤空候选/重复并排序）且 top 置信度
 * ≥ 0.5 时也展示 top1。只影响桌面渲染层，手机端不经过这里（2026-11-24 用户决定）。
 */
const DESKTOP_MIN_TOP_CONFIDENCE = 0.5;

export interface UseComposerInputPredictionArgs {
  /** 设置 → 行为与工具 → 输入区预测；关闭时不发请求、清除已有 hint。 */
  enabled: boolean;
  sessionId: string | null | undefined;
  /** 会话运行态（snapshot.control.canStop）；运行中不发请求并清除 hint。 */
  running: boolean;
  /** 草稿是否为空（trim 后）；非空时不请求并清除 hint。 */
  composerEmpty: boolean;
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
 * 回合结束后在输入框预测下一条输入（空草稿 → 整条预测，宿主侧置信度 ≥0.8 才回 show）。
 * 触发键是 (sessionId, revision)：同一键只请求一次，会话前进（revision 变化）才重新预测；
 * 挂载/切回空闲会话时命中宿主 LRU 缓存则不产生模型调用。
 */
export function useComposerInputPrediction(
  args: UseComposerInputPredictionArgs,
): ComposerInputPredictionController {
  const {
    enabled,
    sessionId,
    running,
    composerEmpty,
    revision,
    snapshotSessionId,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    service,
    acceptText,
  } = args;

  const [hint, setHint] = useState<string | null>(null);
  /** 最新一次请求的身份；迟到的回包按它丢弃。超时后置空使后续回包全部失效。 */
  const latestRequestRef = useRef<{ requestId: string; revision: number } | null>(null);
  /** 已请求过的 (sessionId, revision) 键；同一键不重复请求，避免 unavailable 循环。 */
  const requestedKeyRef = useRef<string | null>(null);
  const requestSeqRef = useRef(0);
  /** 采纳/清除时引用的最新 hint（accept 回调不依赖 state 时序）。 */
  const hintRef = useRef<string | null>(null);
  hintRef.current = hint;
  /**
   * 最近一次展示过的 hint 及其键（2026-11-24 用户决定）：输入后清空草稿时原地恢复，
   * 不重新调用模型；Esc 清除或采纳后不恢复（用户已表态），会话前进（键变化）后自然过期。
   */
  const shownHintRef = useRef<{ key: string; text: string } | null>(null);

  const dismiss = useCallback(() => {
    // 让在途回包全部失效：后续响应不再覆盖用户刚做的清除动作。
    latestRequestRef.current = null;
    // Esc 是明确拒绝：同一回合内清空草稿也不再恢复这条 hint。
    shownHintRef.current = null;
    setHint(null);
  }, []);

  const accept = useCallback(() => {
    const text = hintRef.current;
    if (!text) return;
    latestRequestRef.current = null;
    // 已写入草稿：不再恢复同一条（否则清空后会重复出现）。
    shownHintRef.current = null;
    setHint(null);
    acceptText(text);
  }, [acceptText]);

  useEffect(() => {
    // 任何失效条件（关闭、运行中、草稿非空、无会话/revision）都立即清除。
    if (!enabled || running || !composerEmpty || !sessionId || revision === undefined || !service) {
      setHint(null);
      return;
    }
    // 切会话的过渡帧里 sessionId 可能已切换而 snapshot 仍是旧会话的：键必须对齐才请求，
    // 避免拿旧 revision 给新会话发预测（下一帧对齐后自然触发）。
    if (snapshotSessionId !== undefined && snapshotSessionId !== sessionId) {
      setHint(null);
      return;
    }
    const key = `${sessionId}:${revision}`;
    // 同一会话同一 revision 只请求一次；草稿从非空回到空时恢复之前展示过的 hint
    // （纯内存，不重新调用模型），没有可恢复的才保持静默。
    if (requestedKeyRef.current === key) {
      const shown = shownHintRef.current;
      if (shown?.key === key && shown.text !== "") setHint(shown.text);
      return;
    }
    requestedKeyRef.current = key;

    const requestId = `composer-${++requestSeqRef.current}`;
    latestRequestRef.current = { requestId, revision };
    // 超时后失效本请求：迟到的 show 不再弹出（对齐手机端 25s 建议）。
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
        const top = result.candidates[0];
        // show = 宿主 0.8 门槛放行；suppress_below_threshold 且 top ≥ 0.5 = 桌面放宽展示。
        // 其余（suppress_no_context / unavailable / cancelled）一律静默。
        const shouldShow =
          top !== undefined &&
          (result.decision === "show" ||
            (result.decision === "suppress_below_threshold" &&
              top.confidence >= DESKTOP_MIN_TOP_CONFIDENCE));
        if (shouldShow) {
          // 记入恢复缓存：用户输入又清空草稿时原地恢复，不再调模型。
          shownHintRef.current = { key, text: top.text };
          setHint(top.text);
        } else {
          shownHintRef.current = null;
          setHint(null);
        }
      })
      .catch(() => {
        // 任何异常（通道断开、超时）都视为无 hint：静默清除，不重试。
        if (latestRequestRef.current?.requestId === requestId) setHint(null);
      })
      .finally(() => {
        window.clearTimeout(timer);
      });
  }, [
    enabled,
    running,
    composerEmpty,
    sessionId,
    revision,
    snapshotSessionId,
    service,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
  ]);

  // 卸载时失效在途请求，避免切会话后迟到回包写进新会话的 hint。
  useEffect(() => {
    return () => {
      latestRequestRef.current = null;
    };
  }, []);

  return { hint, accept, dismiss };
}
