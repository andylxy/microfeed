-- 0181_seed_book_chapter.sql
--
-- ADR-0062：独立「书本卷章」模块 `book_chapter` / `book_chapter_body`。
--
-- 数据源 `ctwh/BookChapter.sql`（445 卷章目录）+ `ctwh/BookChapterBody.sql`
-- （8066 正文），来自上游 `vol.api.sqlsugar` 的同名实体。上游把「神农本草经」
-- 「神农本草经疏」等 10 本书塞进这两张表，并用三个挪用的框架字段在运行时反抽
-- 本草药材（IsEnable 当判别式、Extend01 当等级、BieMing 当药名+别名）。
--
-- 本迁移只建表，**卷章目录由 0182 播种、正文 8066 行走导入脚本
-- `scripts/import-ctwh/import-chapter-body.mjs`**（避免迁移文件膨胀，且正文
-- 格式远比本草/名词丰富，走参数化脚本才能零格式损失）。
--
-- 与既有 `items`(`tcm_kind='chapter'/'section'`)、`channels`、`book_info`、
-- `ming_ci`、`zhong_yao` **完全并行共存、互不读写、互不迁移**（照 ADR-0060/0061
-- 解耦范式）。两套卷章模型并存是 ADR-0062 明示的取舍。
--
-- ## 与源表的列差（依据 2026-11-04 量化审计）
--
-- 删全空列：两表 `ParentId` 全空（源从未用层级，UI 平铺按书分组）；body 另删
-- SectionVideoUrl / SectionTerm / JingMai / TeDian / ShiCi / ShiYi / Notes /
-- ZhuZhi / ZhenJiu / AiJiu / PeiWu / OtherMark 共 12 个领域列（源 0/8066 非空）。
--
-- 删框架列：Extend02–Extend12 / ExtJson / CreateOrgId / CreateID / Creator /
-- ModifyID / Modifier / OrgId（无业务真值）。
--
-- **Extend01 不删**：其语义是本草等级 `YaoEnum`（'0'=正文/上经 545、'1'=别本
-- 385），有真值且有联结价值，保留为显式列 `bencao_level`（ADR-0062 决策 2）。
-- 同理 `BieMing` 保留原义并派生 `bencao_yao_name`（药名联结键）。
--
-- `chapter_section` 用 VARCHAR(64) 而非 INTEGER：源值跨书异构
-- （0..26 / 4001001..4001080 / 904000203 混杂、9040000 缺口 894960192），
-- 统一文本保真最稳。它**不可作排序键**，仅源保真可追溯；显示排序一律
-- `chapter_no`（ADR-0062 决策 4）。
--
-- ## 权限（ADR-0062 决策 8）
--
-- 新增专属码 `content:book-chapter:read` / `content:book-chapter:manage`。
-- 不复用既有 `content:chapter:*`（已被小说章节机制占用）也不复用
-- `content:book:*`（book-info 占用）。连字符合法，先例 `content:book-status:manage`。
-- 三镜像的另两处在 `src/shared/Constants.ts` 与 `src/server/rbac/seed.ts`。
--
-- 页面节点 sort=114（本草=113、ming-ci=112 之后），icon 复用 `book`
-- （同 book-info，免新增 `menu.icon.*` 双语标签）。
--
-- 幂等：全部 CREATE IF NOT EXISTS / INSERT OR IGNORE，重复执行安全。

-- 1. 卷章目录（445 行，0182 播种）
CREATE TABLE IF NOT EXISTS book_chapter (
  id                     VARCHAR(11) PRIMARY KEY,  -- randomShortUUID()；源 Id(1..449) 不复用
  chapter_no             INTEGER NOT NULL,         -- 显示/排序序号（create 走 MAX+1）；绝不复用源 ChapterSection
  chapter_header         VARCHAR(255) NOT NULL,    -- ChapterHeader 标题（必填；14 行含 $a{}/$r{} 标记原样存不解析）
  source_book_id         VARCHAR(11),              -- → book_info.id（逻辑引用，无硬外键，下拉选书）
  source_book_name       VARCHAR(255),             -- 源 BookName 只读历史（153/445 NULL，缺失靠 book_info 书名兜底）
  source_book_legacy_id  VARCHAR(64),              -- 源 BookId 只读历史（如 10001），可追溯
  source_chapter_legacy_id VARCHAR(64),            -- 源 BookChapter.Id 只读历史；正文导入脚本据此把 BookChapterId 映射到新 id
  chapter_section        VARCHAR(64),              -- 源 ChapterSection 保真（跨书异构，仅追溯，不排序）
  is_enable              INTEGER NOT NULL DEFAULT 1, -- 源 343=1 / 102=0；导入全量含禁用
  signature_id           VARCHAR(64),              -- 源 SignatureId（列位保留，admin 不编辑）
  signature              VARCHAR(64),              -- 源 Signature（非唯一 415/445；列位保留，不作 ETag）
  created_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at             TIMESTAMP,                -- 软删（源 IsDelete 全 0）
  ext1 VARCHAR(255), ext2 VARCHAR(255), ext3 VARCHAR(255), ext4 VARCHAR(255), ext5 VARCHAR(255),
  ext6 VARCHAR(255), ext7 VARCHAR(255), ext8 VARCHAR(255), ext9 VARCHAR(255), ext10 VARCHAR(255)
);

