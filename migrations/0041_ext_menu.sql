-- 0041_ext_menu.sql
--
-- The admin menu becomes data. One row is one menu entry; the dashboard loads
-- the rows the signed-in account is allowed to see instead of rendering a
-- hard-coded array.
--
-- `permission_code` is the ONLY link between a menu and a permission:
--   NULL            -> public menu, visible to anyone signed in (the home entry)
--   a permission code-> visible only to accounts holding that code
-- A menu binds at most one code on purpose. When a destination genuinely needs
-- several, create a combined permission code and bind that instead — see
-- ADR-002-admin-menu-as-data.md.
--
-- The permission codes referenced below are seeded by migration 0040 (the six
-- new ones) and 0031/0035 (the rest). There is deliberately no foreign key: the
-- menu is a UI structure and must never become the thing that grants access.
--
-- `i18n_key` follows the existing `menu.item.<code>` keys. They move to
-- `menu.item.<code>` with the rename; that migration updates these rows.
--
-- Idempotent (`INSERT OR IGNORE`) so re-applying migrations is safe.

CREATE TABLE IF NOT EXISTS ext_menu (
  id              TEXT PRIMARY KEY,
  code            TEXT NOT NULL UNIQUE,
  parent_code     TEXT,
  path            TEXT NOT NULL,
  i18n_key        TEXT NOT NULL,
  icon            TEXT,
  permission_code TEXT,
  sort            INTEGER NOT NULL DEFAULT 0,
  is_visible      INTEGER NOT NULL DEFAULT 1,
  created_at_ms   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_ext_menu_parent ON ext_menu(parent_code);
CREATE INDEX IF NOT EXISTS ix_ext_menu_permission ON ext_menu(permission_code);

INSERT OR IGNORE INTO ext_menu
  (id, code, parent_code, path, i18n_key, icon, permission_code, sort, is_visible, created_at_ms)
VALUES
  ('m_admin_home',      'admin_home',      NULL, '',                  'menu.item.admin_home',      'home',         NULL,                        10, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('m_edit_channel',    'edit_channel',    NULL, 'channels/primary',  'menu.item.edit_channel',    'pencil',       'content:channel:manage',    20, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('m_all_items',       'all_items',       NULL, 'items/list',        'menu.item.all_items',       'list',         'content:chapter:read',      30, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('m_import_chapters', 'import_chapters', NULL, 'items/import',      'menu.item.import_chapters', 'upload',       'content:chapter:create',    40, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('m_review',          'review',          NULL, 'review',            'menu.item.review',          'shield-check', 'content:review:manage',     50, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('m_audit',           'audit',           NULL, 'audit',             'menu.item.audit',           'history',      'content:audit:read',        60, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('m_pages',           'pages',           NULL, 'pages',             'menu.item.pages',           'file-text',    'content:page:manage',       70, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('m_categories',      'categories',      NULL, 'categories',        'menu.item.categories',      'tags',         'content:category:read',     80, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('m_books',           'books',           NULL, 'books',             'menu.item.books',           'book',         'content:book:read',         90, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('m_volumes',         'volumes',         NULL, 'volumes',           'menu.item.volumes',         'layers',       'content:volume:read',      100, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('m_site_files',      'site_files',      NULL, 'site-files',        'menu.item.site_files',      'file-code-2',  'content:site_file:manage', 110, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('m_api',             'api',             NULL, 'api',               'menu.item.api',             'code-2',       'system:api:manage',        120, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('m_webhooks',        'webhooks',        NULL, 'webhooks',          'menu.item.webhooks',        'webhook',      'system:webhook:manage',    130, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('m_rbac',            'rbac',            NULL, 'rbac',              'menu.item.rbac',            'shield-check', 'system:role:manage',       140, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('m_users',           'users',           NULL, 'users',             'menu.item.users',           'users',        'system:user:manage',       150, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('m_settings',        'settings',        NULL, 'settings',          'menu.item.settings',        'settings',     'content:settings:manage',  160, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
