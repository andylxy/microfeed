-- 0066_ext_drop_import_chapters_page.sql
--
-- Drops the 「从 txt 导入章节」 admin page (`/items/import/`) and its menu row.
--
-- The page was a local addition, not upstream microfeed: it existed only in this
-- fork (`src/pages/[adminPath]/items/import/`, `ImportChaptersApp`,
-- `src/shared/novelChapterImport.ts`, plus its two unit tests). 0041 seeded the
-- menu row, 0050 re-parented it under `group_content` at sort 105, and 0052
-- mapped it to `content:chapter:create` in the role-editor tree. The page, the
-- component, the parser, the `ADMIN_URLS.importChapters` helper, the
-- `ADMIN_MENU_CODES.IMPORT_CHAPTERS` constant and the `importChapters` i18n keys
-- are all removed in the same change; this file retires the data rows.
--
-- The permission code itself is NOT retired. `content:chapter:create` is still
-- the guard on the chapter write path: `src/pages/[adminPath]/ajax/feed.ts`
-- picks it for a save that carries no item id, and it is part of the
-- `content:*:*` catalogue in `src/server/api/api-permissions.ts`. So it keeps
-- its `ext_permissions` row and every role grant.
--
-- What DOES change is the tree map. `import_chapters` was the only page hosting
-- `content:chapter:create` in the role editor, so the mapping moves to the item
-- list — the same 内容 page that already hosts `content:chapter:read` /
-- `content:chapter:update`. Without this the code would fall into
-- `buildPermissionTree`'s 「其他」 bucket and drift out from under 内容.
--
-- Related, same change: `src/pages/[adminPath]/items/new/index.astro` no longer
-- guards with `content:chapter:create`. It was the fork's only page whose guard
-- code had no menu row of its own (the import row was binding it), and it was
-- also the only `<section>/new/` page not reusing its list menu's code —
-- `pages/new` and `site-files/new` both do. It now guards with
-- `content:chapter:read`, the code `all_items` binds. Creating a chapter is
-- still authorised by `content:chapter:create` at the write endpoint.
--
-- No neighbour renumbering: `import_chapters` was the last child of
-- `group_content` (sort 105, after `all_items` at 104), so removing it leaves a
-- gap at the end of the group, not a hole in the middle.
--
-- Idempotent: the insert is `OR IGNORE` and the rest are DELETEs, all no-ops
-- once applied.

INSERT OR IGNORE INTO ext_menu_permissions (menu_code, permission_code)
  VALUES ('all_items', 'content:chapter:create');

DELETE FROM ext_menu_permissions
 WHERE menu_code = 'import_chapters';

-- Single `code = '…'` per statement: `tests/unit/admin-page-guards.test.ts`
-- parses these deletes to drop the row from its expectations, so it does not
-- require touching 0041.
DELETE FROM ext_menu
 WHERE code = 'import_chapters';
