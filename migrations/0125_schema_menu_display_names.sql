-- 0125_schema_menu_display_names.sql
--
-- 给 `ext_menu` 增加两个可空列 `name_zh` / `name_en`，让菜单展示名可由管理后台维护。
--
-- 渲染口径（前端侧栏与管理页共用，见 src/shared/AdminNavigation.ts 的
-- `adminMenuItemLabel`）：
--   * 数据库 `name_zh` / `name_en` 优先；
--   * 两列都为空（或当前语言那一列空）时，回退到现有的 `i18n_key` 文案
--     （硬编码在 src/shared/i18n/en.ts 与 zh-CN.ts）。
-- 回退必须保留：迁移种子 32 行的 `i18n_key` 是当前事实来源，管理页未填名称时
-- 继续用它，避免一次性把 32 行的名称固化成固定值。
--
-- 单向性：管理页改的是数据库行，本迁移只播种列结构、不写任何值；
-- 已部署实例以数据库为准，全新安装拿到的列默认为空、回退 `i18n_key`。
-- 口径写进本文件头与 CONTEXT.md，免得日后两台机器菜单不一致时无人知晓原因。
--
-- type = schema。rollback:
--   ALTER TABLE ext_menu DROP COLUMN name_en;
--   ALTER TABLE ext_menu DROP COLUMN name_zh;

ALTER TABLE ext_menu ADD COLUMN name_zh TEXT;
ALTER TABLE ext_menu ADD COLUMN name_en TEXT;
