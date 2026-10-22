-- 0142_seed_book_status.sql
--
-- 书籍状态字典：把「一本书有哪些状态」从代码常量搬进数据表，运营在后台自助增删。
--
-- 搬迁前，状态集合固定在三处：STATUSES 常量（src/shared/Constants.ts）、
-- 书籍编辑表单的 visibilityOptions（BooksApp.tsx）、前台查询的 status = 1
-- （extCategory.ts 的前台查询；本批同源码改动把剩余一处分类导航计数也迁完）。
-- 新增或停用一种状态要同时改代码再部署，运营侧无从下手。本迁移建
-- ext_book_status 表，把「表单可选 / 前台可见 / 后台列表隐藏 /
-- 系统保护」变成每行的开关，增删状态从此只在这张表上发生。
--
-- 行为一致：种子行 1/2/3 与搬迁前逐项相同——
--   表单两项（显示 1 / 隐藏 2）、前台只显示 1、后台列表排除 3（删除态）。
-- 自定义行的 code 从 10 起由服务端自动分配（1–9 留给系统语义，避免与
-- STATUSES 里 items 侧的常量撞车）。表的 code 列带 1..127 检查，对应
-- channels.status 的 TINYINT 量程。
--
-- 同批登记后台入口「书籍状态」（/admin/book-statuses/）：权限码
-- content:book-status:manage，只授 super_admin（靠 * 通配天然拥有），
-- editor / readonly 不授予。ext_menu 与 ext_permission_nodes 两张表都写：
-- 0133 起侧栏读节点表，菜单行给只读页与一致性测试用。组内排序 book_statuses
-- 占 102，volumes 至 term 顺延一位，page_media 让出 111 改 112。
--
-- type = schema + seed。回滚块照写：
-- rollback:
--   UPDATE ext_permission_nodes SET sort = 111 WHERE code = 'page_media';
--   UPDATE ext_permission_nodes SET sort = 102 WHERE code = 'page_volumes';
--   UPDATE ext_permission_nodes SET sort = 103 WHERE code = 'page_categories';
--   UPDATE ext_permission_nodes SET sort = 104 WHERE code = 'page_all_items';
--   UPDATE ext_permission_nodes SET sort = 106 WHERE code = 'page_annotation_markers';
--   UPDATE ext_permission_nodes SET sort = 107 WHERE code = 'page_fangs';
--   UPDATE ext_permission_nodes SET sort = 108 WHERE code = 'page_aliases';
--   UPDATE ext_permission_nodes SET sort = 109 WHERE code = 'page_yao';
--   UPDATE ext_permission_nodes SET sort = 110 WHERE code = 'page_term';
--   UPDATE ext_menu SET sort = 102 WHERE code = 'volumes';
--   UPDATE ext_menu SET sort = 103 WHERE code = 'categories';
--   UPDATE ext_menu SET sort = 104 WHERE code = 'all_items';
--   UPDATE ext_menu SET sort = 106 WHERE code = 'annotation_markers';
--   UPDATE ext_menu SET sort = 107 WHERE code = 'fangs';
--   UPDATE ext_menu SET sort = 108 WHERE code = 'aliases';
--   UPDATE ext_menu SET sort = 109 WHERE code = 'yao';
--   UPDATE ext_menu SET sort = 110 WHERE code = 'term';
--   DELETE FROM ext_permission_nodes WHERE code IN ('content:book-status:manage', 'page_book_statuses');
--   DELETE FROM ext_menu WHERE code = 'book_statuses';
--   DELETE FROM ext_permissions WHERE code = 'content:book-status:manage';
--   DROP TABLE IF EXISTS ext_book_status;
--
-- 幂等：全部 INSERT OR IGNORE / CREATE TABLE IF NOT EXISTS，重复执行安全。

