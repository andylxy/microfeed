# 05: 内容 API 端点 4 —— 章节详情（正文原样）

**What to build:** `GET /api/v1/content/chapters/{chapterId}/` 返回单章详情，`contentHtml` 是
**数据库里存的原文**（不渲染 markdown、不重排版），并带 `contentFormat` 告知格式。
章节不存在、非已发布、**或所属书未发布** → **404**。

**Blocked by:** 01、04

**Status:** ready-for-agent

## 实现要点

- **端点**：`src/pages/api/v1/content/chapters/[chapterId]/index.ts`，导出 `GET`。
- **登记**：
  - `integrationSuffix()` 的 `!legacy && (...)` 内加
    `/^content\/chapters\/[^/]+\/$/u.test(suffix)`。
  - `DOMAIN_RULES` 加 `{prefix: "content/chapters", read: "content:article:read",
    write: "content:article:read"}`（`article` 即章节，沿用既有码，不重命名）。
- **`{chapterId}` 解析**：`getIdFromSlug()`（`src/shared/StringUtils.ts:309`）——
  接受 `{slug}-{11 位 id}` 与裸 11 位 id。
- **取数**：
  1. `FeedDb.getItemById(id, [STATUSES.PUBLISHED])`（`FeedDb.ts:510`）—— 显式只取已发布；null → 404。
  2. **校验所属书**：`getBookById(db, item._microfeed.bookId)`（`extCategory.ts:449`）——
     返回 null（书不存在或未发布）→ **404**。防止下架书的内容仍可单章读到。
- **响应白名单**：`{ id, title, chapterNo, volume, contentHtml, contentFormat }`。
  - `contentHtml` = `item.description`（`getItemById` 把 `data` 摊平，所以是 `description`）
    —— **原始值，不 `renderMarkdown`、不 `bodyToHtml`**。
  - `contentFormat` = `bodyFormat(data.contentFormat ?? data.content_format)`
    （`src/shared/BodyFormat.ts:35`），缺省 `"html"`。
  - `volume` 取 `_microfeed.volume`（未分卷为**空串**）；`chapterNo` 取 `_microfeed.chapterNo`
    （缺失为 **0**）。
- **OpenAPI**：登记该端点 + 同步翻译表。

## Acceptance criteria

- [ ] `yarn typecheck` + `yarn test` 通过
- [ ] `requiredApiPermission("/api/v1/content/chapters/abc/", "GET")` === `"content:article:read"`
- [ ] worker 测试：持 `content:article:read` 的凭证 → `allow`
- [ ] worker 测试：无该权限 → `forbidden`（403）
- [ ] worker 测试：响应只含 `id` / `title` / `chapterNo` / `volume` / `contentHtml` / `contentFormat` 六个键
- [ ] worker 测试：**正文原样** —— 构造一个正文含 markdown 标记（如 `# 标题`）的章节，
      断言 `contentHtml` **逐字节等于** DB 里的 `data.description`（即未被渲染成 `<h1>`）
- [ ] worker 测试：格式缺省时 `contentFormat === "html"`；显式 markdown 时为 `"markdown"`
- [ ] worker 测试：不存在的章节 → **404**；草稿章节 → **404**
- [ ] worker 测试：**所属书未发布** → **404**（构造"章节已发布但书未发布"的数据）
- [ ] worker 测试：`volume` 缺失时为空串、`chapterNo` 缺失时为 `0`
- [ ] `tests/unit/openapi.test.ts` 三条通过
