-- 0108: 给「按篇章取条文」的书页查询补一条与 ORDER BY 同形的索引，消掉临时排序
--
-- 背景：书页目录要读整本书的条文（`getTcmBookChapters` → `fetchSectionsByParents`，
-- `src/server/feed/tcmSections.ts`），SQL 形如：
--   SELECT id, status, data, pub_date, tcm_parent_id FROM items
--   WHERE tcm_kind = 'section' AND tcm_parent_id IN (…) AND status != 3
--   ORDER BY tcm_parent_id,
--            COALESCE(json_extract(data,'$._microfeed.receiptNo'),
--                     json_extract(data,'$._microfeed.no')), id
--
-- 0106 建的 `items_section_order_kind (tcm_kind, tcm_parent_id,
-- json_extract(data,'$._microfeed.receiptNo'), id)` 第三列是**裸 `receiptNo`**，而本查询的
-- ORDER BY 第三项是 `COALESCE(receiptNo, no)`。两者对 section 取值等价（本地实测：
-- receiptNo 8,066/8,066 全存在、no 8,066/8,066 全为 NULL），但 SQLite 不认「表达式同序」，
-- 于是本查询落到 `USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY`，每行步进两次。
--
-- 实测（本地 D1 副本，Miniflare `meta.rows_read`，黄帝内经·素问 2,883 条文）：
--   现状（items_section_order_kind + TEMP B-TREE）  rows_read 6,010
--   加本索引后                                      rows_read 3,127
-- 返回行数一条没变（2,883）；省下的是为排序而多步进的那一倍。素问书页合计约 6,300 → 3,400。
--
-- 为什么保留 `tcm_kind` 作首列：中药 / 名词的条目也挂在篇章（chapter）下
-- （yao 172 + term 17），去掉 `tcm_kind = 'section'` 会把它们串进书页条文；过滤必须留，
-- 只能让索引列序把「过滤 + 排序」一次走完。
--
-- 为什么另建一条而不是改 0106 那条：0106 的索引是为 App 端
-- `getAppChapterContent`（`src/server/tcm/reads.ts:405`，ORDER BY 写的是裸 `receiptNo`）
-- 建的，改它会动到那条单 parent 查询的索引序；两条索引列序不同形、各服务一条查询，
-- 属可接受的近重复（代价见 0106：单行写入 +0.3%）。
--
-- `data` 仍是唯一事实来源；纯索引，不改任何写入路径。
-- 回滚：DROP INDEX items_section_order_kind2;

CREATE INDEX IF NOT EXISTS items_section_order_kind2
  ON items (
    tcm_kind,
    tcm_parent_id,
    COALESCE(json_extract(data, '$._microfeed.receiptNo'), json_extract(data, '$._microfeed.no')),
    id
  );
