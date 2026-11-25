---
name: fork-sync-release
description: ZCode 个人 fork 专用的「同步官方更新 → 合并进 fork → 过门禁 → 推送 → 重新打包 → 交付安装包」流程。只要用户提到同步或跟进上游、合并官方新版本、重新打包、出新安装包、更新或升级本机安装的 ZCode、把自编译版升到最新，就使用本技能，即使用户只说「更新一下 ZCode」「打个新包」。只打包不同步、只同步不打包、新提交还在功能分支上时，按对应阶段执行。不用于功能开发、给官方提 PR、Computer Use，或应用内自动更新。
---

# Fork 同步与打包交付

本仓库是官方 `zai-org/ZCode` 的个人 fork `Mayne-Zeng/ZCode` 的本机检出，里面带着 fork 自己的改动。改动清单见 [fork-features.md](references/fork-features.md)：合并官方更新后、校验产物时，都按那份清单确认它们没丢。本技能只做一件事：让本机安装的自编译 ZCode 跟上官方最新版本，同时保住 fork 的改动。

安装永远由用户手动完成。流程走到「安装包放进 `~/Downloads`」为止。

## 固定规则

这些规则来自 2026-11-24 的首次实践。要改其中任何一条，先和用户确认。

| 规则                                                         | 原因                                                           |
| ------------------------------------------------------------ | -------------------------------------------------------------- |
| `origin` 指向 fork，`upstream` 指向官方                      | `origin` 是唯一有推送权限的远端，官方仓库只读                  |
| 打包必须带 `ZCODE_ENV=production`                            | 不带会打成连接测试后端的 `ZCode Preview`，替换不了正式版       |
| 不替换 `/Applications` 里的 app，只把 DMG 放进 `~/Downloads` | 替换正在运行的 ZCode 会中断当前会话，用户要自己决定时机        |
| 不绕过任何门禁（`--no-verify`、跳过产物校验）                | 推送门禁和产物校验是唯一挡住坏提交、坏包的环节                 |
| 提交身份用仓库级配置的 `Mayne <mayne@mayne.cn>`              | 用户明确要求，全局配置是另一个身份                             |
| 不在 `main` 上解决合并冲突                                   | `main` 只接收验证过的状态，出问题时可以直接丢弃同步分支        |
| 不尝试把 Computer Use 加回自建包                             | 开源仓库里是占位包，官方 Helper 只接受官方签名的启动方和连接方 |

Computer Use 那条的依据在 `docs/desktop/computer-use-producer-detection.md` 和 `apps/zcode-cli/docs/design/v2/cua-standalone-in-process-broker.md`。

## 流程总览

| 阶段         | 做什么                                                  | 结束标志                                                      |
| ------------ | ------------------------------------------------------- | ------------------------------------------------------------- |
| 0 预检       | 核对 remote、工作区、身份、运行中的实例，以及新提交在哪 | 明确「可以做」还是「卡在哪」                                  |
| 1 同步合并   | 在同步分支上合并 `upstream/main` 并验证                 | 合并提交在本地就绪，检查全部通过                              |
| 2 并入与推送 | 让 `main` 包含全部 fork 提交，再按用户的决定推送        | 推送时远端 `main` 的 sha 与本地一致；不推送时本地等价门禁通过 |
| 3 打包       | 清理残留后打出正式身份的安装包并校验                    | `packages/desktop/dist/` 下的 DMG 通过校验                    |
| 4 交付       | 备份已安装的 app，DMG 放进 `~/Downloads`                | 用户拿到安装步骤和回滚方式                                    |

每个阶段结束再进下一个。任何一步失败，如实报告失败点，不要跳过。各命令块可以分开执行，它们不依赖前一个块留下的 shell 变量。

## 阶段 0：预检

