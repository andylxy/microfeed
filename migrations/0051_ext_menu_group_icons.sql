-- 0051_ext_menu_group_icons.sql
--
-- 0050 added the group rows with a NULL icon, so the sidebar rendered them with
-- its fallback glyph. Give each group a meaningful one. Icons are names the
-- sidebar resolves (`MENU_ICONS` in AdminMenuItemLink); an unknown name falls
-- back, so this is cosmetic only.
--
-- Idempotent (absolute UPDATEs).

UPDATE ext_menu SET icon = 'book'         WHERE code = 'group_content';
UPDATE ext_menu SET icon = 'shield-check' WHERE code = 'group_review';
UPDATE ext_menu SET icon = 'settings'     WHERE code = 'group_site';
UPDATE ext_menu SET icon = 'code-2'       WHERE code = 'group_integration';
UPDATE ext_menu SET icon = 'users'        WHERE code = 'group_account';
