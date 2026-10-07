-- 0093: items 加表达式索引，让「有别名（bieMing）的 section」过滤走索引
--
-- 背景：`getDerivedYaoAliases`（src/server/tcm/reads.ts）按
--   `tcm_kind = 'section' AND status != 3 AND json_extract(data, '$._microfeed.bieMing') != ''`
-- 过滤别名条目。条件写在 JSON 表达式上，SQLite 默认只能扫过全部匹配
-- `tcm_kind='section'` 的行再逐行算 json_extract，做全扫描。
--
-- 做法（与 0092 items_source_book_id、0070 items_tcm_kind_name 一致）：在
-- `(tcm_kind, json_extract(data, '$._microfeed.bieMing'))` 上建表达式索引。
-- tcm_kind 是等值前缀列，bieMing 表达式列用于范围 / 非空判定。
--
-- 关键：谓词必须用 `> ''`（范围），不能写 `!= ''`。`!= ''` 在 SQLite 里不算
-- 可用的范围边界，只会命中 `tcm_kind=?` 前缀、bieMing 仍走全扫描；`> ''` 才让
-- 索引的第二列真正参与搜索（`EXPLAIN QUERY PLAN` 显示
-- `SEARCH items USING INDEX items_bie_ming (tcm_kind=? AND <expr>>?)`）。
-- 0092 末尾那条「保持全扫描」的注记因此作废——本迁移即修复。
--
-- `status != 3` 不是索引列，命中索引后再做 residual 过滤；主导成本（扫全部
-- section 行）已被消除。`data` 仍是唯一事实来源，这仅是一层索引，不改写入路径。

CREATE INDEX IF NOT EXISTS items_bie_ming
  ON items (tcm_kind, json_extract(data, '$._microfeed.bieMing'));