```sh
git remote -v
git status --porcelain=v1 --untracked-files=all
git rev-parse --abbrev-ref HEAD
git config user.name && git config user.email
git ls-files -u | head -1 # 非空说明有未解决的冲突
pgrep -fl "ZCode Dev[.]app/Contents" | head -3 # 非空说明开发版正在运行
node scripts/check-workspace-freshness.mjs
git branch --no-merged main # 带着 main 没有的提交的本地分支
git rev-list --count origin/main..main # main 上还没推送的提交数
codesign -dv --verbose=2 /Applications/ZCode.app 2>&1 | grep -E "^(TeamIdentifier|Signature)" # 当前装的是官方包还是自建包
```

`pgrep` 的模式里写成 `[.]` 是故意的：它能匹配进程路径里的点，却匹配不到这条命令自身，否则内联执行时会把自己当成开发版。

逐项判断：

- remote 不是「`origin` = fork、`upstream` = 官方」时停下来问用户，不要自行改 remote。
- 工作区不干净时停下来问用户怎么处理。不要 stash，也不要丢弃改动：推送门禁要求工作区完全干净，打包也会把这些状态带进产物。
- 开发版实例在运行时，请用户先退出。生产构建会重建 `packages/desktop/out/`，正在运行的开发版会读到半截文件。
- 当前不在 `main` 上，或者 `git branch --no-merged main` 有输出：新提交还在功能分支上，按阶段 2 先把它并入 `main`。
- `main` 领先 `origin/main`：有还没推送的提交。要不要推送单独问用户，不要和「并入 `main`」捆成同一个选项。并入只是本地动作，推送会写到公开仓库。用户没说推就不推。
- 当前装的是自建包时（`Signature=adhoc`、`TeamIdentifier=not set`），交付时的回滚包在 `~/ZCode-fork-backup/`；官方包的在 `~/ZCode-official-backup/`。
- 顺带告诉用户上一次安装包在哪：`find "$HOME/Downloads" -maxdepth 1 -name 'ZCode-*-mac-arm64-fork-*.dmg' -exec ls -t {} + 2>/dev/null | head -1`。没有输出不一定是没交付过，用户装完常会删掉 DMG，这时改看 `ls -t "$HOME/ZCode-fork-backup" 2>/dev/null | head -1`。

然后确认这次要做哪一段：完整流程，还是只重新打包（官方没有更新时）。只重新打包可以跳过阶段 1，但不能跳过阶段 2：新提交要在 `main` 上，推不推送要用户定。

## 阶段 1：同步上游并合并

先看清差距，再动手：

```sh
git fetch upstream --prune
git fetch origin --prune
git rev-list --count main..upstream/main # 落后官方的提交数
git log --oneline upstream/main..main # fork 领先官方的提交，应当只有我们自己的改动
git merge-tree --write-tree --name-only main upstream/main # 合并模拟；退出码 1 表示有冲突
git diff --name-only "$(git merge-base main upstream/main)" main # 我们改过哪些文件
```

落后数为 0 就跳到阶段 2。`git merge-base` 没有输出，说明两边已经没有共同祖先（官方改写过历史），停下来问用户。

在同步分支上合并：

```sh
git switch main &&
  git pull --ff-only && # 与 origin/main 对齐
  git switch -c "sync/upstream-$(date +%Y%m%d)" &&
  git merge --no-edit upstream/main
```

用 `&&` 串起来，是为了让 `main` 没对齐成功时不要接着建同步分支。合并有冲突时最后一条会以非零退出，合并状态留着等下一步处理。

处理冲突的依据在 [fork-features.md](references/fork-features.md) 的「官方改到同一处时」。要点：属于 fork 清单里登记的条目保留，其余取官方版本；官方自己实现了同名功能、或改到了清单里功能涉及的代码时，不要自行取舍，把冲突内容摊给用户决定。

合并完成后：

```sh
git diff --name-only HEAD~1 HEAD -- pnpm-lock.yaml package.json
```

有输出说明依赖变了，告知用户后执行 `pnpm install`。它需要联网，`prepare` 会顺带构建占位 CUA 包。然后按 [fork-features.md](references/fork-features.md) 的「完好性检查」逐项确认，有一项是 0 就说明合并把 fork 的改动弄丢了。

