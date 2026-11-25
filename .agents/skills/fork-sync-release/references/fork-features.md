# fork 改动清单

fork 相对官方 `zai-org/ZCode` 的自有改动。合并官方更新后、打包前、校验产物时，按这张表逐项确认它们还在。新增 fork 改动时在这里加一行，否则下次同步把它弄丢了也没人发现。

| 改动                                                     | 规格                                                                                 | 源码标识                                                                                                              | 包内标识                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 输入区预测（ghost hint）                                 | `docs/composer-input-prediction.md`                                                  | 设置项 `composerInputPredictionEnabled`；`architecture-policy.yaml` 的 `composer-input-prediction-hook`               | `app.asar` 里的 `composerInputPredictionEnabled`                                                         |
| 工具栏用量状态：输出速率 → 缓存命中率 → 圆环与占用百分比 | `docs/ui/chat-input-context.md`、`docs/context-output-rate.md`                       | 组件 `ComposerUsageStats`；`architecture-policy.yaml` 的 `composer-usage-stats`；CLI 的 `mainTurnOutputRateAggregate` | `app.asar` 里的 `chat-output-rate-stat`；`Contents/Resources/glm/zcode.cjs` 里的 `latestTokensPerSecond` |
| E2E 基线修复：公共准备步骤关闭营销弹窗                   | `docs/testing/conversation-session-e2e-development-workflow.md` 的「共享初始化合同」 | `packages/desktop/test/e2e/helpers/occupation-onboarding.ts` 的 `armCloudContentDialogAutoClose`                      | 不进包，只影响 E2E                                                                                       |

## 完好性检查（源码）

在仓库根目录执行。每一条都必须有输出，而且每个数都大于 0：

```sh
git grep -c composerInputPredictionEnabled -- packages/ui/src packages/shared/src
git grep -c ComposerUsageStats -- packages/ui/src
git grep -c mainTurnOutputRateAggregate -- apps/zcode-cli/packages/core/src
git grep -c armCloudContentDialogAutoClose -- packages/desktop/test/e2e/helpers
git grep -c -e composer-input-prediction-hook -e composer-usage-stats -- architecture-policy.yaml
```

出现 0 或没有输出就停下来查。多半是合并冲突时取了官方版本，或者要打包的分支不包含这个改动。包内的对应检查在 [verify-package.md](verify-package.md) 第 2 节。

## 官方改到同一处时

官方的同步提交是整份快照，`architecture-policy.yaml` 和五个语言包（`packages/ui/src/i18n/locales/`）最容易冲突：属于上表登记的条目保留，其余取官方版本。官方自己实现了同名功能、或改到了上表功能涉及的代码时，不要自行取舍，把冲突内容摊给用户决定。

## E2E 基线那一行的由来

2026-11-25 实测，后端的 `/api/v1/marketing/touch` 按 `X-ZCode-App-Version` 定向投放：带 4.0.0 返回「全新登场」弹窗，带 3.18.x 返回 0 条。上游只在引导循环里关这个弹窗，先自己按 Escape 退出引导的用例会漏，于是在公共准备步骤被挡住。fork 的修法是上表第三行。同步官方更新后如果这个 helper 被覆盖，对话类 E2E 会再次集体失败，症状是 `chat-model-select-trigger still not clickable`，遮挡物是 `cloud-content-dialog`。先用既有用例（如 DBG01）确认是不是同一个症状，再把这一行重新套上去。
