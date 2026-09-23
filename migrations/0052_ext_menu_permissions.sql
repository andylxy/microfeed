-- 0052_ext_menu_permissions.sql
--
-- The role editor's permission tree is organised by the admin menu (see
-- `.scratch/microfeed-rbac/adr/0001-permission-tree-follows-menu.md`). The menu
-- is data (`ext_menu`), and `ext_menu.permission_code` binds at most ONE code
-- per page — too coarse for a page like Books, which governs read / create /
-- update / delete. This table carries the many-to-many map instead.
--
-- Only pages that actually govern codes appear here. A code with no row falls
-- into the editor's "other permissions" group rather than disappearing, so the
-- table can be extended lazily without hiding anything.
--
-- Deliberately no foreign keys: the menu is a UI structure and must never
-- become the thing that grants access (see ADR-002-admin-menu-as-data.md).
--
-- Idempotent (`INSERT OR IGNORE`) so re-applying migrations is safe.

CREATE TABLE IF NOT EXISTS ext_menu_permissions (
  menu_code       TEXT NOT NULL,
  permission_code TEXT NOT NULL,
  PRIMARY KEY (menu_code, permission_code)
);

CREATE INDEX IF NOT EXISTS ix_ext_menu_permissions_permission
  ON ext_menu_permissions(permission_code);

INSERT OR IGNORE INTO ext_menu_permissions (menu_code, permission_code) VALUES
  -- 内容
  ('all_items',       'content:article:read'),
  ('all_items',       'content:article:update'),
  ('all_items',       'content:article:delete'),
  ('import_chapters', 'content:article:create'),
  ('books',           'content:book:read'),
  ('books',           'content:book:create'),
  ('books',           'content:book:update'),
  ('books',           'content:book:delete'),
  ('volumes',         'content:volume:read'),
  ('volumes',         'content:volume:update'),
  ('categories',      'content:category:read'),
  ('categories',      'content:category:create'),
  ('categories',      'content:category:update'),
  ('categories',      'content:category:delete'),
  ('categories',      'content:category:order'),
  -- 审核
  ('review',          'content:review:manage'),
  ('audit',           'content:audit:read'),
  -- 站点
  ('edit_channel',    'content:channel:manage'),
  ('pages',           'content:page:manage'),
  ('site_files',      'content:site_file:manage'),
  ('settings',        'content:settings:manage'),
  -- 集成
  ('api',             'system:api:manage'),
  ('api',             'api:content:read'),
  ('api',             'api:content:write'),
  ('api',             'api:media:read'),
  ('api',             'api:media:write'),
  ('api',             'api:page:read'),
  ('api',             'api:page:write'),
  ('api',             'api:site:read'),
  ('api',             'api:site:write'),
  ('webhooks',        'system:webhook:manage'),
  -- 账户
  ('rbac',            'system:role:manage'),
  ('rbac',            'system:permission:manage'),
  ('users',           'system:user:manage');
