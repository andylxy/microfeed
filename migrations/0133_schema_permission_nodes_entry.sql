-- 0133_schema_permission_nodes_entry.sql
--
-- ADR-0041 D1/D2、ADR-0042 D3：给页面节点补 `path`（入口路径，相对 `/admin/`）与
-- `entry_code`（入口门码）。合并后侧栏从节点读取，页面节点因此要能表达「对应哪个
-- 后台入口、这个入口给谁可见」。
--
-- 回填以现有 `ext_menu` 行为准（不另造规则）：`node.code = 'page_' || menu.code`
-- 的 25 个配对页，`path ← menu.path`、`entry_code ← menu.permission_code`。
-- 规则直接读菜单行，不写常量：全新安装时这些种子先于本迁移存在，同样能回填。
--
-- `rbac_audit` 是菜单独有、树里没有的入口：新增 `page_rbac_audit` 节点，挂在账户
-- 分组下，`entry_code = system:role:manage`、`path = rbac/audit`，与 `page_rbac`
-- 共用门码（两个入口、一张权限页）。
--
-- `page_media` 与 App 端页面无菜单行，两列留空：`media` 只挂码、不进侧栏。
--
-- 约束「entry_code 非空 ⇒ path 非空」：SQLite 的 `ALTER TABLE ADD COLUMN` 不能带
-- CHECK，用触发器兜底；API 层（`planPermissionOps`）另有一道同样的校验。
--
-- type = schema（含一次数据回填）。列级 DDL 由 `d1_migrations` 记账，不可重放。
-- rollback:
--   DROP TRIGGER IF EXISTS trg_permission_nodes_entry_needs_path_upd;
--   DROP TRIGGER IF EXISTS trg_permission_nodes_entry_needs_path_ins;
--   DELETE FROM ext_permission_nodes WHERE code = 'page_rbac_audit';
--   ALTER TABLE ext_permission_nodes DROP COLUMN entry_code;
--   ALTER TABLE ext_permission_nodes DROP COLUMN path;

ALTER TABLE ext_permission_nodes ADD COLUMN path TEXT;
ALTER TABLE ext_permission_nodes ADD COLUMN entry_code TEXT;

-- 回填 25 个配对页：只碰有父级的菜单叶子（分组与首页无门码）。
UPDATE ext_permission_nodes
SET path = (SELECT m.path FROM ext_menu m
            WHERE m.parent_code IS NOT NULL
              AND ext_permission_nodes.code = 'page_' || m.code),
    entry_code = (SELECT m.permission_code FROM ext_menu m
                  WHERE m.parent_code IS NOT NULL
                    AND ext_permission_nodes.code = 'page_' || m.code)
WHERE kind = 'page'
  AND EXISTS (SELECT 1 FROM ext_menu m
              WHERE m.parent_code IS NOT NULL
                AND ext_permission_nodes.code = 'page_' || m.code);

-- rbac_audit：菜单独有入口，补一个页面节点，与 page_rbac 共用门码。
INSERT OR IGNORE INTO ext_permission_nodes
  (id, code, kind, parent_code, sort, audience, permission_code, name_zh, name_en,
   icon, i18n_key, is_visible, source, created_at_ms, path, entry_code)
VALUES
  ('pn_page_rbac_audit', 'page_rbac_audit', 'page', 'group_account', 504, 'desktop', NULL,
   'RBAC 日志', 'RBAC audit', 'history', NULL, 1, 'seed',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'rbac/audit', 'system:role:manage');

-- 约束：entry_code 非空 ⇒ path 非空。
CREATE TRIGGER IF NOT EXISTS trg_permission_nodes_entry_needs_path_ins
BEFORE INSERT ON ext_permission_nodes
WHEN NEW.entry_code IS NOT NULL AND NEW.entry_code <> ''
  AND (NEW.path IS NULL OR NEW.path = '')
BEGIN
  SELECT RAISE(ABORT, 'entry_code requires path');
END;

CREATE TRIGGER IF NOT EXISTS trg_permission_nodes_entry_needs_path_upd
BEFORE UPDATE OF entry_code, path ON ext_permission_nodes
WHEN NEW.entry_code IS NOT NULL AND NEW.entry_code <> ''
  AND (NEW.path IS NULL OR NEW.path = '')
BEGIN
  SELECT RAISE(ABORT, 'entry_code requires path');
END;
