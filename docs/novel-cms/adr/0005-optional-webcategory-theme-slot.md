# ADR-0005: 主题契约新增可选的 `webCategory` 槽位

- 状态：Accepted（已确认）
- 日期：2026-09-17
- 决策人：用户（选择方案 A）

## 背景

小说站的题材分类页 `/category/<slug>` 需要一个由主题渲染的模板。但主题契约
（`src/shared/themes/ThemeContract.ts`）的 `THEME_FILE_KEYS` 里**没有分类页槽位**：

```
THEME_FILE_KEYS_V1 = webFeed, webItem, webHeader, webBodyStart, webBodyEnd, rssStylesheet
THEME_FILE_KEYS    = V1 + webPage, webSearch
```

工单 02 的实现是绕过去的：路由直接
`import DEFAULT_WEB_CATEGORY from "themes/default/web-category.mustache?raw"`，
把一个**未在 manifest 声明**的散文件硬编码进核心。后果有二：

1. 分类页永远长成 default 主题的样子，**激活主题是 `local.feed-zh` 时视觉不一致**；
2. 该文件既不受主题校验约束，也不随主题安装/打包，属事实上的死代码。

## 决策

**给主题契约新增一个可选槽位 `webCategory`**，让分类页跟随激活主题；主题不提供时
回退到内置默认模板。

"可选"是硬要求：**已发布的 v2 主题不得因为这次扩展而失效。**

## 事实依据（已核实代码）

1. `src/shared/themes/ThemeContract.ts`：`THEME_FILE_KEYS` 增 `webCategory`；
   `themeManifestV2Schema.files` 与 `storedThemeManifestV2Schema.files` 均以
   `themePathSchema.optional()` 声明；bundle schema 为 `webCategory: z.string().optional()`。
2. `src/shared/themes/ThemeValidation.ts`：v2 校验原本要求"所有 v2 模板必须提供"，
   直接加 key 会把它变成**必填**（实测一次性打挂 7 个测试）。
   故改为 `key !== "webCategory"` 时跳过该诊断。
3. `src/server/themes/Theme.ts`：新增 `hasWebCategory()` / `getWebCategory(extra)` /
   `getWebCategoryTmpl()`。
4. `src/pages/category/[slug]/index.astro`：
   `theme.hasWebCategory() ? theme.getWebCategoryTmpl() : DEFAULT_WEB_CATEGORY`。
5. 两个 manifest 各加 `files.webCategory`；default 主题的源模板移入
   `themes/default/src/templates/` 并登记进生成器的 `files` map
   （**顺带修好工单 02 那份未声明的散文件**）。

## 影响

- 分类页可跟随激活主题；不提供该槽位的主题行为**完全不变**（回退到内置默认）。
- 现有 v2 主题继续通过校验（字段可选）。
- 主题编辑器（`ThemeBundleEditor`）多一个可编辑文件条目。
- **不触碰公开 API 契约**（`ApiSchemas.ts` / `OpenApiDocument.ts`），
  符合设计 §2 铁律 #2。

## 一致性

- 与 §2 铁律 #4「公共展示全走主题」一致：分类页的**渲染**回到了主题层。
- 与 ADR-0004「可查询字段落真实列」无交互（本 ADR 只涉及主题文件槽位）。

## 备选方案（未采纳）

- **保持现状**：分类页永远用 default 主题的样子。被否——与铁律 #4 冲突，且让
  feed-zh 站点出现视觉不一致。
- **把 `webCategory` 设为必填**：会破坏所有已发布主题，明确违反升级零冲突铁律。