-- 1. 状态字典表
CREATE TABLE IF NOT EXISTS ext_book_status (
  code              INTEGER PRIMARY KEY CHECK (code BETWEEN 1 AND 127),
  name_zh           TEXT NOT NULL,
  name_en           TEXT NOT NULL,
  form_selectable   INTEGER NOT NULL DEFAULT 1,   -- 书籍编辑表单可选
  public_visible    INTEGER NOT NULL DEFAULT 0,   -- 前台可见（书架/分类/搜索/详情）
  admin_list_hidden INTEGER NOT NULL DEFAULT 0,   -- 后台书籍列表隐藏（删除态）
  is_system         INTEGER NOT NULL DEFAULT 0,   -- 系统行，不可删除
  sort              INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. 系统行：与搬迁前的行为逐项一致
INSERT OR IGNORE INTO ext_book_status
  (code, name_zh, name_en, form_selectable, public_visible, admin_list_hidden, is_system, sort) VALUES
  (1, '显示', 'Visible',  1, 1, 0, 1, 100),
  (2, '隐藏', 'Hidden',   1, 0, 0, 1, 200),
  (3, '已删除', 'Deleted', 0, 0, 1, 1, 300);

-- 3. 权限码（id 与 permissionId() 逐字节一致：p_<code 中 ':' → '_'>）
INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
  ('p_content_book-status_manage', 'content:book-status:manage', '书籍状态管理');

-- 4. 菜单行（ext_menu：给只读页与一致性测试）
INSERT OR IGNORE INTO ext_menu
  (id, code, parent_code, path, i18n_key, icon, permission_code, sort, is_visible, created_at_ms) VALUES
  ('m_book_statuses', 'book_statuses', 'group_content', 'book-statuses', 'menu.item.book_statuses', 'list-checks', 'content:book-status:manage', 102, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- 5. 侧栏真正读的页面节点 + 角色编辑器里的码叶子
INSERT OR IGNORE INTO ext_permission_nodes
  (id, code, kind, parent_code, sort, audience, permission_code, name_zh, name_en, icon, i18n_key, is_visible, source, created_at_ms, path, entry_code) VALUES
  ('pn_page_book_statuses', 'page_book_statuses', 'page', 'group_content', 102, 'desktop', NULL, '书籍状态', 'Book statuses', 'list-checks', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'book-statuses', 'content:book-status:manage');

INSERT OR IGNORE INTO ext_permission_nodes
  (id, code, kind, parent_code, sort, audience, permission_code, name_zh, name_en, icon, i18n_key, is_visible, source, created_at_ms) VALUES
  ('pn_content_book-status_manage', 'content:book-status:manage', 'code', 'page_book_statuses', 0, 'desktop', 'content:book-status:manage', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- 6. 组内排序顺延：volumes..term 各让一位，page_media 改 112（绝对赋值，可重放）
UPDATE ext_permission_nodes SET sort = 103 WHERE code = 'page_volumes';
UPDATE ext_permission_nodes SET sort = 104 WHERE code = 'page_categories';
UPDATE ext_permission_nodes SET sort = 105 WHERE code = 'page_all_items';
UPDATE ext_permission_nodes SET sort = 107 WHERE code = 'page_annotation_markers';
UPDATE ext_permission_nodes SET sort = 108 WHERE code = 'page_fangs';
UPDATE ext_permission_nodes SET sort = 109 WHERE code = 'page_aliases';
UPDATE ext_permission_nodes SET sort = 110 WHERE code = 'page_yao';
UPDATE ext_permission_nodes SET sort = 111 WHERE code = 'page_term';
UPDATE ext_permission_nodes SET sort = 112 WHERE code = 'page_media';

UPDATE ext_menu SET sort = 103 WHERE code = 'volumes';
UPDATE ext_menu SET sort = 104 WHERE code = 'categories';
UPDATE ext_menu SET sort = 105 WHERE code = 'all_items';
UPDATE ext_menu SET sort = 107 WHERE code = 'annotation_markers';
UPDATE ext_menu SET sort = 108 WHERE code = 'fangs';
UPDATE ext_menu SET sort = 109 WHERE code = 'aliases';
UPDATE ext_menu SET sort = 110 WHERE code = 'yao';
UPDATE ext_menu SET sort = 111 WHERE code = 'term';
