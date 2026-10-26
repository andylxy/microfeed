-- 0151_cleanup_search_storage.sql
--
-- 全文搜索存储层退役（ADR-0051）：公开站搜索确认无人使用（低流量个人站，
-- 站长拍板 2026-10-25），App 搜索为本地实现（/api/app/search-permission 只是
-- 权限查询，不读本存储层），后台列表搜索由 items 直查承接（同批代码）。
--
-- ## 删除清单（2026-10-25 本地库实测）
--
-- 触发器 9 条：
--   items 上 3 条（items_site_search_after_insert/update/delete）
--   pages 上 3 条（pages_site_search_after_insert/update/delete）
--   site_search_documents 上 3 条二级（分叉到 exact / title_trigram）
--
-- 表族 15 张（site_search_* 14 张 + 同属检索存储的 item_search_metadata；
-- site_search 族实测 15.3 MB @9,506 行，10 万行规模外推 ≈160 MB）：
--   site_search_documents（主文档：title + content_text 全文副本）
--   site_search_metadata（ready 标记，search.ts:452 的读点随同批代码删除）
--   site_search_exact（FTS5）+ 影子 5 张（_data/_idx/_content/_docsize/_config）
--   site_search_title_trigram（FTS5）+ 影子 5 张
--   item_search_metadata（0009 建，检索进度标记；search.ts 删除后零读者，0 行）
--
-- ## 收益（量化，ADR-0051）
--
--   库容：-160 MB @10 万行（全库 500–660 MB → 340–500 MB，回免费单库上限内）
--   写连带：items/pages 每写一行的派生行 10.21 → ~4（typeahead 仍在）
--   导入：100 本书 112 万行写 → ~50 万（免费计划 1 日灌库 + 4 日派生）
--
-- ## 部署约束
--
-- ⚠️ 必须与同批代码（公开搜索端点下线 + 后台搜索改道）同一次 manage deploy
-- 上线：先应用本迁移而旧代码在线，会让 /search/ 与 /admin/ajax/search/ 500。
--
-- ## 保留
--
--   ext_admin_typeahead 族（6 张 + items 上 3 条触发器）：webhooks 事件浏览器
--   的条目候选在用，与全文搜索无关。
--   app:search:global / app:search:book 权限码与 /api/app/search-permission
--   端点：App 搜索权限查询，零依赖本存储层。
--
-- 幂等：DROP ... IF EXISTS。type = cleanup，回滚块照写：
-- rollback:
--   1. 从 git 历史取 src/shared/ItemSearchSql.ts 的 CREATE_SITE_SEARCH_INDEX_SQL
--      （本迁移同批删除前的版本）重建表族与 9 条触发器；
--   2. 全量回填：DELETE FROM site_search_documents; 之后对 items 与 pages 各行
--      执行一次无关 UPDATE（或 INSERT..SELECT 直灌 documents，二级触发器自动
--      分叉 exact/trigram）；行写代价 = 10.21 连带 × 全表行数，注意 D1 日写额度。

DROP TRIGGER IF EXISTS items_site_search_after_insert;
DROP TRIGGER IF EXISTS items_site_search_after_update;
DROP TRIGGER IF EXISTS items_site_search_after_delete;
DROP TRIGGER IF EXISTS pages_site_search_after_insert;
DROP TRIGGER IF EXISTS pages_site_search_after_update;
DROP TRIGGER IF EXISTS pages_site_search_after_delete;
DROP TRIGGER IF EXISTS site_search_documents_after_insert;
DROP TRIGGER IF EXISTS site_search_documents_after_update;
DROP TRIGGER IF EXISTS site_search_documents_after_delete;

-- FTS5 虚拟表的 DROP 自动带走各自影子表；随后的影子表 IF EXISTS 兜底幂等。
DROP TABLE IF EXISTS site_search_exact;
DROP TABLE IF EXISTS site_search_title_trigram;
DROP TABLE IF EXISTS site_search_documents;
DROP TABLE IF EXISTS site_search_metadata;
DROP TABLE IF EXISTS site_search_exact_data;
DROP TABLE IF EXISTS site_search_exact_idx;
DROP TABLE IF EXISTS site_search_exact_content;
DROP TABLE IF EXISTS site_search_exact_docsize;
DROP TABLE IF EXISTS site_search_exact_config;
DROP TABLE IF EXISTS site_search_title_trigram_data;
DROP TABLE IF EXISTS site_search_title_trigram_idx;
DROP TABLE IF EXISTS site_search_title_trigram_content;
DROP TABLE IF EXISTS site_search_title_trigram_docsize;
DROP TABLE IF EXISTS site_search_title_trigram_config;

-- 0009_item_search.sql 建的检索进度标记：全文搜索退役后零读者、本地实测 0 行，
-- 与 site_search_metadata 同批清掉，避免留一张无人读写的孤儿表。
DROP TABLE IF EXISTS item_search_metadata;
