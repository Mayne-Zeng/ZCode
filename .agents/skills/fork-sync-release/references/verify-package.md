# 产物校验

打包结束后在仓库根目录执行。任何一项不符合预期都不要交付：先查原因，必要时重新打包。

每个命令块都可以单独执行，不依赖前一个块里设置的 shell 变量，因为分开执行时变量不会保留。

## 1. 构建结果与元信息

```sh
grep -E "BUNDLE_EXIT=" /tmp/zcode-bundle.log # 必须是 BUNDLE_EXIT=0
ls -la packages/desktop/dist | grep -E "\.dmg$|\.zip$"
cat packages/desktop/out/metadata/build-meta.json # buildCommitId 必须等于下一条的输出
git rev-parse --short=8 HEAD
```

## 2. 包内容

```sh
APP=packages/desktop/dist/mac-arm64/ZCode.app
node node_modules/@electron/asar/bin/asar.js list "$APP/Contents/Resources/app.asar" | sed -E 's#^/##' | sort > /tmp/zcode-asar.txt

grep -E "^out/" /tmp/zcode-asar.txt | cut -d/ -f1-2 | sort -u | tr '\n' ' '; echo
grep -nE "^out/.*\.map$|^out/.*tsbuildinfo$|^out/(app-control-navigation|e2e)(/|$)" /tmp/zcode-asar.txt
# fork 改动的包内标识，逐项都应大于 0；清单见 fork-features.md
grep -a -c composerInputPredictionEnabled "$APP/Contents/Resources/app.asar"
grep -a -c "chat-output-rate-stat" "$APP/Contents/Resources/app.asar"
grep -c "latestTokensPerSecond" "$APP/Contents/Resources/glm/zcode.cjs"
/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" -c "Print :CFBundleIdentifier" "$APP/Contents/Info.plist"
codesign -dv "$APP" 2>&1 | grep -E "^Signature"
rm -f /tmp/zcode-asar.txt
```

预期结果：

- 第一条输出恰好是下面这些，没有 `app-control-navigation`、`e2e`：

  ```text
  out/.extension-host-build-ready out/.host-build-ready out/.main-build-ready out/.preload-build-ready out/.scheduler-build-ready out/extension-host out/host out/main out/metadata out/plugin-sandbox out/preinstalled-tools out/preload out/renderer out/scheduler
  ```

- 第二条没有输出。有输出说明 typecheck 残留或构建缓存被打进了包，回到阶段 3 清理后重打。
- 三条 fork 标识都大于 0（2026-11-25 的构建分别是 16、1、3）。出现 0 说明包里的提交不含对应改动，回到阶段 2 核对 `main` 是否包含全部 fork 提交。
- 版本号等于 `node -p "require('./package.json').version"`，bundle id 是 `dev.zcode.app`。
- 签名是 `adhoc`。

## 3. DMG 内容

```sh
APP=packages/desktop/dist/mac-arm64/ZCode.app
VERSION=$(node -p "require('./package.json').version")
DMG="packages/desktop/dist/ZCode-$VERSION-mac-arm64.dmg"
M=/private/tmp/zcode-dmg-mount
mkdir -p "$M"
hdiutil attach -nobrowse -readonly -noverify -noautoopen -mountpoint "$M" "$DMG"
ls "$M"
shasum -a 256 "$M/ZCode.app/Contents/Resources/app.asar" "$APP/Contents/Resources/app.asar"
hdiutil detach "$M" && rmdir "$M"
```

`ls` 应当看到 `ZCode.app` 和指向 `/Applications` 的 `Applications`。两个 sha256 必须一致，说明镜像里就是第 2 节检查过的那个包。

挂载点用 `/private/tmp` 而不是 `/tmp`：后者是符号链接，`hdiutil` 会报告真实路径，按 `/tmp` 去判断是否挂载成功会误判，导致镜像卸不掉。新版 macOS 会对 `hdiutil attach -mountpoint` 和 `hdiutil detach` 打印「deprecated」警告，不影响结果，可以忽略。

## 4. 隔离启动冒烟测试

产物是 ad-hoc 签名，`codesign --verify --strict` 对它没有意义，能不能启动只能实际跑一次。必须隔离运行，否则这个实例会共用真实的 `~/.zcode`、撞上正式版的单实例锁，并访问钥匙串里的凭据密钥。先告诉用户：屏幕上会多出一个未登录的 ZCode 窗口，约 30 秒后自动关闭。

启动：

