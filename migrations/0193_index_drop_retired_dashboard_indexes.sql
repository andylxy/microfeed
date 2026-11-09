-- 0193_index_drop_retired_dashboard_indexes.sql
--
-- ADR-0070：清理退役看板遗留的无活跃调用索引。
--
-- ADR-0069 退役 6 个 legacy 内容看板、ADR-0068 退役 alias 模块后，`items` 上一批
-- 专为看板查询建立的索引失去了全部活跃调用方（调用链判据：服务函数 0 调用者、
-- 文件 0 导入者、或 App 查询已改走同形新索引）。本迁移删除这 5 个索引，并把
-- `items_book_kind` 回退到 0112 形态（去掉 0116 只为「卷看板逐卷计数」追加的
-- `tcm_parent_id`）。
--
-- 保留的活跃索引不受影响：`items_section_order_kind`（裸 receiptNo 排序，App 章节
-- 条文）、`items_fang_order_v2`（App 方剂）、`items_bie_ming` / `items_yao_pure_name` /
-- `items_yao_order` / `items_tcm_kind_name`（App 中药与别名）、`ix_items_book_ref_updated`
-- / `ix_items_tcm_kind_updated`（后台内容列表）。App「书页最近更新」
-- （book_id=? AND tcm_kind=? AND status=? ORDER BY pub_date DESC LIMIT 1）只用
-- `items_book_kind` 前 4 列，0112 已实测回退到 4 列形态不损该查询。
--
-- `items` 表与全部数据不删（ADR-0069 决策 1/2）；纯索引结构，不丢任何数据。
--
-- 回滚（index 类，MIG-004 不强制 -- rollback: 块）。重建全部 6 个被删/被改的索引
-- （完整定义与本地快照 .scratch/backups/retired-dashboard-indexes.json 一致）：
--   DROP INDEX IF EXISTS items_book_kind;
--   CREATE INDEX IF NOT EXISTS items_book_kind
--     ON items (book_id, tcm_kind, status, pub_date, tcm_parent_id);
--   CREATE INDEX IF NOT EXISTS items_section_order
--     ON items (tcm_parent_id,
--       COALESCE(json_extract(data,'$._microfeed.receiptNo'),
--                json_extract(data,'$._microfeed.no')), id);
--   CREATE INDEX IF NOT EXISTS items_book_entries_order
--     ON items (book_id, json_extract(data,'$._microfeed.no'), id);
--   CREATE INDEX IF NOT EXISTS items_fang_order
--     ON items (tcm_kind, json_extract(data,'$._microfeed.sourceBookId'),
--       json_extract(data,'$._microfeed.no'), id);
--   CREATE INDEX IF NOT EXISTS items_section_order_kind2
--     ON items (tcm_kind, tcm_parent_id,
--       COALESCE(json_extract(data,'$._microfeed.receiptNo'),
--                json_extract(data,'$._microfeed.no')), id);
--   CREATE INDEX IF NOT EXISTS items_source_book_id
--     ON items (json_extract(data, '$._microfeed.sourceBookId'));

DROP INDEX IF EXISTS items_section_order;
DROP INDEX IF EXISTS items_book_entries_order;
DROP INDEX IF EXISTS items_fang_order;
DROP INDEX IF EXISTS items_section_order_kind2;
DROP INDEX IF EXISTS items_source_book_id;
DROP INDEX IF EXISTS items_book_kind;
CREATE INDEX IF NOT EXISTS items_book_kind
  ON items (book_id, tcm_kind, status, pub_date);
