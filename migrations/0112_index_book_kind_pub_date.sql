-- 0112_index_book_kind_pub_date.sql
--
-- 把 `items_book_kind` 原地重建，末尾追加 `pub_date`。
--
-- 动机：书页头部要显示「最近更新」，即
--   WHERE book_id = ? AND tcm_kind = 'section' AND status = 1
--   ORDER BY pub_date DESC LIMIT 1
-- 现状实测 **8,348 rows_read** —— 规划器选中 `items_status_pub_date(status=?)`
-- 按 status 前缀扫全表，再 `USE TEMP B-TREE FOR ORDER BY`。这比书页整页
-- （≈1,051）还贵 8 倍，也是「卷优先改造」要顺手解决的一项。
--
-- 追加 `pub_date` 后，规划器用 `items_book_kind (book_id=? AND tcm_kind=? AND status=?)`
-- 定位到本书、按索引内已排好的 `pub_date` 取第一行，**无 TEMP B-TREE**。
--
-- 沙箱实测（干净副本、不跑 ANALYZE）：
--   ① 最近一条条文   8,348 → 1
--   ② 该书条数 COUNT    813 → 813（不变）
--   ③ 篇章目录           28 → 28（不变；这是「该书 27 行篇章」的查询，与「卷列表」的 55 不是同一项，勿混）
--
-- 为什么不是「新增一条 (book_id, pub_date) 索引」：实测那样只降到 1,625 ——
-- 带 `tcm_kind` 过滤时规划器仍选 `items_book_kind` + TEMP B-TREE，新索引用不上。
-- 原地重建沿用同名，索引个数不变（`items` 仍 23 条），写入只多维护一列。
--
-- 回滚：
--   DROP INDEX IF EXISTS items_book_kind;
--   CREATE INDEX items_book_kind ON items (book_id, tcm_kind, status);

DROP INDEX IF EXISTS items_book_kind;

CREATE INDEX IF NOT EXISTS items_book_kind
  ON items (book_id, tcm_kind, status, pub_date);
