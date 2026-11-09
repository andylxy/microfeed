-- 0194_data_retire_book_status_module.sql
--
-- ADR-0072：退役书籍状态字典（`ext_book_status`）与 `/admin/book-statuses/` 管理入口。
--
-- 背景：0142 把「一本书有哪些状态」从代码常量搬进 `ext_book_status`（运营在后台
-- 自助增删）；0143 加配色列与「会员」(10) 种子行。新前台引擎（front-site-catalog-switch，
-- ADR-0066）明确禁止 `channels.status` / `ext_book_status`（零耦合不变式），且本字典是
-- 旧链路前台可见性判据（`extCategory.ts` 读 `public_visible`）。本迁移把它整体退役：
-- `channels.status` 列保留（值 1/2/3/10 的语义回退到代码常量 `STATUSES` +
-- `MEMBER_BOOK_STATUS`，见 `src/shared/Constants.ts`），`extCategory.ts` 的前台可见集
-- 改回常量 `STATUSES.PUBLISHED`（与删表前 `public_visible` 集合 {1} 逐项一致）。
--
-- 本迁移只删数据与表结构，**不**恢复 0142 的 sort 顺延（菜单按 sort 排，102 让位空出
-- 无害；部分退役项 sort 历史复杂，反向顺延易误改）。`ext_menu` 表已随 0168 删除
-- （ADR-0057，侧栏读 `ext_permission_nodes`），无菜单行可删。
--
-- 快照分类：`SNAPSHOT_TABLES.durable` 的 `ext_book_status` 条目**保留**（ADR-0068
-- 先例：移除会让旧快照恢复两处硬失败），只改注释。
--
-- 行数与引用为 2026-11-09 本地真库只读探针结果：`ext_book_status` 4 行（1/2/3/10）、
-- `ext_role_permissions` 无 `p_content_book-status_manage` 引用（0 行）、
-- `ext_permission_nodes` 2 行（page_book_statuses + content:book-status:manage）、
-- `ext_permissions` 1 行。无角色授权 ⇒ `ext_user_permissions` 聚合不含该码，无需重算。
--
-- type = data。
--
-- rollback:（只还原结构与迁移种子；运营自建行与手改文案不回溯）
--   CREATE TABLE IF NOT EXISTS ext_book_status (
--     code              INTEGER PRIMARY KEY CHECK (code BETWEEN 1 AND 127),
--     name_zh           TEXT NOT NULL,
--     name_en           TEXT NOT NULL,
--     form_selectable   INTEGER NOT NULL DEFAULT 1,
--     public_visible    INTEGER NOT NULL DEFAULT 0,
--     admin_list_hidden INTEGER NOT NULL DEFAULT 0,
--     is_system         INTEGER NOT NULL DEFAULT 0,
--     sort              INTEGER NOT NULL DEFAULT 0,
--     color_fg          TEXT,
--     color_bg          TEXT,
--     created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
--     updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
--   );
--   INSERT OR IGNORE INTO ext_book_status
--     (code, name_zh, name_en, form_selectable, public_visible, admin_list_hidden, is_system, sort, color_fg, color_bg) VALUES
--     (1, '显示', 'Visible', 1, 1, 0, 1, 100, '#15803d', '#dcfce7'),
--     (2, '隐藏', 'Hidden', 1, 0, 0, 1, 200, '#525252', '#f5f5f5'),
--     (3, '已删除', 'Deleted', 0, 0, 1, 1, 300, '#b91c1c', '#fee2e2'),
--     (10, '会员', 'Members', 1, 0, 0, 0, 400, '#b45309', '#fef3c7');
--   INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
--     ('p_content_book-status_manage', 'content:book-status:manage', '书籍状态管理');
--   INSERT OR IGNORE INTO ext_permission_nodes
--     (id, code, kind, parent_code, sort, audience, permission_code, name_zh, name_en, icon, i18n_key, is_visible, source, created_at_ms, path, entry_code) VALUES
--     ('pn_page_book_statuses', 'page_book_statuses', 'page', 'group_content', 102, 'desktop', NULL, '书籍状态', 'Book statuses', 'list-checks', NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'book-statuses', 'content:book-status:manage'),
--     ('pn_content_book-status_manage', 'content:book-status:manage', 'code', 'page_book_statuses', 0, 'desktop', 'content:book-status:manage', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- 1. 删权限节点（code 叶 + page 节点；`ext_permission_nodes` 无自引用 FK，顺序无关）
DELETE FROM ext_permission_nodes
 WHERE code IN ('page_book_statuses', 'content:book-status:manage');

-- 2. 删权限码（`ext_role_permissions` 无该码引用，直接删）
DELETE FROM ext_permissions
 WHERE code = 'content:book-status:manage';

-- 3. 删状态字典表（`channels.status` 无 FK 指向它，值保留）
DROP TABLE IF EXISTS ext_book_status;
