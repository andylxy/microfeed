-- 0095: items 加两个表达式索引，消除「按书取条目 / 按书取方剂」查询的排序临时表
--
-- 背景：
--   * src/server/feed/extCategory.ts 的 getTcmBookEntries（书页目录，平铺型
--     TCM 书：中药 / 名词）按
--       `WHERE book_id = ? AND tcm_kind NOT IN ('chapter','section','fang')
--        AND status != ? ORDER BY json_extract(data,'$._microfeed.no'), id`
--     取某本书的全部条目。
--   * 同文件 getTcmBookFang（书页「附：方剂」区块）按
--       `WHERE tcm_kind = 'fang'
--        AND json_extract(data,'$._microfeed.sourceBookId') = ?
--        AND status != ? ORDER BY json_extract(data,'$._microfeed.no'), id`
--     取某本书的方剂。
--   两者排序键都是 `_microfeed.no`（源序），但前置谓词不同：
--     getTcmBookEntries 以真实列 `book_id` 单值等式过滤；
--     getTcmBookFang 以 `tcm_kind='fang'` + `sourceBookId` 表达式等式过滤。
--   旧写法 ORDER BY 以 `json_extract(no)` 打头，没有可用索引序，SQLite 只能
--   `USE TEMP B-TREE FOR ORDER BY` 重新排序。
--
-- 修复（D1 官方：为 WHERE/ORDER BY 建索引）：
--   两个查询的 ORDER BY 都是 `json_extract(no), id`，且前置列都是单值等式
--   （book_id=? / tcm_kind=? AND sourceBookId=?），故把排序表达式放到索引尾列，
--   索引序与 ORDER BY 完全一致，排序被消除，无需改 SQL 的 ORDER BY（与 0094 不同：
--   0094 的章节查询是 `tcm_parent_id IN (...)` 多值，须把 leading 列写进 ORDER BY
--   再在 JS 重新分组；本处是单值等式，索引序直接可用）。
--
--   1) items_book_entries_order (book_id, json_extract(no), id)
--      —— getTcmBookEntries：`book_id=?` 单值等式后，序即 `json_extract(no), id`。
--   2) items_fang_order (tcm_kind, json_extract(sourceBookId), json_extract(no), id)
--      —— getTcmBookFang：`tcm_kind='fang' AND sourceBookId=?` 双等式后，序即
--        `json_extract(no), id`。
--
--   `tcm_kind NOT IN (...) / status != ?` 是索引未覆盖的残留过滤，命中索引后仍逐行
--   跳过，不改变顺序；真实列 `data` / `pub_date` 不在索引里，按需回表取。
--
-- 验证（node:sqlite EXPLAIN QUERY PLAN）：
--   getTcmBookEntries → `SEARCH items USING INDEX items_book_entries_order (book_id=?)`
--   getTcmBookFang    → `SEARCH items USING INDEX items_fang_order (tcm_kind=? AND <expr>=?)`
--   两者均不再出现 `USE TEMP B-TREE FOR ORDER BY`。
--
-- `data` 仍是唯一事实来源；纯索引，不改写入路径。

CREATE INDEX IF NOT EXISTS items_book_entries_order
  ON items (
    book_id,
    json_extract(data, '$._microfeed.no'),
    id
  );

CREATE INDEX IF NOT EXISTS items_fang_order
  ON items (
    tcm_kind,
    json_extract(data, '$._microfeed.sourceBookId'),
    json_extract(data, '$._microfeed.no'),
    id
  );
