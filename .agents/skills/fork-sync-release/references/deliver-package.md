# 交付

在仓库根目录执行。交付只做两件事：备份当前已安装的 app，把 DMG 放进 `~/Downloads`。不要碰 `/Applications` 里的 app 本身，安装由用户手动完成。

## 为什么要备份

访达的「替换」会直接删除旧版，不进废纸篓，所以替换前留一份 zip。官方版和自建版放到不同目录：`~/ZCode-official-backup/` 里的官方签名包是换回 Computer Use 的唯一途径，不要覆盖或删除。

## 执行

整个块在一次执行里完成，后半段要用到前半段算出的变量：

```sh
set -e # 任一步失败就停，不要带着没校验过的备份继续交付

# 1) 备份当前已安装的 app
INSTALLED_VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" /Applications/ZCode.app/Contents/Info.plist)
if codesign -dv --verbose=2 /Applications/ZCode.app 2>&1 | grep -q "^TeamIdentifier=8A5X4JJ39T"; then
  IS_OFFICIAL=1
  BACKUP_DIR="$HOME/ZCode-official-backup"
  BACKUP="ZCode-official-$INSTALLED_VERSION-mac-arm64.zip"
else
  IS_OFFICIAL=0
  BACKUP_DIR="$HOME/ZCode-fork-backup"
  BACKUP="ZCode-$INSTALLED_VERSION-fork-mac-arm64-installed-$(date +%Y%m%d).zip"
fi
mkdir -p "$BACKUP_DIR"
if [ -e "$BACKUP_DIR/$BACKUP" ]; then
  echo "备份已存在，不覆盖：$BACKUP_DIR/$BACKUP"
else
  ditto -c -k --sequesterRsrc --keepParent /Applications/ZCode.app "$BACKUP_DIR/$BACKUP"
fi
unzip -tq "$BACKUP_DIR/$BACKUP" # 应当输出 No errors detected

# 2) 备份的是官方包时，确认还原后签名仍然有效
if [ "$IS_OFFICIAL" = 1 ]; then
  V=$(mktemp -d /tmp/zcode-restore-check.XXXXXX)
  ditto -x -k "$BACKUP_DIR/$BACKUP" "$V" && spctl --assess --type execute -v "$V/ZCode.app" # 应当看到 accepted
  rm -rf "$V"
fi

# 3) DMG 放进下载目录
VERSION=$(node -p "require('./package.json').version")
SHORT=$(git rev-parse --short=8 HEAD)
NAME="ZCode-$VERSION-mac-arm64-fork-$SHORT"
mkdir -p "$HOME/Downloads"
DST="$HOME/Downloads/$NAME.dmg"
if [ -e "$DST" ]; then
  echo "已存在，不覆盖：$DST"
else
  cp -p "packages/desktop/dist/ZCode-$VERSION-mac-arm64.dmg" "$DST"
fi
shasum -a 256 "packages/desktop/dist/ZCode-$VERSION-mac-arm64.dmg" "$DST" # 两个哈希必须一致
echo "quarantine attrs: $(xattr "$DST" | grep -c quarantine)" # 必须是 0
[ -e /tmp/zcode-bundle.log ] && mv /tmp/zcode-bundle.log "packages/desktop/dist/$NAME.build.log"

ls -la "$DST" "$BACKUP_DIR/$BACKUP"
```

## 各步骤的依据

- `8A5X4JJ39T` 是官方 Team ID，只有官方包能匹配上。
- 官方包签名无效就换不回 Computer Use，所以第 2 步要解压出来让 Gatekeeper 实际评估一次，应当看到 `accepted` 和 `source=Notarized Developer ID`。自建包是 ad-hoc 签名，Gatekeeper 本来就不接受，这一步对它没有意义。
- 文件名里的短 sha 取 8 位，与包内 `build-meta.json` 的 `buildCommitId` 一致，用户在应用里看到的构建号和文件名对得上。
- 同一个提交重新打包会撞名，这时问用户是覆盖还是加序号。
- 隔离属性必须是 0。它只由浏览器等下载工具添加，本地生成的 DMG 没有它，用户拖拽安装时 Gatekeeper 才不会拦下这个未公证的包。

## 回滚方式

- 换回上一个自建版：解压 `~/ZCode-fork-backup/` 里对应的 zip，把 `ZCode.app` 拖回「应用程序」替换。
- 换回官方版：同样操作，zip 在 `~/ZCode-official-backup/`。官方版是钥匙串条目原本信任的身份，不会再弹授权框。
