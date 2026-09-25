# 03: 端点 3（卷 → 章两级目录，含截断）

**What to build:** 按书 id 一次拿到「卷 → 章」两级目录。书不存在或未下架时 404；
目录超长时给硬上限并明确告知被截断。

**Blocked by:** 01

**Status:** done (2026-09-24)

- [ ] 新建端点 `GET /api/v1/content/books/{bookId}/chapters/`
- [ ] 用 `getBookById(db, bookId)` 校验书**已发布**（返回 null → 404）并取 `book.title`
- [ ] 章节集合用 `getBookChapters(db, bookId, baseUrl)`（已实现「仅已发布 + 归属 + 排序」）
- [ ] 卷分组**复用 `listVolumeBoard`（`extVolume.ts:98`）的分组规则**：
      桶按 `volume` 名；组序 `volumeOrder` ?? 首章 `chapterNo` → 首章 `pub_date` → id；
      未分卷（空名）桶恒排最后。**不要直接调 `listVolumeBoard`**（它含草稿且 JS 过滤 bookId），
      也**不在 API 层另写第三套分组逻辑**
- [ ] **截断在分组前**：先把 `getBookChapters` 的扁平有序列表截到前 **5000** 条，再分组
- [ ] 响应白名单：`{ book: {id, title}, truncated, volumes: [{ name, chapters: [{id, title, chapterNo, pubDate?}] }] }`
      （不带出 `status` / `web_url` / `wordCount` / `_microfeed` / `...data` 其他字段）
- [ ] 测试：已发布书 → 200，两级结构正确，未分卷桶排最后
- [ ] 测试：书不存在或未发布 → 404
- [ ] 测试：目录**不含草稿**
- [ ] 测试：超上限时 `truncated: true` 且章节数恰为上限（用小规模阈值验证逻辑）
- [ ] `yarn typecheck` + `yarn test` 通过