验证都在同步分支上做：

1. `node scripts/check-workspace-freshness.mjs`
2. `pnpm typecheck`，约 5 分钟，放后台跑。
3. `pnpm lint`。合并改到了 React 组件或 hook 时，再按 `docs/testing/react-hooks-lint.md` 做专项扫描，以 `main` 为基线对比（它此时仍指向合并前的提交），确认没有新增诊断。
4. `pnpm architecture:check --changed`

`pnpm typecheck` 报 `TS6305 ... out/app-control-navigation/main.d.ts` 时不是代码问题。开发构建会重建 `packages/desktop/out/`，却留下 `out/` 之外的 `packages/desktop/tsconfig.app-navigation.tsbuildinfo`，`tsc -b` 于是误以为该工程已是最新。把这个缓存文件移走后重跑即可，它可再生且已被 git 忽略。

## 阶段 2：并入与推送

分两步：先把 fork 的提交都放到 `main` 上，再由用户决定推不推。并入只是本地动作，推送会写到公开仓库，两件事分开确认。

并入。来源是阶段 1 的同步分支，或者功能分支：

```sh
git switch main
git pull --ff-only # 与 origin/main 对齐；失败说明远端有本地没有的提交，先停下来
git merge --ff-only <同步分支或功能分支> # 不能快进时以非零退出，main 保持不变
git status --porcelain=v1 --untracked-files=all # 必须没有输出
```

不能快进说明那个分支和 `main` 分叉了，停下来问用户，不要 rebase，也不要强行合并。

用户要推送时：

```sh
LOG=/tmp/zcode-push.log
echo "PUSH_START=$(date +%T) HEAD=$(git rev-parse --short=10 HEAD)" > "$LOG"
git push origin main >> "$LOG" 2>&1
echo "PUSH_EXIT=$?" >> "$LOG"
```

`git push` 会触发 pre-push 门禁，十几秒到 3 分钟，放后台跑并保留完整日志，以日志里的 `PUSH_EXIT` 为准。通过后核对 `git rev-parse HEAD origin/main`，两个 sha 必须一致。这里只推 `main`，同步分支和功能分支都不推，所以不会撞上「新分支首次推送需要 `ZCODE_PRE_PUSH_BASE`」的问题。同步分支和已经并入的功能分支这时可以删（`git branch -d <分支>`），留着也不影响后面的阶段。

用户暂时不推送时，打包照样可以做，但门禁不能省。在本地把同一套检查跑一遍，推送引用按 `git push origin main` 会收到的格式喂进去：

```sh
git merge-base --is-ancestor origin/main main # 必须成功：远端没有本地缺少的提交
ZCODE_PRE_PUSH_STDIN="refs/heads/main $(git rev-parse main) refs/heads/main $(git rev-parse origin/main)" \
  pnpm run verify:pre-push
```

这就是 `.husky/pre-push` 调用的同一条命令，说明见 `docs/testing/pre-push-hook.md`。`origin/main` 不是 `main` 的祖先时先停下来处理分叉，不要伪造基线。在普通 shell 里跑，不要在 git 钩子的环境里跑。门禁通过后进阶段 3，汇报里写明「未推送，`main` 领先 `origin/main` 几个提交」。

`main` 与 `origin/main` 已经一致时没有可推送的内容，直接进阶段 3。

门禁失败就修好再重跑这一段。即使 `main` 没有新提交，`git push` 也会跑门禁，工作区不干净同样会被拦。

## 阶段 3：打包

前提：在 `main` 上，工作区干净，没有开发版实例在运行，并且满足其中一条：`HEAD` 与 `origin/main` 一致；或者用户明确选择暂不推送，且本地等价门禁已经通过。

