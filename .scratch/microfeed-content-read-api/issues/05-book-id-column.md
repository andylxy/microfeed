# 05: `items.book_id` 真实列 + 回填 + 查询双读

**What to build:** 把章节与书的关联从 JSON 内部搬到真实列并建索引，让「按书取章节」
不再依赖全表扫描。这是**面向规模的提前准备**（当前 32 篇无可测量收益），但明确在本次范围内，
避免章节量上来后静默退化成扫描。

**Blocked by:** 03（改造点是 `getBookChapters`，端点 3 已在其上建好）

**Status:** done (2026-09-24)

- [ ] 新增迁移：`ALTER TABLE items ADD COLUMN book_id TEXT` + `CREATE INDEX items_book_id`
- [ ] 迁移内回填：`UPDATE items SET book_id = json_extract(data, '$._microfeed.bookId')`
      （实测 `json_extract` 在 D1 可用；不要再信 `extCategory.ts:509` 那条已被证伪的注释）
- [ ] 写入路径同步：`_microfeed.bookId` → `book_id`（item 创建/更新 handler、导入章节）
- [ ] **查询双读**：优先 `WHERE book_id = ?`，缺失时回退 JSON 解析，**保证不丢章节**
- [ ] 改造 `getBookChapters`（公开读路径唯一入口）走双读
- [ ] 测试：回填后 `book_id` 与 `data._microfeed.bookId` 一致，且行数与已发布数相符
- [ ] 测试：新增章节写入时 `book_id` 同步落库
- [ ] 测试：双读在 `book_id` 为空时仍能取到章节（不丢）
- [ ] `yarn typecheck` + `yarn test` 通过
