-- 0094: items 加表达式索引，消除「按篇章取条文」查询的排序临时表
--
-- 背景：src/server/feed/extVolume.ts 的卷面板查询按
--   `WHERE tcm_parent_id IN (...) AND status != 3 ORDER BY COALESCE(receiptNo, no), id`
-- 取某篇章下的全部条文。条文(sections) 按 receiptNo 排序；yao/term 这类无 receiptNo
-- 的条目退回 `no`（与书页目录 getTcmBookEntries 排序键一致）。
--
-- 旧写法 ORDER BY 以 COALESCE(...) 打头、不含 tcm_parent_id，与「按 parent 聚集」
-- 的索引序不兼容，SQLite 只能 `USE TEMP B-TREE FOR ORDER BY` 重新排序——篇章一多
-- 就是一次全量排序。
--
-- 修复（D1 官方：为 WHERE/ORDER BY 建索引）：
--   1) 索引第三列补 `id`，使索引序与 ORDER BY 完全一致；
--   2) ORDER BY 改为以 `tcm_parent_id` 打头——调用方取回后按 tcm_parent_id 重新分组、
--      只保留组内相对顺序，故「全局序改为先按 parent」不改变任何篇章内部的条文顺序
--      （正确性不变），但让索引序与 ORDER BY 一致，排序被消除。
--
-- 验证（node:sqlite EXPLAIN QUERY PLAN）：
--   改后 `SELECT ... WHERE tcm_parent_id IN (...) AND status != 3
--         ORDER BY tcm_parent_id, COALESCE(...), id`
--   → `SEARCH items USING INDEX items_section_order (tcm_parent_id=?)`，
--     不再出现 `USE TEMP B-TREE FOR ORDER BY`（单 parent / 多 parent 皆然）。
--
-- `data` 仍是唯一事实来源；纯索引，不改写入路径。

CREATE INDEX IF NOT EXISTS items_section_order
  ON items (
    tcm_parent_id,
    COALESCE(
      json_extract(data, '$._microfeed.receiptNo'),
      json_extract(data, '$._microfeed.no')
    ),
    id
  );
