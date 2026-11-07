# AdminMarkdownPreview：后台只读 Markdown 预览组件

> 位置：`src/components/admin/shared/AdminMarkdownPreview/index.tsx`
> 复用方：`fang-yao` / `ming-ci` / `zhong-yao` / `book-chapter` 四个独立模块的详情页只读态。

## 1. 为什么需要这个组件

`@uiw/react-markdown-preview`（下称预览库）默认行为会让「长段落 + 古籍缩进」的正文**横向撑破容器**：整页出现一条向右的滚动条，内容一直往右拉伸，而不是按页面宽度换行。四个模块的详情页只读态都踩同一个坑，于是把「预览 + 三层防御」封装成共享组件，调用方一行搞定。

横向撑破的根因有两层，缺一层就修不干净：

### 根因 A：数据形态——古籍缩进被当成代码块

中医正文（方文 / 本草 / 名词 / 卷章正文）里**几乎所有长段落都以 6-8 个空格缩进**（古籍排版习惯，不是 tab）。Markdown 规范里「空行 + 4 空格以上缩进」会被解析成**缩进代码块 `<pre><code>`**。预览库的 `markdown.css` 给 `pre > code` 设了 `white-space: pre`（不换行），于是这些几百字的长段落整段不折行，横向撑破页面。

以小柴胡汤 `fy000000335` 为例：「      原本伤寒论里面…」一段 740 字符，多个这样的段落叠一起，整页必然横向溢出。

### 根因 B：CSS Cascade Layers——普通覆盖压不过它

第一直觉是给 `pre`/`code` 加 Tailwind 的 `whitespace-pre-wrap`。但**加了没效果**，原因是 CSS Cascade Layers：

- 预览库的 `markdown.css` **完全未分层**（全文 0 个 `@layer`），规则是「未分层普通规则」；
- Tailwind v4 的 utilities 生成在 `@layer utilities` 里。

CSS 规范：**未分层普通规则的优先级高于任何 `@layer` 内的规则，并且压倒 specificity**。所以无论把 Tailwind 类的选择器写得多具体，只要它在 `@layer utilities` 里，就赢不了 `markdown.css` 里未分层的 `white-space: pre`。

结论：**残留的 `pre > code` 必须用 `!important` 才能跨层盖过**。Tailwind v4 的 `!important` 语法是类名末尾加 `!`（如 `whitespace-pre-wrap!`），生成 `white-space: pre-wrap !important`。

## 2. 三层防御

组件内部叠加三层手段，从源头到兜底逐层收口：

| 层 | 手段 | 作用 | 兜的是什么 |
|---|---|---|---|
| ① 源头 | `remarkNoIndentedCode` remark 插件 | 把**非围栏**缩进代码块还原成普通段落（行间补 break 保留换行），随正文按容器宽换行 | 根因 A：古籍缩进段落 |
| ② 跨层 | `[&_.wmde-markdown_pre_code]:whitespace-pre-wrap!` | `!important` 跨层盖过 `markdown.css` 的 `white-space: pre` | 根因 B：任何漏网的 `pre > code` |
| ③ 逐层约束 | 根容器 / `.wmde-markdown` / `pre` / `table` / `img` 全部 `min-w-0` + `max-w-full` + `overflow-x-auto` | 压回容器宽，超长内容在容器内滚动，不撑破页面 | 真围栏代码块、超宽表格、大图 |

`remarkNoIndentedCode` 的判定细节（`AdminMarkdownEditor/remarkNoIndentedCode.ts`）：visit `code` 节点，看源码起始行——若匹配 `/^ {0,3}(```|~~~)/`（≤3 空格缩进的围栏开头）**保留**；否则当缩进代码块，整段转成 paragraph，每行之间插 `{type:"break"}`。真正的围栏代码块（作者主动用 ``` 包裹）原样保留。

> 编辑态为何一直没事？`AdminMarkdownEditor` 的预览区不碰 `white-space`，只用 `[&_pre]:max-w-full + overflow-x-auto`。`markdown.css` 对 `pre` **没有**未分层的宽度规则（`width:max-content` 只设在 `table`），所以不存在层冲突，pre 被正常约束在容器内滚动。这也正是只读态要对齐的目标观感。

