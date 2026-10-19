# ADR-0032: TCM 注文/附注（note / videoMemo）升级为 Markdown 编辑器

- 状态：Accepted
- 日期：2026-10-17
- 决策人：用户 + 设计评审（grilling 会话确认）
- 关联决策：ADR-0029（后台可编辑 TCM 注文，原样存取约定）、ADR-0031（移除 wangEditor，标注标记迁移到 Markdown 编辑器）

## 背景（Context）

ADR-0029 在 `EditItemApp` 的描述（`AdminRichEditor`）块正下方新增「注释（note）/ 附注（videoMemo）」两个控件，当时用的是普通 `AdminTextarea`，存 `_microfeed.note` / `_microfeed.videoMemo` 为**逐字纯文本字符串**，经 `reads.ts` 的 `textOrNull(...)` 原样下发到 App 的 `note` / `sectionvideo` 字段。

用户现要求给这两个字段**增加 Markdown 编辑器**，语义「和描述一样，数据原样保存」。已知事实：

- 「描述」正文用 `AdminRichEditor`（多模式：可视化 Quill / HTML 源码 / Markdown），依赖 `content_format` 区分 markdown 与 html 两种形态。
- `note` / `videoMemo` 是 `_microfeed` 口袋字段（ADR-0006 SSOT），**没有 format 字段**；App 端按字段内容本身渲染，无「格式标记」概念（ADR-0029 D2/D3 已确立「原样字符串下发」约定）。
- 移动端 App 已按 Markdown 渲染 `note` / `sectionvideo`（grilling 会话确认）——故「原样存 Markdown」可端到端成立。
- `AdminMarkdownEditor`（ADR-0031 D3 迁移所得）是 Markdown 专用编辑器：源码编辑 + 实时预览 + 格式化工具栏 + **TCM 互参标记 $f/$a/$u/$x 工具栏**，且为站点级共享组件，所有 Markdown 编辑场景通用。

## 决策（Decision）

### D1：用 `AdminMarkdownEditor` 替换两个 `AdminTextarea`

在 `EditItemApp` 的注文卡片中，把 `note` / `videoMemo` 的两个 `AdminTextarea` 换成 `AdminMarkdownEditor`（各一个）。

**选用 `AdminMarkdownEditor` 的依据（对比 `AdminRichEditor`）**

1. `AdminRichEditor` 的多模式切换依赖 `content_format` 记录「markdown 还是 html」。而 `note` / `videoMemo` 是口袋字段、无 format 字段，且按 ADR-0029 D3 把字符串原样发给 App——App 端没有、也不该有「格式标记」概念。若引入 format，存量与新写入的 markdown 在缺格式标记时会被读者当字面文本（`##` 原样显示），反而不如现状。
2. `AdminMarkdownEditor` 永远存 Markdown 源码、无需 format，天然满足「原样保存」；且**自带 TCM 互参标记工具栏**（$f/$a/$u/$x），正是注文/附注录入时需要的互参能力——`AdminRichEditor` 的各模式均无此工具栏。

两者取舍后选 `AdminMarkdownEditor`：它既是字面意义的「Markdown 编辑器」，又零 format 负担，还顺带补齐 TCM 标注入口。

### D2：数据模型不变，延续 ADR-0029 原样存取约定

- 仍经 `onUpdateItemMicrofeedMeta('note' | 'videoMemo', value)` 同一口袋通路存储，**不新增任何 format 字段**，键名与存储位置不变。
- 存储值从「纯文本」放宽为「Markdown 源码字符串」；ADR-0029 D3 的「不 trim、不清洗、清空写 `""`」约定**全部延续**（清空写 `""` 使键保留，`textOrNull("")` → `null` 与旧后端空值语义一致）。
- 后端 `reads.ts` 序列化逻辑（`textOrNull(pocket.note)` / `textOrNull(pocket.videoMemo)`）**完全不动**——仍是逐字下发，Markdown 由 App 渲染。

### D3：存量数据无需迁移

既有 `note` / `videoMemo` 是纯文本，而**纯文本是合法 Markdown**（Markdown 渲染纯文本即原样输出），打开编辑器即正常显示，无转换、无迁移脚本。