```sh
APP="$PWD/packages/desktop/dist/mac-arm64/ZCode.app"
T=/tmp/zcode-smoke
rm -rf "$T" && mkdir -p "$T/home" "$T/userdata" "$T/sessiondata" "$T/tmp"
PORT=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
echo "$PORT" > "$T/port"
(
  env -i HOME="$T/home" USER="$(id -un)" LOGNAME="$(id -un)" SHELL=/bin/zsh \
    PATH="/usr/bin:/bin:/usr/sbin:/sbin" TMPDIR="$T/tmp" LANG=zh_CN.UTF-8 \
    ZCODE_DATA_BASE_DIR="$T/home" ZCODE_DESKTOP_HOME_DIR="$T/home" \
    ZCODE_DESKTOP_USER_DATA_DIR="$T/userdata" ZCODE_DESKTOP_SESSION_DATA_DIR="$T/sessiondata" \
    ZCODE_DESKTOP_APPLICATION_NAME=ZCodeSmoke \
    nohup "$APP/Contents/MacOS/ZCode" --remote-debugging-port="$PORT" > "$T/stdout.log" 2>&1 &
  echo $! > "$T/pid"
)
```

`env -i` 清空环境，是为了不带出当前会话里任何 `ZCODE_*` 变量。`ZCODE_DESKTOP_*` 这组变量是仓库给 e2e 测生产构建用的，定义在 `packages/desktop/src/main/desktopRuntimeEnv.ts`；`ZCODE_DATA_BASE_DIR` 定义在 `packages/services/src/paths.ts`。

读取页面。脚本自己会等页面出现，最长 70 秒：

```sh
node --input-type=module - "$(cat /tmp/zcode-smoke/port)" <<'EOF'
const port = Number(process.argv[2]);
const deadline = Date.now() + 70000;
let targets = null;
while (Date.now() < deadline && !targets) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    if (list.some((target) => target.type === "page")) targets = list;
  } catch {}
  if (!targets) await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!targets) {
  console.log(JSON.stringify({ ok: false, reason: "no page target" }));
  process.exit(2);
}
await new Promise((resolve) => setTimeout(resolve, 8000));
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error("websocket error"));
});
const reply = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("evaluate timeout")), 15000);
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id === 1) {
      clearTimeout(timer);
      resolve(message);
    }
  };
  ws.send(
    JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: {
        expression: `JSON.stringify({
          title: document.title,
          href: location.href.slice(0, 120),
          readyState: document.readyState,
          bodyText: (document.body?.innerText || "").slice(0, 200)
        })`,
        returnByValue: true,
      },
    }),
  );
});
ws.close();
console.log("page:", reply.result?.result?.value ?? JSON.stringify(reply));
EOF
```

通过的标准：`page:` 一行里 `readyState` 是 `complete`，`href` 在 `app.asar/out/renderer` 之下，`bodyText` 非空（未登录时是「欢迎来到 ZCode」登录页的文字）。

关闭实例并清理。`[.]` 是故意的：正则里的 `[.]` 匹配进程路径里的点，却匹配不到当前这条命令自身，这样 `pgrep` / `pkill` 不会误杀执行命令的 shell：

```sh
T=/tmp/zcode-smoke
kill -TERM "$(cat "$T/pid" 2>/dev/null)" 2>/dev/null
for i in $(seq 1 15); do pgrep -f "dist/mac-arm64/ZCode[.]app/Contents" > /dev/null || break; sleep 1; done
pgrep -f "dist/mac-arm64/ZCode[.]app/Contents" > /dev/null && pkill -KILL -f "dist/mac-arm64/ZCode[.]app/Contents"

grep -hoE "MODULE_NOT_FOUND|Cannot find module|ERR_DLOPEN_FAILED|Library not loaded|Code Signature|Killed: 9|\[(error|fatal)\]" \
  "$T/stdout.log" $(find "$T/home/.zcode/v2/logs" -name '*.log' 2>/dev/null) 2>/dev/null | sort | uniq -c
rm -rf "$T"

LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$LSR" -u "$PWD/packages/desktop/dist/mac-arm64/ZCode.app" > /dev/null 2>&1
"$LSR" -u "$PWD/packages/desktop/dist/mac-arm64/ZCode.app/Contents/Frameworks/ZCode Helper.app" > /dev/null 2>&1
echo "仍在启动服务登记的副本数: $("$LSR" -dump | grep -c 'packages/desktop/dist/mac-arm64')" # 必须是 0
```

中间的 `grep` 没有输出才算通过。两条 `lsregister -u` 是把测试实例从启动服务里注销：它和 `/Applications` 里的正式版是同一个 bundle id，留着会让 `zcode://` 链接和「打开方式」指向 `dist/` 下的副本。最后一步用 `echo` 包一层，是因为 `grep -c` 在计数为 0 时退出码是 1，直接写会让整个块明明成功却以非零退出。
