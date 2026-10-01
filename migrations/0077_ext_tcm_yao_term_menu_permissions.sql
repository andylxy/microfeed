-- 0077_ext_tcm_yao_term_menu_permissions.sql
--
-- 中药管理（/admin/yao/）与名词管理（/admin/term/）独立只读看板，参考方剂管理
-- （0073）。两者都是平铺型 TCM 书：中药条目挂在 book_id='4KbG9bDqdz3'（中药），
-- 名词条目挂在 book_id='tcmterm0001'（名词），都通过 items.book_id 归属，
-- 不用 sourceBookId（那列对 yao/term 为 null）。看板只读（行链条目编辑页），
-- 因此只种 read 码，不引入 content:yao:update / content:term:update。
--
-- 权限沿用 `content:*:read` 约定。id 一律用 permissionId() 推导
-- （`p_<code 冒号转下划线>`），否则 bootstrapAdmin 的授权 INSERT 会因 FK 找不到
-- 权限行而 500（0069 教训）。
--
-- 菜单行挂在「内容」组（0050 模式），sort 109（yao）排在 aliases(108) 之后、
-- 110（term）其后；ext_menu_permissions 记录 read 码（0052 模式），角色编辑器
-- 可见、可授。
--
-- 幂等：INSERT OR IGNORE。

-- 1. 权限目录双镜像（seed.ts 的 RBAC_PERMISSIONS 必须与这里一致）
INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
  ('p_content_yao_read', 'content:yao:read', '中药查看'),
  ('p_content_term_read', 'content:term:read', '名词查看');

-- 2. 菜单行：内容组内，只看得到 read 码
INSERT OR IGNORE INTO ext_menu
  (id, code, parent_code, path, i18n_key, icon, permission_code, sort, is_visible, created_at_ms)
VALUES
  ('m_yao', 'yao', 'group_content', 'yao', 'menu.item.yao', 'leaf', 'content:yao:read', 109, 1,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('m_term', 'term', 'group_content', 'term', 'menu.item.term', 'tags', 'content:term:read', 110, 1,
   CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- 3. 菜单 → 权限映射（角色编辑器按菜单组织权限树）
INSERT OR IGNORE INTO ext_menu_permissions (menu_code, permission_code) VALUES
  ('yao', 'content:yao:read'),
  ('term', 'content:term:read');

-- 4. 角色授权：editor 与 readonly 都只读（内容查看）；编辑走条目编辑页，
--    由通用条目权限守门。super_admin（*）天然拥有一切。
INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id)
  SELECT 'r_editor', 'p_content_yao_read'
  WHERE EXISTS (SELECT 1 FROM ext_roles WHERE id = 'r_editor');
INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id)
  SELECT 'r_readonly', 'p_content_yao_read'
  WHERE EXISTS (SELECT 1 FROM ext_roles WHERE id = 'r_readonly');
INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id)
  SELECT 'r_editor', 'p_content_term_read'
  WHERE EXISTS (SELECT 1 FROM ext_roles WHERE id = 'r_editor');
INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id)
  SELECT 'r_readonly', 'p_content_term_read'
  WHERE EXISTS (SELECT 1 FROM ext_roles WHERE id = 'r_readonly');
