-- 0043_ext_readonly_role.sql
--
-- A read-only content role ("readonly" / 只读). It is the default role handed to
-- a newly created account (see `createAdminRbacUser`), so a fresh account can
-- see the content area instead of landing on an almost-empty sidebar.
--
-- Read-only by construction: only `*:read` content codes. No writes, no
-- `*:manage`, no API grants. Menu visibility follows from these codes — the
-- account sees Home, See all items, Books, Categories, and the Volume board.
--
-- Idempotent (`INSERT OR IGNORE`), mirroring 0031/0040. `src/server/rbac/seed.ts`
-- keeps the same role in code; a worker test asserts the two stay in sync.

INSERT OR IGNORE INTO ext_roles (id, code, name) VALUES
  ('r_readonly', 'readonly', '只读');

INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id) VALUES
  ('r_readonly', 'p_content_chapter_read'),
  ('r_readonly', 'p_content_book_read'),
  ('r_readonly', 'p_content_category_read'),
  ('r_readonly', 'p_content_volume_read');
