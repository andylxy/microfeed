# 03 — 容器接入：模式可见性、单向锁定与 Markdown 转换入口

**What to build:** 后台编辑器容器能按「正文归属」决定作者可见的模式：普通正文仍是原来的三个模式；一旦作者切换到 wangEditor，这篇正文就归 wangEditor 所有——重新打开时只看到 wangEditor 与它自己的源码模式，rich 与 markdown 物理上不可选（单向锁定，不提供回转入口）。这是「另外三个模式影响不到它」的代码级落地。

**Blocked by:** 02（编辑器组件）

**Status:** superseded（2026-10-21 核对：wangEditor 已被主动移除——`src` 内三处注释口径一致（「原 wangEditor 已移除 / 迁到 Markdown 编辑器」），组件、i18n 键、接线与测试均已不存在，条目编辑器现走 `AdminMarkdownEditor` + `AdminRichEditor` + `FangEditor`；两个残留依赖已在本轮清理。本组不再执行。）

- [ ] `AdminRichEditor` 新增三个可选 prop：`enableWangEditor` / `bodyEditor` / `onBodyEditorChange`
- [ ] **未传 `enableWangEditor` 时模式列表仍精确为 `[rich, html, markdown]`**（现有断言保绿，Page/Channel 不受影响）
- [ ] `enableWangEditor` 为真时模式列表多出 `wangeditor` 选项
- [ ] `bodyEditor === 'wang'` 时模式列表**仅 `[wangeditor, html]`**，rich/markdown 隐藏（单向锁定）
- [ ] `bodyEditor === 'wang'` 的正文打开时**直接进入 wangEditor 模式**
- [ ] wang 正文**不经 Quill 专用 strip**：`editorValue` 与 html 源码模式均使用原始值
- [ ] `onModeChange` 的 `wangeditor` 分支：Markdown 正文先渲染为 HTML、把 `content_format` 翻为 `html`、打上 `body_editor='wang'` 标记
- [ ] wangEditor 的 `onChange` 直接写回原生 HTML，不调 `formatHtmlForEditing` / `strip`
- [ ] 其余模式（rich/html/markdown）现有逻辑**完全不变**

## 备注

- 容器里 `editorValue` 当前无条件套 `stripTransientRichEditorAttributes`，必须改为条件计算，否则 wang 正文会走 Quill 专用逻辑。
- `htmlSourceFor` 同样需对 wang 内容跳过该 strip。
