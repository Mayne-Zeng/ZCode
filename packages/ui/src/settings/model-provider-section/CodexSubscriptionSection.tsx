import { useCallback, useEffect, useRef, useState } from "react";
import type { CodexSubscriptionStatus } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { useServices } from "@/hooks/useServices.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

const STATUS_POLL_INTERVAL_MS = 1500;

function formatExpiry(value: number | undefined, locale: string): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(
      new Date(value),
    );
  } catch {
    return new Date(value).toISOString();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Codex 订阅 Provider 的 Host 登录状态。token 始终留在 Host 凭据服务，
 * 这里只展示状态并发起登录/同步动作。
 */
export function CodexSubscriptionSection({ providerId }: { providerId: string }) {
  const { providerSettingsService } = useServices();
  const platform = usePlatform();
  const { intl, locale } = useZCodeIntl();
  const [status, setStatus] = useState<CodexSubscriptionStatus | null>(null);
  const [busy, setBusy] = useState<"login" | "logout" | "sync" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const mountedRef = useRef(true);
  // 只在本次登录成功后自动同步一次；页面重新挂载不覆盖用户已有的模型编辑。
  const autoSyncRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await providerSettingsService.getCodexSubscriptionStatus();
      if (mountedRef.current) setStatus(next);
    } catch (error) {
      // 远端 Host 或旧版本没有装配该方法时，入口保持隐藏，不能让设置页整体失败。
      logger.warn("[CodexSubscriptionSection] 读取登录状态失败", error);
      if (mountedRef.current) setStatus({ supported: false, state: "signed-out" });
    }
  }, [providerSettingsService]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (status?.state !== "pending") return;
    const timer = window.setInterval(() => {
      void refreshStatus();
    }, STATUS_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refreshStatus, status?.state]);

  const handleLogin = useCallback(async () => {
    setBusy("login");
    setActionError(null);
    try {
      const { authorizeUrl } = await providerSettingsService.startCodexSubscriptionLogin();
      autoSyncRef.current = true;
      platform.openExternal(authorizeUrl);
      if (mountedRef.current) setStatus({ supported: true, state: "pending" });
    } catch (error) {
      logger.error("[CodexSubscriptionSection] 发起 ChatGPT 登录失败", error);
      if (mountedRef.current) setActionError(errorMessage(error));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [platform, providerSettingsService]);

  const handleCancelLogin = useCallback(async () => {
    setBusy("login");
    setActionError(null);
    try {
      await providerSettingsService.cancelCodexSubscriptionLogin();
      await refreshStatus();
    } catch (error) {
      if (mountedRef.current) setActionError(errorMessage(error));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [providerSettingsService, refreshStatus]);

  const handleLogout = useCallback(async () => {
    setBusy("logout");
    setActionError(null);
    try {
      await providerSettingsService.logoutCodexSubscription();
      await refreshStatus();
    } catch (error) {
      if (mountedRef.current) setActionError(errorMessage(error));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [providerSettingsService, refreshStatus]);

  const handleSyncModels = useCallback(async () => {
    setBusy("sync");
    setActionError(null);
    try {
      await providerSettingsService.syncCodexSubscriptionModels(providerId);
      if (mountedRef.current) setSyncedAt(Date.now());
    } catch (error) {
      logger.error("[CodexSubscriptionSection] 同步 Codex 模型失败", error);
      if (mountedRef.current) setActionError(errorMessage(error));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [providerId, providerSettingsService]);

  useEffect(() => {
    if (status?.state !== "signed-in" || !autoSyncRef.current) return;
    autoSyncRef.current = false;
    void handleSyncModels();
  }, [handleSyncModels, status?.state]);

  if (!status?.supported) return null;

  const signedIn = status.state === "signed-in";
  const pending = status.state === "pending";
  const expired = signedIn && status.expiresAt !== undefined && status.expiresAt <= Date.now();
  const expiry = formatExpiry(status.expiresAt, locale);
  const accountLabel = status.email || status.accountId;

  return (
    <section
      className="space-y-2 rounded-lg border border-input-border bg-input p-3"
      data-testid="codex-subscription-section"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.modelProvider.codexSubscription.title" })}
          </div>
          <div className="text-ui-base text-foreground-subtle">
            {pending
              ? intl.formatMessage({ id: "settings.modelProvider.codexSubscription.pending" })
              : signedIn
                ? intl.formatMessage(
                    { id: "settings.modelProvider.codexSubscription.signedInAs" },
                    { account: accountLabel ?? status.accountId ?? "" },
                  )
                : intl.formatMessage({ id: "settings.modelProvider.codexSubscription.signedOut" })}
            {expired && expiry
              ? ` · ${intl.formatMessage(
                  { id: "settings.modelProvider.codexSubscription.expiredAt" },
                  { date: expiry },
                )}`
              : signedIn && expiry
                ? ` · ${intl.formatMessage(
                    { id: "settings.modelProvider.codexSubscription.expiresAt" },
                    { date: expiry },
                  )}`
                : ""}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {pending ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => void handleCancelLogin()}
            >
              {intl.formatMessage({ id: "settings.modelProvider.codexSubscription.cancel" })}
            </Button>
          ) : signedIn ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => void handleSyncModels()}
              >
                {intl.formatMessage({ id: "settings.modelProvider.codexSubscription.syncModels" })}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy !== null}
                onClick={() => void handleLogout()}
              >
                {intl.formatMessage({ id: "settings.modelProvider.codexSubscription.logout" })}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={busy !== null}
              onClick={() => void handleLogin()}
            >
              {intl.formatMessage({ id: "settings.modelProvider.codexSubscription.login" })}
            </Button>
          )}
        </div>
      </div>
      {status.errorMessage ? (
        <p role="alert" className="text-ui-base text-destructive">
          {status.errorMessage}
        </p>
      ) : null}
      {actionError ? (
        <p role="alert" className="text-ui-base text-destructive">
          {actionError}
        </p>
      ) : null}
      {syncedAt ? (
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.codexSubscription.synced" })}
        </p>
      ) : null}
    </section>
  );
}
