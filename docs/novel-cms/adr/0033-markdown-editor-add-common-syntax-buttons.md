# ADR-0033: Markdown 编辑器工具栏新增常用语法按钮

- 状态：Accepted
- 日期：2026-10-17
- 决策人：用户（「继续优化添加常用的语法规则」）+ 设计评审
- 关联决策：ADR-0031（移除 wangEditor，标注标记迁移到 Markdown 编辑器）、ADR-0032（注释/附注升级为 Markdown 编辑器）

## 背景（Context）

`AdminMarkdownEditor` 的格式化工具栏由 `EDITOR_TOOLBAR_ACTIONS`（`src/client/markdownActions.ts`）全量驱动，当前能一键插入 10 个动作：二级/三级标题、粗体、斜体、引用、行内代码、代码块、无序/有序列表、链接。

阅读页渲染走 `renderMarkdown`（`src/shared/BodyFormat.ts`），底层 `marked` 已开 `gfm: true`——即删除线 `~~`、表格、任务列表 `- [ ]`、自动链接等 **GFM 语法其实已能渲染**，只是仓库里没有按钮可一键插入，作者得手敲。用户指出「Markdown 编辑器只有部分 md 格式语法」，要求补上常用的语法规则。

经确认，缺口在工具栏插入能力，阅读页渲染能力已具备。本次新增四类最常用语法按钮：删除线、分割线、表格、任务列表。

## 决策（Decision）

### D1：新增四个工具栏动作

在 `EditorToolbarAction` 类型与 `EDITOR_TOOLBAR_ACTIONS` 数组中加入：

| action | 插入语法 | 标签键 |
|---|---|---|
| `strikethrough` | `~~文字~~`（包裹选中） | `richEditor.strikethrough` |
| `horizontal-rule` | `---`（独占一行插入） | `richEditor.horizontalRule` |
| `table` | GFM 三列表格模板 | `richEditor.table` |
| `task-list` | `- [ ] `（行前缀，可切换） | `richEditor.taskList` |

按钮顺序：`标题2/3 → 粗体/斜体/删除线 → 引用/行内代码/代码块 → 无序/有序/任务列表 → 表格/分割线 → 链接`，沿用既有的分组逻辑。`EditorFormatToolbar` 自动映射数组，无需改动组件。（标题两个按钮后被 D5 改为 H1–H6 下拉；末尾的图片/自动链接由 D6 追加。）

### D2：插入逻辑收在纯函数 `applyMarkdownAction`

- `strikethrough` 复用 `wrap('~~','~~')`。
- `task-list` 复用 `prefixLines('- [ ] ')`，与 `list-bullet`/`list-ordered` 一致，支持整段多行加/去前缀切换。
- 新增 `insertBlock()`：把一段文本放在独占行，**前后补空行分隔**（`leadingBlankLines` / `trailingBlankLines`）。空行必不可少：`---` 紧贴文本行会被 marked 解析成 setext 二级标题，GFM 表格少空行会并进正文，单 `\n` 分隔会让阅读页渲染成源码或错位标题——此行为由阅读页渲染往返测试锁定。`horizontal-rule` 与 `table` 都经它插入。
- 新增 `insertTable()`：用 `insertBlock` 插入 GFM 模板（`| 列1 | 列2 | 列3 |` + 分隔行 + 一行占位 `内容`），并把光标定位到首数据单元格「内容」上，方便直接改写。

### D3：i18n 键镜像补全

`richEditor.*` 命名空间中英各加 `strikethrough` / `taskList` / `table` / `horizontalRule` 四个键，保持 zh-CN / en 镜像一致（i18n:check 门禁保障）。

### D4：不新增 H1 与插入图片（已被 D5/D6 取代）

首轮只选了上述四类（强调「最常用」），当时把 H1 与 `![alt](url)` 列为「按需再补」。第二轮用户明确要求补齐，故本条被 D5（标题下拉含 H1）/D6（插入图片）取代，原本的保留理由不再适用。

### D5：标题 H1–H6 改为下拉选择器

原 `header-2` / `header-3` 两个独立按钮，替换为单个 `heading` 分组项（`EditorToolbarHeading`），渲染为 `<select>` 下拉，选项 H1–H6，选中即派发 `header-<level>` 动作。`EditorToolbarAction` 类型仍保留 `header-1`…`header-6` 全部取值，下拉只是 UI 聚合，不新增动作语义。