```sh
rm -rf packages/desktop/out/app-control-navigation packages/desktop/out/e2e
rm -f packages/desktop/out/tsconfig.main.tsbuildinfo packages/desktop/tsconfig.app-navigation.tsbuildinfo
LOG=/tmp/zcode-bundle.log
echo "BUILD_START=$(date +%T) HEAD=$(git rev-parse --short=10 HEAD)" > "$LOG"
ZCODE_ENV=production \
  ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/ \
  pnpm bundle:desktop >> "$LOG" 2>&1
echo "BUNDLE_EXIT=$?" >> "$LOG"
```

先删这几个路径，是因为 `pnpm typecheck` 会把它们留在 `packages/desktop/out/`，生产构建的清理清单不覆盖它们，electron-builder 的 `out/**/*` 就会连同本机绝对路径一起打进 `app.asar`。镜像变量指定 npmmirror，是因为打包脚本在没有内网源配置时会回退到 GitHub 下载 electron-builder 的辅助二进制，npmmirror 在国内更快也更稳。

构建约 3 到 4 分钟，放后台跑。日志在 `/tmp/zcode-bundle.log`，末尾的 `BUNDLE_EXIT` 是构建的真实退出码。后台任务自己报的退出码只说明命令跑完了，不能当作构建成功，以日志里的为准。结束后按 [verify-package.md](references/verify-package.md) 校验产物，校验不过不要进入交付。

日志里这几条可以忽略，首次实践都有，不影响产物：

- `link command failed ... x86_64` 和 `file source doesn't exist ... zcode-window-bounds`：只服务 Computer Use 权限浮窗的小工具，本机命令行工具缺 x86_64 的 Swift 库。
- `skipped macOS code signing`：本机没有 Developer ID，产物是 ad-hoc 签名，本地能正常启动。
- `Unsupported engine ... wanted ... 24.14.0`：本机没有 mise，用的是系统 Node。

## 阶段 4：交付

按 [deliver-package.md](references/deliver-package.md) 执行：核对 DMG 内容，把当前已安装的 app 备份成 zip，DMG 以 `ZCode-<版本>-mac-arm64-fork-<短 sha>.dmg` 命名放进 `~/Downloads`。不要覆盖下载目录里的同名文件。

## 汇报

简短说明这几项，让用户不看过程也能决定装不装：

1. 官方带来了什么：版本号、合并了几个提交。
2. fork 的改动是否完好，按 [fork-features.md](references/fork-features.md) 逐项说。
3. 检查结果：typecheck、lint、架构检查、推送门禁（实际推送触发的，还是本地等价跑的）、产物校验、冒烟测试各自通过还是没跑，没跑要说明原因。
4. 是否已推送：`main` 与 `origin/main` 是否一致；未推送时写明领先几个提交。
5. 交付物：DMG 和备份 zip 的路径。
6. 安装步骤和回滚方式。

安装步骤每次都要带上这几点，它们和普通更新不一样：

- 先退出 ZCode，再把 DMG 里的 `ZCode` 拖进「应用程序」并替换。
- 首次启动读凭据时会弹钥匙串授权框，要选「始终允许」。自建包每个构建的签名身份都不同，所以每次换新包都可能再弹一次。选拒绝的话，应用会备份并清空已保存的凭据，需要重新登录。
- 辅助功能、屏幕录制等隐私权限可能需要重新授权。
- Computer Use 不可用。
- 装好后第一次启动可能弹出后端按版本投放的介绍弹窗（2026-11-25 是「全新登场」），关掉即可，不是安装出了问题。

## 命令失效时

参考文档里的路径和环境变量名跟着仓库走。上游改了 `packages/desktop/scripts/bundle.mjs` 的参数、`packages/desktop/src/main/desktopRuntimeEnv.ts` 里的 `ZCODE_DESKTOP_*` 变量、`scripts/engineering-tests/scope.mjs` 的基线逻辑，或 `.husky/pre-push` 传给验证链的 `ZCODE_PRE_PUSH_STDIN` 格式时，先读当前源码确认新写法，再回来更新本技能。
