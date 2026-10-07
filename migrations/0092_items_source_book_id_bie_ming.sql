-- 0092: items 增加表达式索引，让方剂按 sourceBookId 的过滤走索引
--
-- 背景：`getAppBookFang` 按 `json_extract(data, '$._microfeed.sourceBookId') = ?` 过滤。
-- 条件写在 JSON 表达式上，SQLite 默认无法用索引，只能扫过全部 `tcm_kind='fang'` 的条目。
-- SQLite 允许在表达式上建索引；建完后该查询即命中（`EXPLAIN QUERY PLAN` 显示
-- `SEARCH items USING INDEX items_source_book_id (<expr>=?)`）。做法与 0070
-- `items_tcm_kind_name`（`json_extract(data, '$.title')` 表达式索引）一致。
--
-- `data` 仍是唯一事实来源；这是纯索引，不改任何写入路径。
--
-- 注：`getDerivedYaoAliases` 按 `json_extract(data, '$._microfeed.bieMing') != ''` 过滤，
-- `!=` 用不上索引，保持全扫描——该子集被 `tcm_kind='section'` 限定，行数有界。

CREATE INDEX IF NOT EXISTS items_source_book_id
  ON items (json_extract(data, '$._microfeed.sourceBookId'));
