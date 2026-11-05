-- 0184_seed_fang_yao.sql
--
-- ADR-0065：独立「方剂」模块 `fang_yao` / `fang_yao_body`（第六个独立中医模块，
-- 照 book-info / ming-ci / zhong_yao / book_chapter / yao-alia 解耦范式）。
--
-- 数据源 `ctwh/FangYao.sql`（804 方）+ `ctwh/FangYaoBody.sql`（2025 组成行），
-- 来自上游 `vol.api.sqlsugar` 的同名实体。
--
-- 本迁移只建表，**804 方 + 2025 组成行全走导入脚本
-- `scripts/import-ctwh/import-fangyao.mjs`**（参数化逐行 INSERT，避免迁移文件
-- 膨胀；方文格式远比名词/本草丰富，且需在导入时做花括号配平，走脚本才能零
-- 格式损失并字节级对账，照 ADR-0062 D7 / ADR-0065 决策 2）。
--
-- 与既有 `items`、`channels`、`book_info`、`ming_ci`、`zhong_yao`、
-- `book_chapter` **完全并行共存、互不读写、互不迁移**。
--
-- ## 与既有 legacy「fangs」页的区别
--
-- 后台另有 legacy 方剂页 `pn_page_fangs`（code `page_fangs`，码 `content:fang:read`，
-- 走 items 机制）。本模块是**独立表**，码、节点 id、path 全部独立：
-- `content:fang-yao:*` / `pn_page_fang_yao` / `page_fang_yao` / path `fang-yao`。
-- 两者互不复用、互不影响。
--
-- ## 与源表的列差（依据 2026-11-05 量化审计，ADR-0065 数据审计节）
--
-- 删框架列：源 Extend01–Extend12 / ExtJson / CreateOrgId / CreateID / Creator /
-- ModifyID / Modifier / OrgId / IsDelete（无业务真值；IsDelete 全 0 → 用软删
-- `deleted_at` 表达）。删无信息列：源 `FangSourceBookId`（7/804 非空，导入派生
-- `source_book_name` 已够追溯）。
--
-- **P1 甲（源 FangNo 不可作键）**：源 FangNo 在 1001000 组内重复（源 Id 481「五苓散」
-- 与 507「甘草干姜汤」同为 397）且跨书分段重叠，作 UNIQUE 排序键会 fail-fast。
-- 故 `fang_no` 改为**系统托管组内连续**（create 走 MAX+1，UNIQUE(source_book_legacy_id,
-- fang_no) 兜底），**不复用源 FangNo、不另存源值追溯列**（靠 `source_book_legacy_id`
-- + `source_fang_legacy_id` 已可反查源方）。
--
-- **P2 全量导入**：373 无组成方（46.4%）照导——`fang_yao_body` 缺行即「无组成」，
-- 非数据缺陷，不按 IsEnable 过滤。
--
-- **P3 原样保真（唯一例外：花括号配平）**：`fang_text` 的 9 类 `$单字母{}` 标记原样
-- 存不解析；15 方 `{}` 不配平**在导入脚本里补 `}` 配平**，其余一律不改（不 trim /
-- strip / 归一换行）。`amount` 内嵌 `$x{}`（22 行）原样存。`yao_legacy_id` 含 `-1`
-- 两行原样存。
--
-- `fang_drink_num` 用 VARCHAR(64) 而非数值：源含小数 `1.5` 与 NULL，文本保真最稳。
--
-- ## 权限（ADR-0065 决策 8）
--
-- 新增专属码 `content:fang-yao:read` / `content:fang-yao:manage`。不复用既有
-- `content:chapter:*`（小说章节）、`content:book:*`（book-info）也不复用 legacy
-- `content:fang:*`（fangs 页）。三镜像的另两处在 `src/shared/Constants.ts` 与
-- `src/server/rbac/seed.ts`（改后跑 `yarn rbac:gen`）。
--
-- 页面节点 sort=116（book_chapter=114、yao_alia=115 之后），icon 复用 `book`
-- （同 book-info，免新增 `menu.icon.*` 双语标签）。
--
-- 幂等：全部 CREATE IF NOT EXISTS / INSERT OR IGNORE，重复执行安全。

-- 1. 方剂主表（804 行，导入脚本写入）
CREATE TABLE IF NOT EXISTS fang_yao (
  id                     VARCHAR(11) PRIMARY KEY,  -- randomShortUUID()；源 Id(1..809,缺口[757,759,760,762,763]) 不复用
  fang_no                INTEGER NOT NULL,         -- 系统托管组内连续（create 走 MAX+1）；P1 甲：绝不复用源 FangNo（组内重复+跨书重叠）
  fang_name              VARCHAR(255) NOT NULL,    -- 方名（219 名/588 行同名，不 UNIQUE）
  source_book_legacy_id  VARCHAR(64),              -- 源 BookId（左栏分组键；5 书源组 329/202/113/111/49）
  source_book_name       VARCHAR(255),             -- 源书名（导入派生，组显示名兜底）
  source_fang_legacy_id  VARCHAR(64),              -- 源 FangYao.Id 只读历史；UNIQUE；正文导入据此映射新 id
  yao_list               TEXT,                     -- 源 YaoList（逗号分隔多值，原样；空串→NULL 由脚本归一）
  fang_text              TEXT NOT NULL,            -- 方文（9 类 $标记 原样存；{} 导入脚本配平）
  fang_drink_num         VARCHAR(64),              -- 源 FangdrinkNum（含小数 1.5 + NULL，VARCHAR 保真）
  is_enable              INTEGER NOT NULL DEFAULT 1, -- 源 IsEnable；导入全量含禁用
  signature_id           VARCHAR(64),              -- 源 SignatureId（列位保留，admin 不编辑）
  signature              VARCHAR(64),              -- 源 Signature（唯一 797/804；列位保留，不作 ETag）
  created_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at             TIMESTAMP,                -- 软删（源 IsDelete 全 0）
  ext1 VARCHAR(255), ext2 VARCHAR(255), ext3 VARCHAR(255), ext4 VARCHAR(255), ext5 VARCHAR(255),
  ext6 VARCHAR(255), ext7 VARCHAR(255), ext8 VARCHAR(255), ext9 VARCHAR(255), ext10 VARCHAR(255)
);

