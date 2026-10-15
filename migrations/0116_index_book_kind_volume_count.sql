-- 0116_index_book_kind_volume_count.sql
--
-- 把 `items_book_kind` 原地重建，末尾追加 `tcm_parent_id`。
--
-- 动机：后台卷看板改为「点书只见卷」后，逐卷条数要一次给出
--   WHERE book_id = ? AND tcm_kind != 'chapter' AND status != 3
--   GROUP BY tcm_parent_id, tcm_kind
-- 这条分组查询必须不回表：追加 `tcm_parent_id` 后，`book_id`、`tcm_kind`、`status`、
-- `tcm_parent_id` 四个被引用的列全部在索引里，SQLite 只步进索引条目。
-- `tcm_kind != 'chapter'` 而不是 `= 'section'`：中药 / 名词书挂在篇章下的 `yao`、`term`
-- 行也要计进所属卷，与展开该卷时读到的条目同一口径。
--
-- 沙箱实测（《黄帝内经・素问》81 卷 / 2,883 条条文，干净副本、不跑 ANALYZE）：
--   ① 逐卷计数分组   `SEARCH items USING COVERING INDEX items_book_kind (book_id=?)`、
--      0 次回表、81 组 / 4,208 字节 / 中位 0.625 毫秒
--      （分组键排在 `pub_date` 之后，索引序给不出分组序，因此带一次
--        `USE TEMP B-TREE FOR GROUP BY`；同一条件在四列旧索引下走 `items_book_id`
--        并逐行回表，中位 3.817 毫秒。它取代的整本读取是 2,964 行 / 1,233,002 字节）
--   ② 最近一条条文   1 行（ADR-0025 D4 的口径，第 4 列仍是 `pub_date`，不变）
--   ③ 书页整本条数   不变
--
-- 取舍的完整理由（为什么接受那条临时 B-tree、为什么篇章查询不带 `status != 3`、
-- 为什么标签书不加派生列）见 ADR-0027。
--
-- 前四列顺序不能动：`pub_date` 必须在第 4 位。把它挪到 `tcm_parent_id` 之后会让
-- 「最近一条条文 1 行」的 ORDER BY 退回按 status 前缀扫全表，实测 8,348 行。
--
-- 为什么沿用同名原地重建、不开第二条索引：与迁移 0112 同样做法，`items` 上的
-- 索引个数不变（仍 23 条），写入只多维护一列；新名字会让旧索引继续占写入开销。
--
-- 回滚：
--   DROP INDEX IF EXISTS items_book_kind;
--   CREATE INDEX items_book_kind ON items (book_id, tcm_kind, status, pub_date);

DROP INDEX IF EXISTS items_book_kind;

CREATE INDEX IF NOT EXISTS items_book_kind
  ON items (book_id, tcm_kind, status, pub_date, tcm_parent_id);
