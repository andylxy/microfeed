-- 0174_seed_book_info_statuses.sql
--
-- ADR-0058：「书本信息」状态数据源（迁移 0173 把 `hot_book` 改成 NOT NULL 状态列，
-- 取值 0/1/2）。状态清单存 `settings` 表 category='book_info_statuses'（独立管理，
-- 不依赖 channels/items/ext_*），与分组（0172 的 book_groups）同构。
--
-- ## data JSON 形状
--
--   { "statuses": [ { "value": <0|1|2>, "label": <显示名>, "sort": <下拉内序> } ] }
--
-- `value` 是书表 `hot_book` 存的整数（公开=0/隐藏=1/会员=2），下拉用 `label` 显示。
-- 三项为默认数据源：后台「状态管理」弹层可增删改名排序（整表覆盖写），首次部署
-- 先播种这三项，使 `hot_book` 的 NOT NULL 默认值 0 有一个可显示的 label。
--
-- 类型 seed：豁免 MIG-004 回滚块要求（幂等、纯追加，无数据回退需求）。
-- 幂等：INSERT OR IGNORE（category 主键），重复执行安全。

INSERT OR IGNORE INTO settings (category, data) VALUES (
  'book_info_statuses',
  '{"statuses":[{"value":0,"label":"公开","sort":0},{"value":1,"label":"隐藏","sort":1},{"value":2,"label":"会员","sort":2}]}'
);