标题动作用**设置级别**语义（`applyHeading`）：先剥掉行首已有的 `^#{1,6} ` 前缀，再按所选级别重新加前缀——`## 小节` 选 H1 得 `# 小节`，选同一级别为幂等（不切换、不叠加前缀）。这与「下拉选级别」的预期一致；列表/引用等仍沿用 `prefixLines` 的切换语义（它们本来就是开关型按钮）。

数据模型随之从「扁平 `{action,labelKey}` 数组」扩展为 `EditorToolbarItem = EditorToolbarButton | EditorToolbarHeading` 联合类型；`EditorFormatToolbar` 按 `'heading' in item` 判别渲染按钮或下拉。`AdminMarkdownEditor` 的 `onToolbarAction(action)` 直接透传字符串，无需改动。`AdminRichEditor` 不引用本工具栏，不受影响。

### D6：新增「插入图片」与「自动链接」按钮

| action | 插入语法 | 标签键 |
|---|---|---|
| `image` | `![文字](https://)`（包裹选中为 alt，无选中用占位「图片描述」） | `richEditor.image` |
| `autolink` | `<url>`（包裹选中为尖括号链接，无选中插入 `<https://>`） | `richEditor.autoLink` |

`autolink` 带 URL 判别（`looksLikeUrl`：`https?://` / `www.` / `mailto:` 开头）：选中内容不符合 URL 特征时回退为普通链接形式 `[文字](https://)`——尖括号包普通文字会渲染成字面文本，属废按钮失败模式，此守卫由阅读页渲染往返测试锁定。`www.` 开头先补 `http://` 再包尖括号——GFM 尖括号 autolink 要求 scheme，`<www.x.com>` 直接包会渲染出畸形 HTML（尖括号残留、`>` 被吞进 href，实测确认），补 scheme 后为干净锚点。

两者均走 `applyMarkdownAction` 的 `wrap` 分支，marked 已能渲染（`<url>` 行内链接语法与裸 URL 自动链接一致），与阅读页渲染一致。

### D7：不新增高亮 `==` 与脚注 `[^1]`

`marked@18` 启用 GFM 但**不含** footnote / highlight 扩展（`node_modules/marked/lib` 无相关模块），`==文字==` 与 `[^1]` 在阅读页渲染中不会被渲染（显示为源码）。若加按钮，作者插了却看不到效果，属废按钮。故本轮不加；若要支持，需单独扩展 `renderMarkdown`（加 `marked-footnote` 等插件）并确认移动端渲染行为，列为独立任务，不在本 ADR 范围。

## 后果（Consequences）

- 描述、注释、附注等所有 `AdminMarkdownEditor` 场景的作者，现可一键插入：H1–H6（下拉）、粗体、斜体、删除线、引用、行内代码、代码块、无序/有序/任务列表、表格、分割线、链接、图片、自动链接；其中 GFM 语法与阅读页渲染一致。
- `applyMarkdownAction` 仍是纯函数，新增动作有单测锁定（`tests/unit/client/markdown-actions.test.ts`）；工具栏控件数量与标签有 `tests/unit/components/editor-format-toolbar.test.ts` 动态断言（按钮数 + 下拉数 == `EDITOR_TOOLBAR_ACTIONS.length`）。
- **阅读页渲染往返测试**（`tests/unit/client/markdown-reader-render.test.ts`）：对**每个**工具栏动作走「插入 → `renderMarkdown` → 断言 HTML」全链路，覆盖 `<del>`/`<hr>`/`<table>`/复选框/`<img>`/`<a>`/H1–H6/粗斜体/行内代码/列表/代码块/引用，确保按钮插入的语法在阅读页真实渲染、无残留源码。该测试抓出并固定了三个缺陷：hr 紧贴文本行变 setext 标题（D2 空行分隔修复）、autolink 包裹非 URL 产出字面文本（D6 URL 判别回退）、标题下拉叠加前缀（D5 设置级别语义）。
- 后端接口完全不动：这些仅是 Markdown 源码字符串的便捷插入，存盘/下发形态与 ADR-0029/0032 一致。
- 工具栏控件总数：原 10 按钮 → 首轮 +4（14）→ 本论替换 2 个标题按钮为 1 个下拉、再 +2（图片/自动链接），最终 14 按钮 + 1 下拉 = 15 控件。
- 高亮/脚注刻意不加（D7），避免阅读页不渲染的废按钮。
