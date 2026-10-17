# ADR-0031: 移除 wangEditor 编辑器并将标注标记迁移到 Markdown 编辑器

- 状态：已采纳（Accepted）
- 日期：2026-10-17
- 决定人：zhs

## 背景（Context）

后台条目编辑器（`EditItemApp`）的「描述」正文块用 `AdminRichEditor`，它提供四种模式：可视化（Quill）、HTML 源码、Markdown，以及 **wangEditor**。
wangEditor 是后来引入的独立富文本引擎，仅由条目编辑器通过 `enableWangEditor={true}` 开启，页面/频道编辑器从未启用。

用户要求从描述编辑器**删除** wangEditor（明确「删除不是隐藏」），并把原先仅由 wangEditor 提供的 TCM 互参标注工具栏按钮（`$f/$a/$u/$x`）保留下来。

## 决策（Decision）

### D1：删除 wangEditor 引擎
- 删除 `src/components/admin/shared/AdminRichEditor/component/RichEditorWangEditor/`（含 `registerMarkerMenus.ts`）——这是仓库内唯一使用 `@wangeditor/editor` 与 `@wangeditor/editor-for-react` 的地方。
- 重写 `AdminRichEditor`，移除全部 wangEditor 分支（构造函数的 `wangOwned` 模式、模式切换的 `wangeditor` 分支、渲染分支、`BODY_EDITOR_WANG`/`isOwnedByWang`、`enableWangEditor`/`bodyEditor`/`onBodyEditorChange` 用法）。保留 可视化 / HTML 源码 / Markdown 三种模式。
- `EditItemApp` 的 `AdminRichEditor` 用法移除 `enableWangEditor`/`bodyEditor`/`onBodyEditorChange` 三个 props。
- 删除 `shared.wangEditor` i18n 键（zh-CN / en 同步），删除 `tests/unit/components/rich-editor-wangeditor.test.ts`，更新 `admin-rich-editor-modes.test.ts`（移除 wangEditor mock 与注释）。
- `@wangeditor/*` 依赖暂留 `package.json`（代码已无引用，构建会 tree-shake 掉；后续可单独清理）。
- 连带清理：`src/client/RichEditorMedia.ts` 的 `uploadRichEditorMedia` 唯一调用者即被删的 wangEditor，删除后成零调用者死代码，随之删除该函数及其专用 import（`i18n`/`Requests`/`showToast` 与三个 StringUtils helper）。Quill 的媒体上传走 `RichEditorMediaDialog` 自己的 `Requests.upload`，与此函数无关，故无功能影响。

### D2：存量 wang-owned 条目自动降级
- 此前 `body_editor='wang'` 的条目在打开时强制进入 wangEditor 模式。移除该强制逻辑后，这些条目（其 `content_format` 为 html）会自动在**可视化（Quill）模式**打开。
- Quill 读取路径对「非 Quill 创作的 HTML」不做清洗（仅剥离 Quill 自身写入的瞬时属性，wangEditor 产出不含这些），因此正文内容无损。
- `body_editor='wang'` 标记变为惰性元数据，等价于「重置为默认编辑器」，无需数据迁移脚本。

### D3：标注标记工具栏迁移到 Markdown 编辑器
- 新建 `src/client/annotationMarkers.ts`：搬出 `MarkerConfig` 类型、`DEFAULT_MARKER_CONFIGS` 种子（f=方剂/a=按语/u=中药/x=橙字），并新增 `fetchAnnotationMarkers()`（拉取 `ajax/annotation-markers/list`，失败回退种子）与纯函数 `wrapWithMarker(value, start, end, code)`。
- `AdminMarkdownEditor` 挂载时拉取标记列表，在格式工具栏下方渲染一排按钮；点击调用 `wrapWithMarker`，复用既有的 `findTextarea` + `pendingSelection` 光标机制，在光标处插入 `$<code>{}` 或包裹选区。
- 该工具栏出现于**所有** Markdown 编辑器（条目/页面/频道正文），因为 `AdminMarkdownEditor` 是共享组件、标注是站点级内容特性。新增 i18n 键 `shared.annotationMarkerToolbar`（标注标记）。

## 后果（Consequences）

- 描述编辑器不再提供 wangEditor 富文本模式，作者改用可视化（Quill）/ HTML / Markdown 三种模式录入正文。
- TCM 互参标记的可视化插入继续可用，且入口统一为 Markdown 模式的工具栏按钮（读者端渲染、标记后台管理页均不变）。
- 标记语法仍为纯文本 `$<code>{...}`，即便工具栏不可用，作者也能在 HTML / Markdown 模式手动输入。
- 删除后 `@wangeditor/*` 包成为未引用依赖，占用 `node_modules` 空间，后续可清理但不影响功能。
- 测试：删除 wangEditor 专属测试；新增 `wrapWithMarker` 纯函数单测；`admin-rich-editor-modes` 既有断言（模式列表不含 wangEditor）继续有效。
