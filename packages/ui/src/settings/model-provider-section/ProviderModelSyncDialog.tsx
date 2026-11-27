import { useEffect, useMemo, useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { ProviderModelSyncCandidate } from "@zcode/services";
import {
  TID_MODEL_PROVIDER_SYNC_MODELS_CANCEL,
  TID_MODEL_PROVIDER_SYNC_MODELS_CONFIRM,
  TID_MODEL_PROVIDER_SYNC_MODELS_DIALOG,
  TID_MODEL_PROVIDER_SYNC_MODELS_ITEM,
  TID_MODEL_PROVIDER_SYNC_MODELS_SEARCH,
  TID_MODEL_PROVIDER_SYNC_MODELS_SELECT_ALL,
  testId,
} from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 模型目录同步的勾选弹窗：只提交模型 ID，Base URL/API Key 与写入都由 Host 负责。
 */
export function ProviderModelSyncDialog({
  open,
  baseUrl,
  models,
  saving,
  error,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  baseUrl: string;
  models: readonly ProviderModelSyncCandidate[];
  saving: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (modelIds: readonly string[]) => void | Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const actionableModels = useMemo(
    () => models.filter((model) => !model.alreadyConfigured),
    [models],
  );
  const filteredModels = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return models;
    return models.filter((model) => model.modelId.toLowerCase().includes(query));
  }, [models, search]);
  const allSelected =
    actionableModels.length > 0 && actionableModels.every((model) => selected.has(model.modelId));
  const selectedCount = actionableModels.filter((model) => selected.has(model.modelId)).length;

  useEffect(() => {
    if (!open) {
      setSearch("");
      return;
    }
    // 每次打开默认勾选全部可添加模型；已存在的模型由用户手动确认，不默认选中。
    setSelected(new Set(actionableModels.map((model) => model.modelId)));
  }, [open, actionableModels]);

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(actionableModels.map((model) => model.modelId)));
  };

  const toggleModel = (modelId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        // 保存中不允许关闭，避免请求结束后关闭新打开的弹窗。
        if (saving) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        data-testid={TID_MODEL_PROVIDER_SYNC_MODELS_DIALOG}
        className="w-[min(520px,calc(100vw-2rem))] max-w-none"
      >
        <DialogTitle className="text-ui-lg font-medium text-foreground">
          {intl.formatMessage({ id: "settings.modelProvider.syncModelsDialogTitle" })}
        </DialogTitle>
        <DialogDescription className="text-ui-base text-foreground-subtle">
          {intl.formatMessage(
            { id: "settings.modelProvider.syncModelsDialogDescription" },
            { baseUrl, count: models.length },
          )}
        </DialogDescription>

        <div className="flex items-center gap-2">
          <Input
            data-testid={TID_MODEL_PROVIDER_SYNC_MODELS_SEARCH}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={intl.formatMessage({
              id: "settings.modelProvider.syncModelsSearchPlaceholder",
            })}
            autoComplete="off"
            spellCheck={false}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid={TID_MODEL_PROVIDER_SYNC_MODELS_SELECT_ALL}
            onClick={toggleAll}
            disabled={saving || actionableModels.length === 0}
          >
            {intl.formatMessage({
              id: allSelected
                ? "settings.modelProvider.syncModelsClearAll"
                : "settings.modelProvider.syncModelsSelectAll",
            })}
          </Button>
        </div>

        <div className="max-h-[min(360px,50vh)] overflow-y-auto rounded-lg border border-input-border bg-input">
          {filteredModels.length === 0 ? (
            <div className="px-3 py-6 text-center text-ui-base text-foreground-subtle">
              {intl.formatMessage({
                id:
                  models.length === 0
                    ? "settings.modelProvider.syncModelsEmpty"
                    : "settings.modelProvider.syncModelsSearchEmpty",
              })}
            </div>
          ) : (
            filteredModels.map((model) => {
              const disabled = saving || model.alreadyConfigured;
              return (
                <label
                  key={model.modelId}
                  data-testid={testId(TID_MODEL_PROVIDER_SYNC_MODELS_ITEM, model.modelId)}
                  className="flex cursor-pointer items-center gap-2 border-b border-input-border px-3 py-2 last:border-b-0 hover:bg-surface-hover"
                >
                  <Checkbox
                    checked={model.alreadyConfigured || selected.has(model.modelId)}
                    disabled={disabled}
                    onCheckedChange={() => toggleModel(model.modelId)}
                  />
                  <span className="min-w-0 flex-1 truncate text-ui-base text-foreground">
                    {model.modelId}
                  </span>
                  {model.alreadyConfigured ? (
                    <span className="shrink-0 text-ui-sm text-foreground-subtle">
                      {intl.formatMessage({
                        id: "settings.modelProvider.syncModelsExisting",
                      })}
                    </span>
                  ) : null}
                </label>
              );
            })
          )}
        </div>

        {error ? (
          <div
            role="alert"
            className="max-h-[min(160px,30vh)] overflow-y-auto rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base break-words text-destructive"
          >
            {error}
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="default"
            data-testid={TID_MODEL_PROVIDER_SYNC_MODELS_CANCEL}
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            {intl.formatMessage({ id: "settings.modelProvider.cancel" })}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="default"
            data-testid={TID_MODEL_PROVIDER_SYNC_MODELS_CONFIRM}
            disabled={saving || selectedCount === 0}
            onClick={() => {
              void onConfirm([...selected]);
            }}
          >
            {saving ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
            {intl.formatMessage(
              { id: "settings.modelProvider.syncModelsConfirm" },
              { count: selectedCount },
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
