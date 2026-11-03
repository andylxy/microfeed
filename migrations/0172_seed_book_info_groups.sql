-- 0172_seed_book_info_groups.sql
--
-- ADR-0059：「书本信息」分组树。分组清单存 `settings` 表
-- category='book_groups'（独立管理，不依赖 channels/items/ext_category），
-- 书的归属 = `book_info.case_division`（本就 NOT NULL + 必填），取值按
-- 分组 `key`——不新增列、不新增 ALTER（ADR-0059 决策 1/2）。
--
-- ## 默认分组：老项目 ext_category 的一次性冻结快照（决策 3）
--
-- 把 `ext_category` 当下三行（伤寒金匮/本草/内经）写成 settings 种子。
-- **运行时不依赖 ext_category**——迁移跑完两者各自独立演化，是「解耦后的
-- 一次性数据搬迁」，不破 ADR-0058「不依赖 ext_category」红线。
-- 快照实测（2026-11-03 本地库只读探针）：shanghan / neijing / bencao。
--
-- ## data JSON 形状（Q6 定案）
--
--   { "groups": [ { "key": <稳定slug>, "label": <显示名>, "sort": <树内序> } ] }
--
-- `key` 是书表 `case_division` 存的稳定 slug（改名只动 settings，无级联）；
-- 整表覆盖写（与 UsersApp `signup_sources` 同构）。
--
-- ## case_division 索引
--
-- 左栏按组过滤（`WHERE case_division = ?`）与删组改派（批量 UPDATE 同谓词）
-- 都按分组键定位，补索引避免全表扫描（08 册；与 0171 的 book_no/parent_id/
-- is_enable 同批口径）。
--
-- 类型 seed：豁免 MIG-004 回滚块要求（幂等、纯追加）。
-- 幂等：INSERT OR IGNORE（category 主键）/ CREATE INDEX IF NOT EXISTS，重复执行安全。

INSERT OR IGNORE INTO settings (category, data) VALUES (
  'book_groups',
  '{"groups":[{"key":"shanghan","label":"伤寒金匮","sort":0},{"key":"neijing","label":"内经","sort":1},{"key":"bencao","label":"本草","sort":2}]}'
);

CREATE INDEX IF NOT EXISTS book_info_case_division ON book_info (case_division);
