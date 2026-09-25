# 04: 端点 4（章节详情，正文原样 + 格式标识）

**What to build:** 按章节 id 取到正文。正文是**库里存的原始内容**（不被转换），
并附带格式标识；书已下架时其章节**立刻读不到**。

**Blocked by:** 01

**Status:** done (2026-09-24)

- [ ] 新建端点 `GET /api/v1/content/chapters/{chapterId}/`
- [ ] `{chapterId}` 用 `getIdFromSlug()` 解析（与既有 `/api/v1/items/{itemId}/` 同一套）
- [ ] 取数用 `FeedDb.getItemById(id, [STATUSES.PUBLISHED])`——**不复用** `/api/v1/items/{itemId}/`
      （后者含草稿且正文经 `bodyToHtml` 转换过）
- [ ] **校验所属书已发布**：`getBookById(db, chapter._microfeed.bookId)` 返回 null → 404
      （避免下架书的内容仍可单章读到）
- [ ] 响应白名单：`{ id, title, chapterNo, volume, contentHtml, contentFormat }`
      - `contentHtml` = `items.data.description` 的**原始值**，不 `renderMarkdown`、不 `bodyToHtml`
      - `contentFormat` = `data.contentFormat ?? data.content_format`，经 `bodyFormat()` 归一，缺省 `"html"`
      - `volume` = `_microfeed.volume`（未分卷为空串）；`chapterNo` = `_microfeed.chapterNo`（缺失为 0）
- [ ] 测试：已发布章节 → 200 且六字段齐全、`contentHtml` 与库里 `description` 逐字相同
- [ ] 测试：草稿（UNLISTED / UNPUBLISHED）章节 → 404
- [ ] 测试：**所属书未发布** → 404（即使章节本身是 PUBLISHED）
- [ ] 测试：章节不存在 → 404
- [ ] `yarn typecheck` + `yarn test` 通过
