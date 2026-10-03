-- 0079_ext_tcm_yao_term_manage_permissions.sql
--
-- 中药管理（/admin/yao/）与名词管理（/admin/term/）从只读看板升级为可增删改：
-- 新增 / 改名 / 改正文 / 发布↔草稿 / 软删除（status=3，可在页内「回收站」恢复）。
-- 端点 `ajax/yao`、`ajax/term`（+ 各自的 `restore` 子路由）由此获得写能力，
-- 守卫用新增的 `content:yao:manage` / `content:term:manage`。
--
-- 沿用 0077 的菜单行（`m_yao` / `m_term`，parent_code='group_content'），本迁移
-- 只**追加** manage 码：`INSERT OR IGNORE` 幂等，不改既有 read 码与菜单行。
--
-- Catalog triple-mirror（缺一即红）：`PERMISSION_CODES`（src/shared/Constants.ts）
-- ≡ `RBAC_PERMISSIONS`（src/server/rbac/seed.ts）≡ 本SQL，由
-- `tests/unit/admin-endpoint-guards.test.ts` 与 `tests/worker/rbac.test.ts` 钉住。
-- id 必须用 `permissionId()` 推导（`p_<code 冒号转下划线>`），手写 id 会让
-- bootstrapAdmin 的授权 INSERT 因 FK 找不到权限行而 500（0069 教训）。
--
-- 权限树：manage 码挂到各自的菜单页（0052/0078 模式），在角色编辑器里与 read
-- 并列显示，而不是掉进兜底的「其他权限」组。
--
-- 角色授权：manage 属内容维护工作，授给 editor；readonly 保持只读（不给 manage，
-- 否则「只读」角色名不副实）。super_admin（*）天然拥有一切。

-- 1. 权限目录双镜像
INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
  ('p_content_yao_manage', 'content:yao:manage', '中药维护'),
  ('p_content_term_manage', 'content:term:manage', '名词维护');

-- 2. 菜单 → 权限映射：manage 码渲染在 yao / term 页面上
INSERT OR IGNORE INTO ext_menu_permissions (menu_code, permission_code) VALUES
  ('yao', 'content:yao:manage'),
  ('term', 'content:term:manage');

-- 3. 角色授权：editor 获得 manage（可增删改中药/名词）
INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id)
  SELECT 'r_editor', 'p_content_yao_manage'
  WHERE EXISTS (SELECT 1 FROM ext_roles WHERE id = 'r_editor');
INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id)
  SELECT 'r_editor', 'p_content_term_manage'
  WHERE EXISTS (SELECT 1 FROM ext_roles WHERE id = 'r_editor');
