# 02: 端点 2（某标签下的书）

**What to build:** 按标签（分类）取到该标签下**已发布**的书摘要。传入的 `{categoryId}`
无论是 id 还是 slug 都能解析；分类不可见或解析不到时返回 404。

**Blocked by:** 01

**Status:** done (2026-09-24)

- [ ] 新建端点 `GET /api/v1/content/categories/{categoryId}/books/`
- [ ] `{categoryId}` 用 `getCategoryBySlugOrId(db, value)` 解析（先 id 后 slug，与公开分类页同一套）
- [ ] 解析结果取 **`.id`** 传给 `listChannelsByGenre(db, id)`（`channels.genre` 存的是分类 id）
- [ ] 分类解析不到 **或** `visible = 0` → 404
- [ ] 响应沿用 `listChannelsByGenre` 的**公开书卡形状**（即为契约）：
      `id` / `title` / `image` / `link` / `author?` / `description?`（纯文本）/
      `serialStatus?` / `serialStatusLabel?` / 字数
- [ ] 测试：按 **id** 请求 → 200 且返回该分类的书
- [ ] 测试：按 **slug** 请求 → 200（兼容）
- [ ] 测试：分类 `visible = 0` 或不存在 → 404
- [ ] 测试：该分类下**未发布的书不出现**
- [ ] `yarn typecheck` + `yarn test` 通过
