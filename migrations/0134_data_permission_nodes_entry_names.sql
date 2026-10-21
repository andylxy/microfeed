-- 0134_data_permission_nodes_entry_names.sql
--
-- ADR-0042 D6：侧栏改读权限节点后，页面节点的 `name_zh` / `name_en` 就是导航上
-- 显示的文字。0127 的决策 6 要求组/页名称取 i18n 当前文本作冗余列，两行没做到，
-- 切换侧栏时这两个入口的可见文字会跟着变：
--   page_rbac        角色与权限 / Roles & permissions  →  权限管理 / Permissions（`menu.item.rbac`）
--   page_rbac_audit  RBAC 日志 / RBAC audit            →  RBAC 日志 / RBAC log（`menu.item.rbac_audit`）
-- 对齐之后，切换前后的侧栏文字逐字相同（ADR-0042 验证口径 阶段3）。
--
-- 只改仍是种子值的行：运营在「角色管理」页改过的名称属于运行时数据，迁移不覆盖。
--
-- type = data
-- rollback:
--   UPDATE ext_permission_nodes
--   SET name_zh = '角色与权限', name_en = 'Roles & permissions'
--   WHERE code = 'page_rbac' AND name_zh = '权限管理' AND name_en = 'Permissions';
--   UPDATE ext_permission_nodes
--   SET name_en = 'RBAC audit'
--   WHERE code = 'page_rbac_audit' AND name_en = 'RBAC log';

UPDATE ext_permission_nodes
SET name_zh = '权限管理', name_en = 'Permissions'
WHERE code = 'page_rbac'
  AND name_zh = '角色与权限' AND name_en = 'Roles & permissions';

UPDATE ext_permission_nodes
SET name_en = 'RBAC log'
WHERE code = 'page_rbac_audit'
  AND name_en = 'RBAC audit';