-- 2. 方剂组成（2025 行，导入脚本写入）
CREATE TABLE IF NOT EXISTS fang_yao_body (
  id             VARCHAR(11) PRIMARY KEY,
  fang_yao_id    VARCHAR(11) NOT NULL,   -- → fang_yao.id（逻辑引用；导入按 source_fang_legacy_id 映射）
  position       INTEGER NOT NULL,       -- 源排序键（方内唯一有序）
  show_name      VARCHAR(64) NOT NULL,   -- 药材显示名（源 2025/2025 非空；UI validateBody 亦强制非空）
  amount         VARCHAR(255),           -- 用量（内嵌 $x{} 22 行，原样存）
  extra_process  VARCHAR(64),            -- 炮制
  weight         VARCHAR(32),
  yao_legacy_id  VARCHAR(64),            -- 源 YaoID（含 -1 两行，原样存）
  is_enable      INTEGER NOT NULL DEFAULT 1,
  signature_id   VARCHAR(64),            -- 源 SignatureId（列位保留，admin 不编辑）
  signature      VARCHAR(64),            -- 源 Signature（列位保留）
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at     TIMESTAMP,              -- 软删
  ext1 VARCHAR(255), ext2 VARCHAR(255), ext3 VARCHAR(255), ext4 VARCHAR(255), ext5 VARCHAR(255),
  ext6 VARCHAR(255), ext7 VARCHAR(255), ext8 VARCHAR(255), ext9 VARCHAR(255), ext10 VARCHAR(255)
);

-- 3. 索引：点查/窄范围，避免全表扫描
-- fang_no 组内唯一（导入按源 Id 升序赋 1..N；create 走 MAX+1，冲突 fail-fast）
CREATE UNIQUE INDEX IF NOT EXISTS fang_yao_book_no        ON fang_yao (source_book_legacy_id, fang_no);
CREATE INDEX IF NOT EXISTS fang_yao_name                  ON fang_yao (fang_name);
CREATE INDEX IF NOT EXISTS fang_yao_source_book           ON fang_yao (source_book_legacy_id);
-- 正文导入脚本按源 FangYao.Id 查新 id（804 行点查，避免逐行全表扫）。
CREATE UNIQUE INDEX IF NOT EXISTS fang_yao_source_fang    ON fang_yao (source_fang_legacy_id);

-- 按方取组成（防全表扫）+ 方内排序唯一（导入用随机 id + INSERT OR REPLACE，
-- 这条唯一约束让重放变成替换而不是新增）。
CREATE INDEX IF NOT EXISTS fang_yao_body_fang             ON fang_yao_body (fang_yao_id);
CREATE UNIQUE INDEX IF NOT EXISTS fang_yao_body_position  ON fang_yao_body (fang_yao_id, position);

-- 4. 权限码（id 与 permissionId() 逐字节一致：p_<code 中 ':' → '_'>）
INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
  ('p_content_fang-yao_read',   'content:fang-yao:read',   '方剂查看'),
  ('p_content_fang-yao_manage', 'content:fang-yao:manage', '方剂维护');

-- 5. 页面节点 + 码叶子（侧栏读节点表；ADR-0038：码叶子挂 page 下）
INSERT OR IGNORE INTO ext_permission_nodes
  (id, code, kind, parent_code, sort, audience, permission_code, name_zh, name_en,
   icon, i18n_key, is_visible, source, created_at_ms, path, entry_code) VALUES
  ('pn_page_fang_yao', 'page_fang_yao', 'page', 'group_content', 116, 'desktop', NULL,
   '方剂', 'Formulas (TCM)', 'book', NULL, 1, 'seed',
   CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'fang-yao', 'content:fang-yao:read');

INSERT OR IGNORE INTO ext_permission_nodes
  (id, code, kind, parent_code, sort, audience, permission_code, name_zh, name_en,
   icon, i18n_key, is_visible, source, created_at_ms) VALUES
  ('pn_content_fang-yao_read', 'content:fang-yao:read', 'code', 'page_fang_yao', 1, 'desktop', 'content:fang-yao:read', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

INSERT OR IGNORE INTO ext_permission_nodes
  (id, code, kind, parent_code, sort, audience, permission_code, name_zh, name_en,
   icon, i18n_key, is_visible, source, created_at_ms) VALUES
  ('pn_content_fang-yao_manage', 'content:fang-yao:manage', 'code', 'page_fang_yao', 2, 'desktop', 'content:fang-yao:manage', NULL, NULL, NULL, NULL, 1, 'seed', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
