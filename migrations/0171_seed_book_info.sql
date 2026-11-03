-- 0171_seed_book_info.sql
--
-- ADR-0058：独立「书本信息」模块 `book_info`。
--
-- 参考 `D:\git\web\Vue.NetCore\vol.api.sqlsugar` 的 `BookInfo` 实体镜像：
--   BookName/Author/Chapter/ChengShu/Case/CaseTag/BookNo/ImageUrl/HotBook/
--   ParentId/Comment/OrgId/IsEnable。字段名 microfeed 惯例（snake_case），
--   `case` 为保留字故映射为 `case_division`；`parent_id` 为逻辑自引用
--   （microfeed 惯例无外键，与 `purgeAdminBook` 注释「无 REFERENCES」一致）。
--
-- 与既有 `channels`/`items` 书机制**完全解耦**：不写 channels/items、
-- 不依赖 ext_book_stats/ext_book_status/ext_category。两张书模型并行共存。
--
-- 播种 `page_book_info` 权限树页面节点（复用既有 `content:book:read`，
-- 不加新权限码——ADR-0058 决策 4）。列序按 0127 + 0133（path/entry_code/
-- audience），sort=111（group_content 下现到 110）。
--
-- 类型 seed：与 0123/0126/0127 同款，豁免 MIG-004 回滚块要求（全部幂等、
-- 纯追加，无数据回退需求）。
-- 幂等：全部 CREATE IF NOT EXISTS / INSERT OR IGNORE，重复执行安全。

CREATE TABLE IF NOT EXISTS book_info (
  id              VARCHAR(11) PRIMARY KEY,
  book_name       VARCHAR(255) NOT NULL,       -- BookName 书名
  chapter         INTEGER,                     -- Chapter 总卷章数
  author          VARCHAR(255),                -- Author 作者
  cheng_shu       VARCHAR(255),                -- ChengShu 成书时间
  case_division   VARCHAR(255) NOT NULL,       -- Case 内容划分（保留字 → case_division）
  case_tag        INTEGER NOT NULL DEFAULT 0,  -- CaseTag 内容标签
  book_no         INTEGER NOT NULL,            -- BookNo 书本编号
  image_url       VARCHAR(255),                -- ImageUrl 封面
  hot_book        INTEGER,                     -- HotBook 用途
  parent_id       VARCHAR(11),                 -- ParentId 父级（逻辑自引用）
  org_id          INTEGER,                     -- OrgId 书籍性质（列位保留，无组织模块）
  is_enable       INTEGER NOT NULL DEFAULT 1,  -- IsEnable 启用
  comment         VARCHAR(255),                -- Comment 备注
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at      TIMESTAMP,                   -- 软删除
  ext1 VARCHAR(255), ext2 VARCHAR(255), ext3 VARCHAR(255), ext4 VARCHAR(255), ext5 VARCHAR(255),
  ext6 VARCHAR(255), ext7 VARCHAR(255), ext8 VARCHAR(255), ext9 VARCHAR(255), ext10 VARCHAR(255)
);

CREATE INDEX IF NOT EXISTS book_info_book_no   ON book_info (book_no);
CREATE INDEX IF NOT EXISTS book_info_parent_id ON book_info (parent_id);
CREATE INDEX IF NOT EXISTS book_info_is_enable ON book_info (is_enable);

-- 业务约束：禁止自引用（parent_id = id），INSERT 与 UPDATE 两分支都拦。
CREATE TRIGGER IF NOT EXISTS book_info_no_self_parent_ins
BEFORE INSERT ON book_info
WHEN NEW.parent_id IS NOT NULL AND NEW.parent_id = NEW.id
BEGIN
  SELECT RAISE(ABORT, 'book_info_self_parent');
END;

CREATE TRIGGER IF NOT EXISTS book_info_no_self_parent_upd
BEFORE UPDATE OF parent_id ON book_info
WHEN NEW.parent_id IS NOT NULL AND NEW.parent_id = NEW.id
BEGIN
  SELECT RAISE(ABORT, 'book_info_self_parent');
END;

-- 播种页面节点（复用 content:book:read，不加新码）。
INSERT OR IGNORE INTO ext_permission_nodes
  (id, code, kind, parent_code, sort, audience, permission_code, name_zh, name_en,
   icon, i18n_key, is_visible, source, created_at_ms, path, entry_code)
VALUES
  ('pn_page_book_info', 'page_book_info', 'page', 'group_content', 111, 'desktop', NULL,
   '书本信息', 'Book info', 'book', NULL, 1, 'seed',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'book-info', 'content:book:read');
