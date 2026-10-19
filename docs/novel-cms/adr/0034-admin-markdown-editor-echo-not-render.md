# ADR-0034: Markdown 编辑器预览改为原文回显（admin 不做 HTML 转换）

- 状态：Accepted（**D1 已被 ADR-0035 修订为渲染预览**；D2/D3/D4 仍有效）
- 日期：2026-10-17
- 决策人：用户（grilling 会话纠正）
- 关联决策：ADR-0029（后台可编辑 TCM 注文，原样存取约定）、ADR-0032（注释/附注升级为 Markdown 编辑器）、ADR-0033（工具栏常用语法按钮）、ADR-0035（预览改用成熟组件，修订本 ADR D1）

## 背景（Context）

ADR-0032 给注释/附注换上 `AdminMarkdownEditor` 后，组件底部的「预览」区走的是 `renderMarkdown`（marked，gfm + breaks）转 HTML 再 `dangerouslySetInnerHTML` 注入；配套文案（`shared.markdownHintApp`、`items.tcmPocketHint`）写着「App 端渲染时再转成 HTML」「App 端按 Markdown 渲染」。

用户在实机验收时纠正三点：

1. 保存形态就是 Markdown 原文（现状已满足）；
2. 「App 端渲染时再转成 HTML」超出本仓库的需求范围——App 接口请求数据，**原始返回数据就可以了**（`reads.ts` 的 `textOrNull` 逐字下发已是现状）；
3. admin 里把 Markdown 转成 HTML 的预览过程是错的——**直接对 Markdown 内容显示**即可；将来若需要正经的渲染预览组件，再安装，不自己手搓转换。

## 决策（Decision）

### D1：预览区改为只读原文回显（后被 ADR-0035 修订）

`AdminMarkdownEditor` 的预览 div（marked HTML + `dangerouslySetInnerHTML`）替换为只读 `AdminCodeEditor`（`readOnly`、`language="markdown"`、与源码框同步显示 `value`）。显隐复选框保留，label 由「预览」改为「原文」（`shared.markdownPreview`）；空态文案改为「暂无内容。」（`shared.markdownEmptyPreview`）。admin 自此只忠于原文：存什么、接口发什么，回显区就显示什么。

> **修订（ADR-0035，同日）**：用户纠正右下角是预览，原文回显的理解有误。本 D1 的回显块已删除，预览恢复为渲染形态，改用 `@uiw/react-markdown-preview` 成熟组件；「admin 不做 HTML 转换」的结论随之撤回，「手搓 marked + dangerouslySetInnerHTML 链路废弃」的结论保留。

### D2：清除「App 端渲染」表述

i18n 与 ADR 中所有「App 端渲染 / App 端按 Markdown 渲染」措辞改为「接口原样返回」语义：

- `shared.markdownHintApp`：「按你写的 Markdown 原文保存，接口原样返回。」
- `items.tcmPocketHint`：「两者为 Markdown 源码，逐字保存，接口原样返回；……」

正文（描述）的 `shared.markdownHint`（「阅读页渲染时再转成 HTML」）**保留**——它对正文准确：阅读页确实经 `bodyToHtml` → `renderMarkdown` 渲染正文。

### D3：三层渲染职责各自独立

- **阅读页**（Web）：`bodyToHtml` → `renderMarkdown`，本仓库负责，ADR-0025/0031 已确立；
- **App 接口**：`reads.ts` `textOrNull` 逐字下发，移动端拿到原始数据后如何呈现由移动端决定，本仓库只保证原文；
- **admin 预览**：成熟 Markdown 预览组件渲染，只服务作者录入时的目视检查（ADR-0035）；任何一层都不替另一层做主张。

### D4：渲染验证测试改定位

`tests/unit/client/markdown-preview.test.ts` 更名 `markdown-reader-render.test.ts`：admin 不再渲染预览后，该测试的定位从「admin 预览往返」改为「阅读页渲染往返」——它锁的是「工具栏插入的语法经 `renderMarkdown`（阅读页同款渲染器）后正确渲染」，即插入语法对唯一真实渲染方的有效性。

## 后果（Consequences）

- admin 内 `renderMarkdown` 的使用点归零（`marked` 仅在 `AdminRichEditor` 的 `editorBody` 内部保留：可视化/HTML 源码编辑器需要 HTML 形态，属编辑器内部转换，非预览）；admin 不再有 `dangerouslySetInnerHTML` 注入面。
- 存储链路、`reads.ts`、阅读页渲染链、OpenAPI 全部不动——本次只改 admin 显示层与文案表述。
- 注释/附注编辑器下方提示与同卡片 `tcmPocketHint` 不再互相矛盾，统一为「逐字保存，接口原样返回」。
- `admin-tcm-note-fields.test.ts` 对 `markdownHintApp` 的断言按键名寻值，文案更新后继续有效；更名后的渲染测试覆盖全部 14 个按钮 + H1–H6。
- 若将来要渲染式预览，按用户既定方向安装成熟组件（如 `@uiw/react-markdown-preview`），不在本 ADR 范围。
