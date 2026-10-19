# ADR-0035: Markdown 编辑器预览改用成熟预览组件（修订 ADR-0034 D1）

- 状态：Accepted
- 日期：2026-10-17
- 决策人：用户（「右下角那个位置不是原文，是预览；要评估是否需要 Markdown 预览组件请安装」）
- 关联决策：ADR-0031（标注标记迁移到 Markdown 编辑器）、ADR-0032（注释/附注升级为 Markdown 编辑器）、ADR-0034（预览改原文回显——其 D1 由本 ADR 修订）、ADR-0033（工具栏常用语法按钮）

## 背景（Context）

ADR-0034 D1 把 `AdminMarkdownEditor` 的预览区从「marked 转 HTML + `dangerouslySetInnerHTML`」改成了只读原文回显，理由是「admin 不做 HTML 转换」。用户随即纠正：**右下角那个位置不是原文，是预览**——预览是 Markdown 编辑器对内容的渲染预览；手搓的 marked 转换链路（`renderMarkdown` + `dangerouslySetInnerHTML`）才是被废弃的过程，预览本身必须保留。同时给出方向：评估是否需要 Markdown 预览组件，需要就安装。

评估两个候选（事实均经查证）：

| 维度 | `@uiw/react-markdown-preview@5.2.1` | `react-markdown@10` 裸装 |
|---|---|---|
| 与项目所用技术 | 与 `AdminCodeEditor` 同门（`@uiw/react-textarea-code-editor` 已在用） | 无关联 |
| GFM | 内置 `remark-gfm`——工具栏插入的表格/任务列表/删除线/自动链接开箱渲染 | 需自接 `remark-gfm` |
| 排版样式 | 自带（随包注入 `styles/markdown.css`）+ prism 代码高亮 | 全裸，需自写全套 CSS |
| 原始 HTML | 默认渲染（`skipHtml` 默认关）——与项目既有 HTML 源码模式同信任级 | 默认剥离 |
| React 18 | peer ✓ | peer ✓ |

## 决策（Decision）

### D1：安装 `@uiw/react-markdown-preview` + `remark-breaks`，替换手搓链路

`yarn add @uiw/react-markdown-preview remark-breaks@^4.0.0`（版本兼容经核验：`remark-breaks@4` 依赖 `unified ^11` / `@types/mdast ^4`，与包内 `react-markdown@10.1.0` 同代次）。预览区改渲染 `<MarkdownPreview source={value} remarkPlugins={[remarkBreaks]}/>`，空内容时显示空态提示，不留空白框。ADR-0034 D1 的只读回显块删除。

### D2：`remark-breaks` 让预览换行与阅读页一致

阅读页 marked 开了 `breaks: true`（单换行转 `<br>`，作者按行写作）；remark 默认软换行。预览配 `remark-breaks` 后两边换行观感一致，避免预览与阅读页在同一种写法上给出不同形态。

### D3：暗色经 `data-color-mode` 桥接

预览组件的暗色开关是 `data-color-mode` 属性，与 admin 的 `.dark` 类不同源。`applyAdminTheme` 已将解析后的明暗写入 `<html data-color-mode>`，故 `AdminMarkdownEditor` 以 MutationObserver 观察该属性并传入 `wrapperElement`——用户切换、系统偏好变化均能跟随，且不依赖主题从何而来。

### D4：已知取舍——预览与阅读页不同源

预览与阅读页用的是不同渲染器（前者 remark，后者 marked）：GFM 常规语法两边一致，边缘语法存在差异。让阅读页也切 remark 是影响线上的大改动，不做。此为采用成熟预览组件的固有取舍——换来的是排版样式、代码高列、无 `dangerouslySetInnerHTML` 注入面（React 树渲染）与持续维护。

### D5：保存与接口语义不变

「Markdown 原文保存」「接口原样返回」（ADR-0034 D2/D3）继续成立——本次只改 admin 显示层，存储链路、`reads.ts`、阅读页渲染链均不动。`markdownHint` / `markdownHintApp` 文案陈述的是保存与接口，仍然准确，不随本次改动。

## 后果（Consequences）

- admin 预览恢复为渲染预览：作者键入的语法（含工具栏插入的全部 GFM 语法）即时看到最终形态，空内容有空态提示。
- `dangerouslySetInnerHTML` 与手搓 marked 转换从 admin 消失；`marked` 在 admin 仅存于 `AdminRichEditor` 的 `editorBody`（可视化编辑器内部需要 HTML 形态）。
- 新增依赖 18 个包（含 prism 高亮族），admin 后台场景体积不敏感；peer 警告中的 `@wangeditor/*` 为预存遗留（代码已无引用），与本次无关。
- 预览测试新增 `tests/unit/components/admin-markdown-editor-preview.test.ts`（锁定组件选用、source 同步、空态）；`markdown-reader-render.test.ts` 继续守护阅读页渲染。
- ADR-0034 D1（只读回显）标注为本 ADR 所修订；ADR-0032 D5 的「原文回显」描述同步改为渲染预览。
