-- 0075_ext_tcm_alias_table.sql
--
-- 手工别名表（/admin/aliases/ 的增删改落点）。移动端 GetAliaZhongYao 的别名原本
-- 全由导入派生（yaoAlias → yao `_microfeed.aliases[]`、Yao.YaoList → `yaoNames`、
-- BookBody.BieMing → section `bieMing`），后台只能看不能改。本表给管理员一个可维护
-- 的落点：App 端点在三源之后合并它（手工别名覆盖同名派生别名）。
--
-- `deleted` 列（隐藏语义：deleted=1 隐藏同名导入别名）由 0076 追加，本文件只建表。
--
-- 权限 `content:alias:manage`（增删改），id 用 permissionId() 推导（`p_<冒号转下划线>`），
-- 否则 bootstrapAdmin 的授权 INSERT 会因 FK 找不到权限行而 500（0069 教训）。
-- 菜单映射挂在既有 aliases 页（0074 建的行），角色编辑器可见、可授。
--
-- 幂等：CREATE TABLE IF NOT EXISTS + INSERT OR IGNORE。

CREATE TABLE IF NOT EXISTS ext_tcm_aliases (
  id            TEXT PRIMARY KEY,
  bieming       TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

-- 权限目录双镜像（seed.ts 的 RBAC_PERMISSIONS 必须与这里一致）
INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
  ('p_content_alias_manage', 'content:alias:manage', '别名维护');

-- 菜单 → 权限映射（角色编辑器按菜单组织权限树；0074 已建 aliases 行）
INSERT OR IGNORE INTO ext_menu_permissions (menu_code, permission_code) VALUES
  ('aliases', 'content:alias:manage');

-- 角色授权：editor 可维护（别名是内容数据）；readonly 只读，不授。
-- super_admin（*）天然拥有一切。
INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id)
  SELECT 'r_editor', 'p_content_alias_manage'
  WHERE EXISTS (SELECT 1 FROM ext_roles WHERE id = 'r_editor');
