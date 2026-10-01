-- 0076_ext_tcm_alias_deleted.sql
--
-- ext_tcm_aliases 增加 `deleted` 列（0075 建表时漏应用）。语义：
--   deleted = 0  → 该行是「手工覆盖别名」：同名导入（派生）别名被它覆盖，App 端点也用这条；
--   deleted = 1  → 该行是「隐藏指令」：把同名的导入（派生）别名从后台看板与 App 端点都隐藏。
--
-- 这样导入别名也能在 /admin/aliases/ 被覆盖编辑、隐藏删除——重导不会丢覆盖/隐藏，
-- 因为导入管线仍是唯一真相（源数据变动后覆盖/隐藏依旧按 bieming 命中）。
--
-- 权限沿用 `content:alias:manage`。幂等：仅当列不存在才加（用临时表探测避免重复加列报错）。

ALTER TABLE ext_tcm_aliases ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