## 3. API

```tsx
export interface AdminMarkdownPreviewProps {
  /** Markdown 源码，原样渲染不改写（$ 标记等原样呈现） */
  source: string;
  /** 附加到外层容器的 class（例如外间距）；逐层约束 class 始终保留 */
  className?: string;
}
```

组件行为：

- 内部自带 `useColorMode()`，自动把明暗写入 `wrapperElement` 的 `data-color-mode`，跟随 `<html data-color-mode>`。**调用方无需再取 colorMode。**
- `remarkPlugins` 固定为 `[remarkBreaks, remarkNoIndentedCode]`：`remark-breaks` 让单换行转 `<br>`（与阅读页 marked `breaks:true` 观感一致），`remarkNoIndentedCode` 做防御 ①。
- **原样渲染不改写**：`$f{}` / `$u{}` / `$g{}` / `$m{}` 等 TCM 互参标记、按语等一律原样呈现，不做解析或改写——正文逐字存储，预览只改显示不改数据。

## 4. 使用示例

### 4.1 最简用法（四模块通用）

```tsx
import AdminMarkdownPreview from "@/components/admin/shared/AdminMarkdownPreview";

// 详情页只读态，直接传源码即可
<AdminMarkdownPreview source={selectedFormula.fangText} />
```

### 4.2 需要外间距时传 className

`className` 只追加到外层容器，逐层约束 class 始终保留，不会被覆盖：

```tsx
<AdminMarkdownPreview source={selectedHerb.zhongYaoText} className="mt-2" />
```

### 4.3 与「折叠开关」配合（book-chapter 模式）

book-chapter 详情页有两个只读开关（`SHOW_FULL_BODY_TEXT_IN_DETAIL` 控正文、`SHOW_BODY_NOTE_IN_DETAIL` 控注释），关闭时退回单行摘要。开关打开才渲染完整预览：

```tsx
{SHOW_FULL_BODY_TEXT_IN_DETAIL ? (
  <AdminMarkdownPreview source={body.sectionText} />
) : (
  <BodyTextPreviewLine text={body.sectionText} />
)}

{SHOW_BODY_NOTE_IN_DETAIL && body.sectionNote && (
  <AdminMarkdownPreview source={body.sectionNote} />
)}
```

### 4.4 带标签的 dl 字段（fang-yao / ming-ci / zhong-yao 模式）

详情字段常放在 `<dl>` 里，预览包在 `<dd>` 中：

```tsx
<dl className="mt-2 space-y-2 text-sm">
  <div>
    <dt className="text-muted-foreground">{t("fangYao.fangTextLabel")}</dt>
    <dd className="mt-1">
      <AdminMarkdownPreview source={selectedFormula.fangText} />
    </dd>
  </div>
</dl>
```

## 5. 已覆盖模块

| 模块 | 渲染字段 | 调用处 |
|---|---|---|
| fang-yao | `selectedFormula.fangText`（方文） | `FangYaoApp.tsx` |
| ming-ci | `selectedNoun.mingCiText`（名词正文） | `MingCiApp.tsx` |
| zhong-yao | `selectedHerb.zhongYaoText`（本草正文） | `ZhongYaoApp.tsx` |
| book-chapter | `body.sectionText`（正文）+ `body.sectionNote`（注释） | `BookChapterApp.tsx`（两处） |

新增模块若详情页要渲染 Markdown 只读正文，**一律复用本组件**，不要再手写 `MarkdownPreview` + 防御 class + colorMode——那会把这套横向撑破防御复制散落到多处，一旦要调就漏。

## 6. 相关

- 编辑态 counterpart：`src/components/admin/shared/AdminMarkdownEditor/`（源码编辑 + 实时预览 + 标注工具栏）。
- ADR-0035：预览改用成熟组件 `@uiw/react-markdown-preview` + `remark-breaks`。
- ADR-0062 D7 / 格式保真：正文逐字存储、预览只改显示不改数据。