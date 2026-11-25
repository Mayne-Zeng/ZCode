# Composer 工具栏布局

登记现有 `useComposerToolbarFit` 和 `fitComposerToolbar` 的布局职责，保留原入口和实现。

- 只读取工具栏 DOM 尺寸、更新紧凑显示属性；不持有模型选择、权限或会话状态。
- React hook 统一管理尺寸及内容观察器，并在卸载时清理；测量副本不改变实际控件交互。
- 普通入口与合并模型入口沿用各自已有的收缩顺序；桌面与窄屏共用同一布局函数。
- 收缩档位按 `data-composer-collapse-priority` 依次为 `extension`、`stat`、`0`、`1`、`2`、`3`：扩展插槽 `composer.status`（`extension`）最先收起为只留图标；随后内置用量状态项（`stat`，输出速率与缓存命中率）去掉速率单位，只留图标与数值；之后依次是 Computer、mode、Plan、think 文字（docs/plugins/extension-host.md §6）。
- 各档文字都收起后仍然放不下时，先整体隐藏内置用量状态项（根节点写 `data-composer-stats-hidden="true"`），把宽度留给模型名；上下文圆环右侧的占用百分比随同一步隐藏，只留圆环。之后才进入供应商前缀收缩与模型图标化。
- `iconOnly`（单行输入框，Side Pane 完整视图浮窗）：工具栏宽度随内容变化，没有可测的可用宽度；不测量、不克隆，按同一收缩顺序直接收到最后一级（状态项与圆环百分比随之隐藏）。关闭后回到正常测量并按实际宽度恢复。
- 原布局与契约单测已退役。公开布局入口和各档位需由浏览器或桌面验收覆盖，不能沿用旧单测作为现行证据。