### D4：互参标记自动获得

`AdminMarkdownEditor` 是共享组件、标记全局通用（ADR-0031 D3），因此这两个字段天然获得 `$f/$a/$u/$x` 工具栏——与 TCM 注文需要互参标记的场景一致，无需任何额外接线。

### D5：布局与标签

- 两字段仍置于描述块正下方同一注文卡片（沿用 ADR-0029 D1 布局），**无条件渲染**（新建 / 编辑所有条目可见）不变。
- `AdminMarkdownEditor` 当前无 `label` prop，标签（`items.tcmNoteLabel` / `items.tcmVideoLabel`）改为在组件外手动渲染（风格与 `AdminRichEditor` 内部 label 的 `mb-2 font-semibold` 一致），保持卡片视觉结构一致。
- 组件内 `preview` state 控制**渲染预览**显隐（默认开启）：预览区用 `@uiw/react-markdown-preview` 渲染 `value`，配 `remark-breaks` 让换行与阅读页 marked 的行为一致（ADR-0035）。保存与下发仍为逐字 Markdown——预览只改显示，不改数据（ADR-0034 D2/D3/D5）。

### D6：占位/提示文案

`AdminMarkdownEditor` 自带独立占位符（`shared.markdownSourcePlaceholder`）与底部提示（`shared.markdownHint`），不再消费 `items.tcmNotePlaceholder` / `items.tcmVideoPlaceholder`。为避免遗留无用键，本次**删除**这两个占位键（zh-CN / en 同步移除，i18n 键集仍一致）；原「原样下发」的约定说明并入 `items.tcmPocketHint`，并在其中补明「两者为 Markdown 源码，逐字保存，接口原样返回」，使作者一眼可知这是 Markdown 编辑器且数据原样保存。

### D7：占位/提示按消费方分化（2026-10-17 修订）

`AdminMarkdownEditor` 的默认占位符（`shared.markdownSourcePlaceholder`「用 Markdown 编写章节正文」）与底部提示（`shared.markdownHint`「按你写的 Markdown 原文保存，阅读页渲染时再转成 HTML。」）都按「章节正文」这一个消费方写。该组件现有两个消费方：正文（`AdminRichEditor` 的 Markdown 模式——阅读页确实渲染）与注文/附注（Web 阅读页不显示这两个字段，只由接口逐字下发）。在注文/附注下方显示正文语境的文案与事实不符，且与同卡片的 `items.tcmPocketHint`（「逐字保存，接口原样返回」）互相矛盾。

故给 `AdminMarkdownEditor` 增加 `placeholder?` / `hint?` 两个可选 props（默认值即上述两个正文语境键，正文消费方零改动）；注文/附注两处传入新增键 `shared.markdownSourcePlaceholderGeneric`（「用 Markdown 编写」）与 `shared.markdownHintApp`（「按你写的 Markdown 原文保存，接口原样返回。」），使每个编辑器下方的文案与字段真实的数据去向一致。

## 后果（Consequences）

- 后台作者可用 Markdown 录入注文/附注，并在原文回显中即时看到存入的内容；可一键插入 TCM 互参标记 `$f/$a/$u/$x`。
- 内容仍为逐字字符串原样存发，接口原样返回——端到端生效，后端接口约定、OpenAPI、迁移均不变。
- 非 TCM 条目（ADR-0029 D1 的写-on-interaction 约定）口袋保持零污染：未触碰的字段不触发 onChange，不会写入任何键。
- 无服务端改动、无数据迁移、无 OpenAPI 文档改动。
- 测试：既有 `tests/unit/components/admin-tcm-note-fields.test.ts` 的「原样存取 / 清空写空串」断言继续有效；本次已改写该测试——用 `findMarkdownEditors` 取代原 `AdminTextarea` 查找，验证「新建页渲染两个 `AdminMarkdownEditor` 且初始值为空串」「编辑页回填 `_microfeed.note`/`videoMemo`」「onChange 字符串入参原样写入口袋」，固化本次升级（`AdminMarkdownEditor` 内部的互参标记工具栏由 `annotationMarkers.test.ts` 单独覆盖）。
