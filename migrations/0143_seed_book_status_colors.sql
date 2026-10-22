-- 0143_seed_book_status_colors.sql
--
-- 书籍状态加配色：`ext_book_status` 增 `color_fg` / `color_bg` 两列（CSS 颜色文本，
-- 只取 `#RGB` / `#RRGGBB` 两种形状——取色控件产不出别的形状，rgb()/rgba() 会在
-- 下次编辑时被静默拍平，NULL = 不上色）。后台「书籍状态」页用取色控件维护，
-- `/admin/books/` 的状态徽章按行上色。
--
-- 同批把运营在本地库手工加的「会员」状态（code 10）固化成种子行：新装环境与
-- 远程同步都从迁移拿得到，不再依赖某台机器上的手插数据。本地库已有该行时
-- INSERT OR IGNORE 是空转，配色由后面的 UPDATE 统一赋值，两条路径收敛。
--
-- 默认配色取 Tailwind 调色板的浅底深字（green / neutral / red / amber），
-- 与浅色主题一致；运营可在页面逐行改。
--
-- type = schema + seed。回滚块照写：
-- rollback:
--   DELETE FROM ext_book_status WHERE code = 10;
--   UPDATE ext_book_status SET color_fg = NULL, color_bg = NULL;
--   ALTER TABLE ext_book_status DROP COLUMN color_bg;
--   ALTER TABLE ext_book_status DROP COLUMN color_fg;
--
-- 幂等：INSERT OR IGNORE + 绝对赋值 UPDATE 可重复执行；两条 ADD COLUMN 属
-- migrations/README.md 记载的列级 DDL 一次性（与 0011 等同期迁移同款），由
-- d1_migrations 的文件名记账防重放，不要为「重放安全」改写本文件。

ALTER TABLE ext_book_status ADD COLUMN color_fg TEXT;
ALTER TABLE ext_book_status ADD COLUMN color_bg TEXT;

-- 「会员」状态固化为种子行（本地库已存在时为 no-op）
INSERT OR IGNORE INTO ext_book_status
  (code, name_zh, name_en, form_selectable, public_visible, admin_list_hidden, is_system, sort, color_fg, color_bg) VALUES
  (10, '会员', 'Members', 1, 0, 0, 0, 400, '#b45309', '#fef3c7');

-- 四行的默认配色（UPDATE 同时覆盖新插的行与本地已有的行）
UPDATE ext_book_status SET color_fg = '#15803d', color_bg = '#dcfce7' WHERE code = 1;  -- 显示：绿
UPDATE ext_book_status SET color_fg = '#525252', color_bg = '#f5f5f5' WHERE code = 2;  -- 隐藏：灰
UPDATE ext_book_status SET color_fg = '#b91c1c', color_bg = '#fee2e2' WHERE code = 3;  -- 已删除：红
UPDATE ext_book_status SET color_fg = '#b45309', color_bg = '#fef3c7' WHERE code = 10; -- 会员：琥珀
