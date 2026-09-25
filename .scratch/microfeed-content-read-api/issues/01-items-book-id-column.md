# 01: items.book_id 落列 + 回填 + 写入同步 + 双读

**What to build:** `items` 表新增 `book_id` 真实列与索引，把"章节属于哪本书"从 JSON 内部
提升为可索引的列。新建/更新的章节自动写入该列；老数据（`book_id` 为 NULL）仍能被正常读到。
完成后，按书取章节从"必然全表扫描"变成可走索引。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

## 为什么先做

它是后续四个端点的**前置设施**：端点 3/4 都要"按书取章节"。放在最前做，
让后面的端点直接受益，避免先写扫描版再改。

## 实现要点

- **迁移**：`ALTER TABLE items ADD COLUMN book_id TEXT` + `CREATE INDEX items_book_id`（新号段 `0056`）。
- **回填**：`UPDATE items SET book_id = json_extract(data, '$._microfeed.bookId')`。
  （实测 D1 **支持**该 `json_extract` 路径形式；`SQLITE_ERROR 7500` 是 wrangler CLI 不支持 `?`
  占位符所致，与 SQL 无关 —— 所以回填**直接写 SQL**，不必绕到应用层。）
- **写入同步**：加在 `_putItemToContentStatement()`（`src/server/feed/FeedDb.ts:584`）——
  那里已有 `review_status` 的**同一套镜像模式**（从 `data._microfeed` 推导、JSON 仍是 SSOT）：
  ```ts
  const bookId = typeof microfeed?.bookId === "string" ? microfeed.bookId : null;
  ```
  加进 `keyValuePairs` 即可，覆盖 item 创建/更新/导入的所有路径（它们是同一保存入口）。
- **双读**：`getBookChapters()`（`src/server/feed/extCategory.ts:509`）改为优先
  `WHERE book_id = ?`，缺失时回退 JSON 解析，**保证不丢章节**（老数据在回填前/回填失败时仍可读）。

## Acceptance criteria

- [ ] `yarn typecheck` + `yarn test` 通过
- [ ] 迁移在远程 D1 应用成功，`PRAGMA table_info(items)` 含 `book_id`，`items_book_id` 索引存在
- [ ] 回填后 `SELECT COUNT(*) FROM items WHERE book_id IS NOT NULL` ≥ 已发布+未发布中带 `_microfeed.bookId` 的行数
- [ ] 新建/更新一个带 `_microfeed.bookId` 的章节后，该行的 `book_id` 列被写入正确值
- [ ] `getBookChapters(db, bookId)` 对**有** `book_id` 与 `book_id` 为 NULL 的两类数据
      **返回同一批章节**（双读等价，测试锁定）
- [ ] 把某行 `book_id` 手动置 NULL，`getBookChapters` 仍能取到该章节（回退路径生效）
