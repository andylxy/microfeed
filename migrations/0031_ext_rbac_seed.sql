-- RBAC seed: permission catalog, roles, role grants, and a backfill that keeps
-- existing Better Auth administrators fully privileged after upgrade.
--
-- Additive `ext_` namespace (upgrade-safe). All statements are idempotent
-- (`INSERT OR IGNORE`) so re-applying migrations is safe. The catalog here is
-- the SQL authoritative copy; `src/server/rbac/seed.ts` mirrors it in code and a
-- worker test asserts they stay in sync.

-- Roles
INSERT OR IGNORE INTO ext_roles (id, code, name) VALUES
  ('r_super_admin', 'super_admin', '超级管理员'),
  ('r_editor', 'editor', '编辑');

-- Permission catalog
INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
  ('p_content_book_create', 'content:book:create', '新建书'),
  ('p_content_book_read', 'content:book:read', '查看书'),
  ('p_content_book_update', 'content:book:update', '编辑书'),
  ('p_content_book_delete', 'content:book:delete', '删除书'),
  ('p_content_category_create', 'content:category:create', '新建分类'),
  ('p_content_category_read', 'content:category:read', '查看分类'),
  ('p_content_category_update', 'content:category:update', '编辑分类'),
  ('p_content_category_delete', 'content:category:delete', '删除分类'),
  ('p_content_category_order', 'content:category:order', '分类排序'),
  ('p_content_volume_update', 'content:volume:update', '卷结构编辑'),
  ('p_content_volume_read', 'content:volume:read', '查看卷'),
  ('p_content_chapter_create', 'content:chapter:create', '新建章节'),
  ('p_content_chapter_read', 'content:chapter:read', '查看章节'),
  ('p_content_chapter_update', 'content:chapter:update', '编辑章节'),
  ('p_content_chapter_delete', 'content:chapter:delete', '删除章节'),
  ('p_system_user_manage', 'system:user:manage', '用户管理'),
  ('p_system_role_manage', 'system:role:manage', '角色管理'),
  ('p_system_permission_manage', 'system:permission:manage', '权限管理'),
  ('p_content_settings_manage', 'content:settings:manage', '站点设置管理'),
  ('p_system_webhook_manage', 'system:webhook:manage', 'Webhook 管理'),
  ('p_*', '*', '超级管理员（全部）');

-- super_admin grants the wildcard ("*") permission. The id `p_*` matches the
-- `permissionId("*")` scheme in src/server/rbac/seed.ts so the SQL seed and the
-- code catalog stay byte-for-byte aligned (the worker test asserts this).
INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id) VALUES
  ('r_super_admin', 'p_*');

-- editor: books/categories/volumes read + update + book create (no deletes / no *manage).
INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id) VALUES
  ('r_editor', 'p_content_book_read'),
  ('r_editor', 'p_content_book_update'),
  ('r_editor', 'p_content_book_create'),
  ('r_editor', 'p_content_category_read'),
  ('r_editor', 'p_content_category_update'),
  ('r_editor', 'p_content_volume_read'),
  ('r_editor', 'p_content_volume_update');

-- Backfill: any pre-existing Better Auth administrator keeps full access after
-- this RBAC upgrade. (A legacy admin bypass in the guard is the runtime safety
-- net; this row makes the assignment explicit for the RBAC admin UI.)
INSERT OR IGNORE INTO ext_user_roles (user_id, role_id)
  SELECT id, 'r_super_admin' FROM auth_user WHERE role = 'admin';
