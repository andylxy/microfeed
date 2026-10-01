-- 0074_ext_alias_menu_permissions.sql
--
-- 别名对照只读页（/admin/aliases/）—— 把移动端 GetAliaZhongYao 端点下发的
-- 「别名 → 正名」列表在后台做一个只读镜像，方便核对与排查（数据来自三源：
-- yaoAlias 表、各味药的 YaoList、BookBody.BieMing）。
--
-- 权限沿用 `module:resource:action` 约定。本页只读（列表可见），别名数据由导入
-- 脚本维护（import-yao.mjs / build.ts），后台不提供编辑，因此只种 `read` 一个码。
-- id 一律用 permissionId() 推导（`p_<code 冒号转下划线>`），否则 bootstrapAdmin
-- 的授权 INSERT 会因 FK 找不到权限行而 500（0069 教训）。
--
-- 菜单行挂在「内容」组（0050 模式），sort 108 排在 fangs(107) 之后；
-- ext_menu_permissions 记录 read 码（0052 模式），角色编辑器可见、可授。
--
-- 幂等：INSERT OR IGNORE。

-- 1. 权限目录双镜像（seed.ts 的 RBAC_PERMISSIONS 必须与这里一致）
INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
  ('p_content_alias_read', 'content:alias:read', '别名查看');

-- 2. 菜单行：内容组内，只看得到 read 码
INSERT OR IGNORE INTO ext_menu
  (id, code, parent_code, path, i18n_key, icon, permission_code, sort, is_visible, created_at_ms)
VALUES
  ('m_aliases', 'aliases', 'group_content', 'aliases', 'menu.item.aliases', 'list', 'content:alias:read', 108, 1,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- 3. 菜单 → 权限映射（角色编辑器按菜单组织权限树）
INSERT OR IGNORE INTO ext_menu_permissions (menu_code, permission_code) VALUES
  ('aliases', 'content:alias:read');

-- 4. 角色授权：editor 与 readonly 都只读（内容查看）。super_admin（*）天然拥有一切。
INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id)
  SELECT 'r_editor', 'p_content_alias_read'
  WHERE EXISTS (SELECT 1 FROM ext_roles WHERE id = 'r_editor');
INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id)
  SELECT 'r_readonly', 'p_content_alias_read'
  WHERE EXISTS (SELECT 1 FROM ext_roles WHERE id = 'r_readonly');
