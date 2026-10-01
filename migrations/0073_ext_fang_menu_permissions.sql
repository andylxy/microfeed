-- 0073_ext_fang_menu_permissions.sql
--
-- 方剂管理独立页（/admin/fangs/）—— 把方剂从「卷章页底部只读块 + 通用条目编辑
-- 页表单」收敛成与卷章管理同款的独立只读看板：选书后逐行列出该书方剂，行链接
-- 到条目编辑页（那里有方剂组成编辑器 FangEditor 与状态控制）。数据层不变
-- （items + fangYaoList 口袋）。
--
-- 权限沿用 `module:resource:action` 约定。看板本身只读（列表可见），方剂的组成/
-- 状态编辑都发生在条目编辑页，由通用条目权限守门，因此这里只种 `read` 一个码，
-- 不引入 `content:fang:update`（无任何端点消费它）。id 一律用 permissionId()
-- 推导（`p_<code 冒号转下划线>`），否则 bootstrapAdmin 的授权 INSERT 会因 FK
-- 找不到权限行而 500（0069 教训）。
--
-- 菜单行挂在「内容」组（0050 模式），sort 107 排在 annotation_markers(106) 之后；
-- ext_menu_permissions 记录 read 码（0052 模式），角色编辑器可见、可授。
--
-- 幂等：INSERT OR IGNORE。

-- 1. 权限目录双镜像（seed.ts 的 RBAC_PERMISSIONS 必须与这里一致）
INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
  ('p_content_fang_read', 'content:fang:read', '方剂查看');

-- 2. 菜单行：内容组内，只看得到 read 码
INSERT OR IGNORE INTO ext_menu
  (id, code, parent_code, path, i18n_key, icon, permission_code, sort, is_visible, created_at_ms)
VALUES
  ('m_fangs', 'fangs', 'group_content', 'fangs', 'menu.item.fangs', 'pill', 'content:fang:read', 107, 1,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- 3. 菜单 → 权限映射（角色编辑器按菜单组织权限树）
INSERT OR IGNORE INTO ext_menu_permissions (menu_code, permission_code) VALUES
  ('fangs', 'content:fang:read');

-- 4. 角色授权：editor 与 readonly 都只读（内容查看）；编辑走条目编辑页，
--    由通用条目权限守门。super_admin（*）天然拥有一切。
INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id)
  SELECT 'r_editor', 'p_content_fang_read'
  WHERE EXISTS (SELECT 1 FROM ext_roles WHERE id = 'r_editor');
INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id)
  SELECT 'r_readonly', 'p_content_fang_read'
  WHERE EXISTS (SELECT 1 FROM ext_roles WHERE id = 'r_readonly');
