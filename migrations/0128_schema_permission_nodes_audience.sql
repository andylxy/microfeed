-- 0128_schema_permission_nodes_audience.sql
--
-- 权限节点加「终端归属」列（ADR-0039 D1）。
--
--   desktop = 后台页面权限（内容 / 审核 / 站点 / 集成 / 账户 / 运营）
--   app     = App 能力权限（app:mobile:access / app:version:read / …）
--
-- 这是两端互斥分区的唯一依据：读板子、授权保存、权限树端点都按这一列收窄。
-- `ext_permissions` 不加列——某个码属于哪一端，由它在节点表里那条
-- `kind='code'` 叶子的 `audience` 推导（0127 每个可授码恰有一条叶子，无歧义），
-- 单一来源胜过两处各记一遍。
--
-- 默认值 'desktop'：既有 87 行都是后台页面权限，只有 App 能力码那几条要改，
-- 改由 0129 的数据迁移完成（本文件只管列结构）。
--
-- 索引 `(audience, kind)`：读板子按端取行、码→端推导都走这个前缀，
-- 两端各读几十行，均为点查。节点表约 90 行，不触大表。
--
-- type = schema。列级 DDL 由 `d1_migrations` 的文件名记账，不可重放。
-- rollback:
--   DROP INDEX IF EXISTS ix_ext_permission_nodes_audience;
--   ALTER TABLE ext_permission_nodes DROP COLUMN audience;

ALTER TABLE ext_permission_nodes ADD COLUMN audience TEXT NOT NULL DEFAULT 'desktop';

CREATE INDEX IF NOT EXISTS ix_ext_permission_nodes_audience
  ON ext_permission_nodes (audience, kind);
