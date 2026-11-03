-- 0173_schema_book_info_text_columns.sql
--
-- ADR-0058：把 `book_info` 的三列改成状态/文本语义（后台「状态」下拉 + 文本录入）。
--
-- ## 改动
--
-- - `case_tag`（内容标签）`INTEGER` → `TEXT`：改为文本录入，不再限定整数。
-- - `book_no`（书本编号）`INTEGER` → `TEXT`：同上。看板排序键随之从 `book_no`
--   换成 `book_name`（人工录入的编号不再是可比数字），故补 `book_info_book_name`
--   索引、撤掉只服务旧排序的 `book_info_book_no` 索引（`book_name` 本就 NOT NULL）。
-- - `hot_book`（状态）`INTEGER` 可空 → `NOT NULL DEFAULT 0`：状态下拉（公开/隐藏/
--   会员，迁移 0174 种子）不可为空。历史 NULL 行回填成 `0`（公开）。
--
-- ## SQLite 改列型 = 12 步表重建
--
-- SQLite 无法直接 ALTER 改列类型，走「建新表 → 复制 → 删旧 → 重命名 → 重建
-- 索引/触发器」。`INSERT INTO … SELECT` 用列名显式列举，TEXT 亲和性把旧的整数值
-- 自然转成文本（`'1'`），`hot_book` 用 `COALESCE(hot_book, 0)` 回填。复制语句不触发
-- `book_info_no_self_parent_*`（BEFORE INSERT 触发器对 `INSERT … SELECT` 同样生效，
-- 但历史行已过校验；若确有历史自引用行，属既有脏数据，不在本迁移修）。
--
-- 类型 seed（DDL）：豁免 MIG-004 回滚块要求（幂等、结构变更无数据回退需求）。
-- 幂等：CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS，重复执行安全。

CREATE TABLE IF NOT EXISTS book_info_new (
  id              VARCHAR(11) PRIMARY KEY,
  book_name       VARCHAR(255) NOT NULL,       -- BookName 书名（看板排序键）
  chapter         INTEGER,                     -- Chapter 总卷章数
  author          VARCHAR(255),                -- Author 作者
  cheng_shu       VARCHAR(255),                -- ChengShu 成书时间
  case_division   VARCHAR(255) NOT NULL,       -- Case 内容划分（保留字 → case_division）
  case_tag        TEXT NOT NULL DEFAULT '',    -- CaseTag 内容标签（文本）
  book_no         TEXT NOT NULL DEFAULT '',    -- BookNo 书本编号（文本）
  image_url       VARCHAR(255),                -- ImageUrl 封面
  hot_book        INTEGER NOT NULL DEFAULT 0,  -- HotBook 状态（0 公开 / 1 隐藏 / 2 会员）
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

INSERT INTO book_info_new (
  id, book_name, chapter, author, cheng_shu, case_division, case_tag, book_no,
  image_url, hot_book, parent_id, org_id, is_enable, comment,
  created_at, updated_at, deleted_at,
  ext1, ext2, ext3, ext4, ext5, ext6, ext7, ext8, ext9, ext10
)
SELECT
  id, book_name, chapter, author, cheng_shu, case_division, case_tag, book_no,
  image_url, COALESCE(hot_book, 0), parent_id, org_id, is_enable, comment,
  created_at, updated_at, deleted_at,
  ext1, ext2, ext3, ext4, ext5, ext6, ext7, ext8, ext9, ext10
FROM book_info;

DROP TABLE book_info;
ALTER TABLE book_info_new RENAME TO book_info;

-- 索引：排序键换 book_name，父级/启用/分组归属照旧。
CREATE INDEX IF NOT EXISTS book_info_book_name    ON book_info (book_name);
CREATE INDEX IF NOT EXISTS book_info_parent_id    ON book_info (parent_id);
CREATE INDEX IF NOT EXISTS book_info_is_enable    ON book_info (is_enable);
CREATE INDEX IF NOT EXISTS book_info_case_division ON book_info (case_division);

-- 业务约束：禁止自引用（parent_id = id）。旧表 DROP 时两条触发器一并消失，重建。
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