-- 2. 卷章正文（8066 行，导入脚本写入）
CREATE TABLE IF NOT EXISTS book_chapter_body (
  id              VARCHAR(11) PRIMARY KEY,
  book_chapter_id VARCHAR(11) NOT NULL,           -- → book_chapter.id（逻辑引用；审计 100% 非空、0 悬空）
  receipt_no      INTEGER NOT NULL,               -- ReceiptNo 源排序键（卷章内唯一有序）
  section_text    TEXT NOT NULL,                  -- SectionText 正文（$a{265}/$m{34}/$n{36}/$x{49}，原样存储不解析）
  section_note    TEXT,                           -- SectionNote 注释（17.7% 非空）
  fang_ji         TEXT,                           -- FangJi 方剂（空串→NULL 归一；逗号分隔多值）
  fang_ji_zhujie  TEXT,                           -- FangJiZhujie 方剂注解（1.0% 非空）
  bie_ming        TEXT,                           -- BieMing 本草「药名+别名」原文（930 行非空，逗号分隔，首段=药名）
  bencao_yao_name VARCHAR(64),                    -- 本草药名联结键 = bie_ming 首逗号段（导入派生，仅 930 行非空；二期合并点查）
  bencao_level    VARCHAR(4),                     -- 本草等级 = 源 Extend01（'0'=545 / '1'=385；显式领域列不挪用框架）
  is_enable       INTEGER NOT NULL DEFAULT 1,     -- 源 930=1 / 7136=0；回归「启用」本义，仅行级展示开关；判别本草用 bencao_yao_name
  signature_id    VARCHAR(64),                    -- 源 SignatureId（列位保留，admin 不编辑）
  signature       VARCHAR(64),                    -- 源 Signature（非唯一 8037/8066；列位保留）
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at      TIMESTAMP,                      -- 软删（源 IsDelete 全 0）
  ext1 VARCHAR(255),                              -- 收纳源 SectionVideoMemo（0.1% 非空 5 行）
  ext2 VARCHAR(255), ext3 VARCHAR(255), ext4 VARCHAR(255), ext5 VARCHAR(255),
  ext6 VARCHAR(255), ext7 VARCHAR(255), ext8 VARCHAR(255), ext9 VARCHAR(255), ext10 VARCHAR(255)
);

-- 3. 索引：点查/窄范围，避免全表扫描（08 册）
CREATE INDEX IF NOT EXISTS book_chapter_header       ON book_chapter (chapter_header);
CREATE INDEX IF NOT EXISTS book_chapter_source_book  ON book_chapter (source_book_id);
-- 正文导入脚本按源 BookChapter.Id 查新 id（445 行点查，避免逐行全表扫）。
CREATE INDEX IF NOT EXISTS book_chapter_source_legacy ON book_chapter (source_chapter_legacy_id);
CREATE INDEX IF NOT EXISTS book_chapter_book_no      ON book_chapter (source_book_id, chapter_no);
-- chapter_no 唯一（种子 1..445；create 走 MAX+1，冲突 fail-fast）
CREATE UNIQUE INDEX IF NOT EXISTS book_chapter_no_unique ON book_chapter (chapter_no);

-- 按卷章取正文（防全表扫）+ 卷章内排序 + 二期合并点查（仅 930 行非空）
CREATE INDEX IF NOT EXISTS book_chapter_body_chapter ON book_chapter_body (book_chapter_id);
-- 卷章内 receipt_no 唯一：正文导入用随机 id + INSERT OR REPLACE，没有这条唯一约束
-- 复跑会整批再插一遍（8066 → 16132）。唯一索引让重放变成替换而不是新增。
CREATE UNIQUE INDEX IF NOT EXISTS book_chapter_body_receipt ON book_chapter_body (book_chapter_id, receipt_no);
CREATE INDEX IF NOT EXISTS book_chapter_body_yao     ON book_chapter_body (bencao_yao_name);

-- 4. 权限码（id 与 permissionId() 逐字节一致：p_<code 中 ':' → '_'>）
INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
  ('p_content_book-chapter_read',   'content:book-chapter:read',   '书本卷章查看'),
  ('p_content_book-chapter_manage', 'content:book-chapter:manage', '书本卷章维护');

-- 5. 页面节点 + 码叶子（侧栏读节点表；ADR-0038：码叶子挂 page 下）
INSERT OR IGNORE INTO ext_permission_nodes
  (id, code, kind, parent_code, sort, audience, permission_code, name_zh, name_en,
   icon, i18n_key, is_visible, source, created_at_ms, path, entry_code) VALUES
  ('pn_page_book_chapter', 'page_book_chapter', 'page', 'group_content', 114, 'desktop', NULL,
   '书本卷章', 'Book chapters', 'book', NULL, 1, 'seed',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'book-chapter', 'content:book-chapter:read');

INSERT OR IGNORE INTO ext_permission_nodes
  (id, code, kind, parent_code, sort, audience, permission_code, name_zh, name_en,
   icon, i18n_key, is_visible, source, created_at_ms) VALUES
  ('pn_content_book-chapter_read', 'content:book-chapter:read', 'code', 'page_book_chapter', 1, 'desktop', 'content:book-chapter:read', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

INSERT OR IGNORE INTO ext_permission_nodes
  (id, code, kind, parent_code, sort, audience, permission_code, name_zh, name_en,
   icon, i18n_key, is_visible, source, created_at_ms) VALUES
  ('pn_content_book-chapter_manage', 'content:book-chapter:manage', 'code', 'page_book_chapter', 2, 'desktop', 'content:book-chapter:manage', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
