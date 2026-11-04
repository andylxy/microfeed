-- 0178_seed_ming_ci_groups.sql
--
-- ADR-0060：名词「分组清单」。分组清单存 `settings` 表
-- category='mingci_groups'（独立管理，不依赖 channels/items/ext_category），
-- 名词归属 = `ming_ci.ming_ci_type`（本就 NOT NULL + 必填），取值按分组
-- `key`——不新增列、不新增 ALTER（ADR-0060 决策 4）。
--
-- ## 默认分组：源数据 MingCiType 的一次性冻结快照（决策 4）
--
-- 把 `ctwh/BeiMingCi.sql` 的 MingCiType 四值（医理/药理/易理/通用）写成
-- settings 种子。**运行时不依赖源表**——迁移跑完两者各自独立演化。
-- 快照实测（2026-11-04 只读探针）：医理 8 / 药理 7 / 易理 1 / 通用 1。
--
-- ## data JSON 形状（与 book_groups 同构）
--
--   { "groups": [ { "key": <稳定slug>, "label": <显示名>, "sort": <树内序> } ] }
--
-- `key` 是名词表 `ming_ci_type` 存的稳定 slug（改名只动 settings，无级联）；
-- 整表覆盖写（与 book_groups 同构）。**写侧严格校验命中 key**（未命中 400
-- fail-closed，镜像 ADR-0059 case_division）。
--
-- 幂等：INSERT OR IGNORE（category 主键），重复执行安全。

INSERT OR IGNORE INTO settings (category, data) VALUES (
  'mingci_groups',
  '{"groups":[{"key":"yili","label":"医理","sort":0},{"key":"yaoli","label":"药理","sort":1},{"key":"zhouyi","label":"易理","sort":2},{"key":"tongyong","label":"通用","sort":3}]}'
);
