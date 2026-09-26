-- 0067_ext_menu_repair_stale_permission_codes.sql
--
-- Repoints `ext_menu.permission_code` for the rows 0057 left behind.
--
-- 0057 renamed the code catalogue (`ext_permissions`), the role grants
-- (`ext_role_permissions`) and the role-editor tree map
-- (`ext_menu_permissions`) from `content:article:*` to `content:chapter:*` —
-- but not the menu's own visibility gate, `ext_menu.permission_code`. A
-- database that applied 0041 *before* the rename therefore still binds those
-- rows to codes that no longer exist. 0041's seed text was renamed in place at
-- the same time, so a fresh database is already correct and this file migrates
-- production alone.
--
-- Why it is user-visible rather than cosmetic: `readAdminMenu`
-- (`src/server/admin/menu.ts`) filters every row through `rbacAllows`, which
-- asks `hasPermission` for the row's own code. `content:article:read` is in no
-- role's set — 0057 deleted the permission and 0031 only ever seeds the chapter
-- names — so the test fails for every account except a `*` holder. 「全部条目」
-- therefore vanished from the sidebar of 只读 / 维护 while those roles still
-- hold `content:chapter:read` and can open `/admin/items/` by URL: exactly the
-- 「hide a page the account may open」 failure the loader's own doc comment
-- warns about.
--
-- Same shape as 0057 step 3 — a prefix rewrite, not a row-by-row fix — so any
-- other stale `content:article:*` binding is carried along. `import_chapters`
-- held `content:article:create`; 0066 (applied immediately before this) already
-- deleted that row, so in practice only `all_items` is left to repoint.
--
-- Deliberately scoped to the one prefix 0057 renamed: a code with no chapter
-- equivalent is left untouched rather than guessed at. Idempotent — once no
-- `content:article:%` value remains, the UPDATE matches zero rows.

UPDATE ext_menu
   SET permission_code = REPLACE(permission_code, 'content:article:', 'content:chapter:')
 WHERE permission_code LIKE 'content:article:%';
