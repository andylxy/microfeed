# ADR-0024: D1 读代价基线审计——无全表扫描，成本集中在「整本读取」

- 状态：Accepted（审计；已实施备选 1 的索引修复，见 D5）
- 日期：2026-10-12
- 决策人：用户 + 设计评审
- 关联设计：ADR-0011（`rows_read` 为代价单位、keyset 取代 OFFSET）、ADR-0012（物化 + 触发器失效）、ADR-0016（公开读路径缓存 TTL）、ADR-0017（读路径批处理 / 窄投影 / 表达式索引）、`CONTEXT.md` 的「数据层（D1）」
- 本次探针：`.scratch/d1-probe/{schema,eqp,eqp2,eqp3,quant,rows-read,why-6300,prove-fix}.mjs`

## 背景

远程 D1 免费额度 5,000,000 `rows_read`/日。用户提问：**本项目在本地 D1 上是否存在全表扫描？** 本 ADR 记录一次全量审计的结论与基线，供后续判断「贵不贵」时对照，避免重复发现。

## 方法

两条独立证据，缺一不可：

1. **`EXPLAIN QUERY PLAN`**（判「用没用索引」）：覆盖 `src/server/**` 与 `src/pages/**` 里所有 `items` / `channels` 读取点。
2. **Miniflare 绑本地 D1、跑真实 SQL 累加 `meta.rows_read`**（判「贵不贵」）：`EXPLAIN QUERY PLAN` 只能判索引，判不了步进行数——走索引的查询照样可能步进整表（OFFSET 分页就是）。

关键判读（照 `CONTEXT.md`「行读（rows_read）」）：EQP 里的 `SCAN` **不等于**贵——`SCAN <小表>`、`SCAN <表> USING INDEX`、`SCAN json_each VIRTUAL TABLE`（表值函数，不计入任何真实表）、带 `LIMIT` 的索引游走，都不是全表扫描。

## 结论

### 1｜`items`（9,506 行）上没有任何全表扫描

所有公开热点查询都走索引 `SEARCH`。EQP 里出现的 `SCAN` 全部落在：

| 类别 | 例子（实测行数） |
|---|---|
| 小表裸扫描 | `SCAN channels`(13)、`SCAN ext_category`(4)、`SCAN auth_user`(4)、`SCAN ext_menu`(31) |
| 小表覆盖索引扫描 | `SCAN ext_book_stats USING COVERING INDEX`(13)、`themes`(13)、`ext_app_rollout`(1) |
| 带 LIMIT 的索引游走 | `listAdminItems` / `latestItems`（`SCAN items USING INDEX items_updated_at` + `LIMIT 20`） |
| 表值函数 | `fang-references` 的 `SCAN json_each VIRTUAL TABLE`（不计入真实表） |

唯一 EQP 报 `SCAN items`（不带 `USING`）的是**后台** webhook 资源选择器（`src/server/webhooks/explorer.ts`，`lower(json_extract(data,'$.title')) LIKE ?`）——实测 `rows_read` 仅 **41**（`LIMIT 20` 提前停）。**它既不是公开路径，也不是真全表扫描。**

⇒ **无需为「消除全表扫描」新增任何索引**；0092–0107 的表达式索引 + 0103 的物化已经把扫描清干净。

### 2｜真正的成本是「整本读取」——而其中近一半是**可消除的排序临时表**

书页目录（`getTcmBookChapters` + `fetchSectionsByParents` + `getTcmBookFang`）与阅读页标注层（`markerPopover.bookSections`）都会读该书的**全部条目**。它们是索引 seek（不是扫描），但行数多：

| 书 | 篇章 | 条文 | 方剂 | 书页估算 rows_read |
|---|---:|---:|---:|---:|
| 黄帝内经·素问 `drsRImTi5tv` | 81 | 2,883 | 0 | **≈6,300** |
| 伤寒杂病论·(桂林古本) `5IGM9t76quT` | 31 | 984 | 329 | ≈2,600 |
| 金匮要略·(宋版) `ydyQltIuQv6` | 22 | 435 | 202 | ≈1,270 |
| 难经 `tZYk25WiJ0R` | 81 | 165 | 0 | ≈620 |

**素问书页 6,300 的分解**（实测）：

| 组成 | rows_read | 说明 |
|---|---:|---|
| `fetchSectionsByParents`（2,883 条条文） | **6,010** | 占 ~95%，是全部重点 |
| `getTcmBookChapters`（81 篇章） | 163 | 2.01×（同为排序放大，量小） |
| 其余（探测 / `getBookById` / feed 窗口 / 导航 / 首页物化） | ≈115 | 小表与点查 |

**6,010 里的 2× 来自 `USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY`，不是「索引 + 回表」的固有代价。** 机制：查询带 `tcm_kind='section'` 等值条件，规划器因此选中 `items_section_order_kind (tcm_kind, tcm_parent_id, json_extract(data,'$._microfeed.receiptNo'), id)`——它的第三列是**裸 `receiptNo`**，而 `ORDER BY` 的第三项是 `COALESCE(receiptNo, no)`，两者不同形 ⇒ 末尾两项要排序 ⇒ 每行被步进两次。

实测四组对照（同一结果集 2,883 行）：

| 变体 | rows_read | 计划 |
|---|---:|---|
| A 覆盖投影（只取 `tcm_parent_id`），无 `ORDER BY` | 3,127 | `items_section_order_kind`，无排序 |
| **B 现状**（`tcm_kind` + `ORDER BY`） | **6,010** | `items_section_order_kind` + **TEMP B-TREE** |
| C 去掉 `tcm_kind` 过滤（`ORDER BY` 不变） | 3,127 | 改用 `items_section_order`，**无排序** |
| D 只取 `title`（含回表），无 `ORDER BY` | 3,127 | 无排序 ⇒ **回表本身不加倍** |

⇒ 排序是唯一的 2× 来源；回表不是。**修复已证明有效**（沙箱实测，见「验证」）：加一条列序与 `ORDER BY` 完全同形的索引
`items (tcm_kind, tcm_parent_id, COALESCE(json_extract(data,'$._microfeed.receiptNo'), json_extract(data,'$._microfeed.no')), id)`
后，**现状查询原样降到 3,127，TEMP B-TREE 消失**。素问书页因此可从 ≈6,300 降到 **≈3,300**（app 真实 SQL 实测 3,045，−48%）。

**残余排序放大全量清单（0108 后）**：把仓库里所有带 `ORDER BY`/`GROUP BY` 的读路径跑一遍 EQP + `meta.rows_read`（探针 `.scratch/d1-probe/sort-amp.mjs`，22 条），除本查询外仍有 `TEMP B-TREE` 的只剩**小结果集**：

| 查询 | rows_read | 返回 | 放大 | 备注 |
|---|---:|---:|---:|---|
| `getTcmBookChapters` / `getAppBookChapters`（篇章） | 163 | 81 | 2.0× | 每个 TCM 书页 / App（缓存） |
| `yaoAliases` 臂1（`ORDER BY id`） | 344 | 172 | 2.0× | App `GetAliaZhongYao`（缓存 24h） |
| `listCategoryNav`（`GROUP BY`） | 60 | 4 | 15× | 每个公开页 |
| `listPublishedBookSamples` | 25 | 12 | 2.1× | 首页 / 书页 |
| `getAppNav` | 29 | 8 | 3.6× | App（缓存 24h） |
| `readAdminMenu` | 62 | 31 | 2.0× | 每后台页 |
| `searchPublishedBooks` | 25 | 12 | 2.1× | 搜索页 |
| `listAdminAnnouncements` | 6 | 3 | 2.0× | Admin |

全部 `rows_read ≤ 344`、单次浪费 ≤172 行，且多在缓存或 Admin 路径上；合计每个书页的残余排序浪费 ≈150 行（相对 3,045 的条文读取是噪声）。**不值得再为它们加索引。** 已索引友好的对照：`getTcmBookEntries`(1.01×)、`getTcmBookFang`(1.00×)、`getAppAllYao`(1.00×)、`yaoAliases` 臂2(1.00×)、`markerPopover bookSections`(1.00×)。

### 3｜基线（Miniflare 实测 `meta.rows_read`）

| 查询 / 路径 | rows_read | 返回行 | 判定 |
|---|---:|---:|---|
| `fetchSectionsByParents`（素问条文） | 6,010 | 2,883 | 索引 seek + **TEMP B-TREE**（可降到 3,127） |
| `getAliaZhongYao` 臂2（bieMing 派生） | 931 | 930 | 索引 seek |
| `getTcmBookFang`（金匮要略宋版） | 203 | 202 | 索引 seek |
| `getAppAllYao` / `getAppAllTerms` | 172 / 18 | 172 / 17 | 索引 seek |
| `getTcmBookChapters`（素问 81 篇章） | 163 | 81 | 索引 seek + 排序 |
| `listCategoryNav`（每公开页） | 46 | 3 | 小表 join |
| `getAppNav` | 29 | 8 | 小表 join |
| `channels` + `ext_category` + `ext_book_stats`（首页） | 25+4+**13** | — | **物化生效** |
| `getAppChapterContent` / `tcmProbe` / `getBookById` | 2 / 1 / 1 | 1 | 点查 |
| 首页合计（含 feed 窗口 20） | **≈115** | — | — |

**额度换算（5M/日）**：素问书页 ≈6,300（修后 ≈3,400）→ 约 **793（修后 1,470）次**就耗尽；首页 ≈115 → 约 **43,000 次**。书页/首页都有 24h 边缘缓存（ADR-0016），稳态 ≈ 每 URL 每天 1 次，当前流量不构成风险。

### 4｜纠正一条过时基线

`.scratch/d1-read-cost-report.md` 与 `microfeed-d1-cost-verify` 技能里记的「`/`（`listPublishedBookSamples`）≈ **9,547** 行读」是 **0103 物化之前**的数字。现 `ext_book_stats` 13 行**全部 `computed_at_ms != 0`（stale=0）**，`bookWordCounts` 稳态只读 13 行 ⇒ 首页已降到 **≈115 行**。技能与报告里的该数字应作废。

## 决策

- **D1｜不为「消除全表扫描」做任何改动**——已无扫描，为扫描新增索引无收益。适用范围限于本 ADR 审计过的公开读路径与当时列入的后台路径；2026-10-21 对后台与维护路径扩大范围后发现的扫描与新增索引，见 ADR-0043。
- **D2｜接受「整本读取」**：书页/阅读页读整本书，上界由书大小决定，靠 24h 边缘缓存兜底；目录分页不在本轮（见备选）。
- **D3｜Admin 侧不纳入**：`readAdminMenu`(62)、webhook explorer(41)、`readRbacUsers`(4) 等量小且低频，不占公开额度。本条限于该次审计的取舍；webhook explorer 的 LIKE 扫描、后台列表、登录日志与主题维护路径已由 ADR-0043 修复。
- **D4｜先只出结论与基线**（本轮前半），已证明的修复记录在备选 1。
- **D5｜实施备选 1（方案 A）**：新增迁移 `0108_index_section_order_coalesce.sql` 建索引 `items_section_order_kind2 (tcm_kind, tcm_parent_id, COALESCE(receiptNo,no), id)`，消掉书页条文查询的 TEMP B-TREE。**已应用到本地 D1**（记入 `d1_migrations` id=104）并复测 **6,010 → 3,127**、计划不再出现 TEMP B-TREE。远端 D1 待用户自行应用。
- **D6｜复核无回归**：用 app **真实** SQL（字面分片 `IN (…)` 列表）复测，书页条文 **3,045**（比子查询探针的 3,127 更低）；同一 SQL 的卷看板调用方（无 `tcm_kind`）仍走 `items_section_order`、无排序；App 单 parent 查询（`items_section_order_kind`）仍为 2；`getTcmBookChapters` 163 未变。`items` 索引 21 → 22，无新增全表扫描。

## 备选（按性价比）

1. **【已实施（方案 A），见 D5】加一条与 `ORDER BY` 同形的 section 排序索引**：使 `fetchSectionsByParents`（`tcmKindSection: true`）的 `ORDER BY tcm_parent_id, COALESCE(receiptNo,no), id` 被索引满足。**已落成迁移 `0108`**、本地复测 **6,010 → 3,127（−48%）**，素问书页 ≈6,300 → ≈3,400。曾考虑但未采用：把既有 `items_section_order_kind` 的第三列直接由裸 `receiptNo` 改为 `COALESCE(receiptNo,no)`（会动到 App 单 parent 查询的索引序，且需同步改 `reads.ts:407`）。
2. **【收益已复核为小，暂缓】物化派生的中药别名**：`getAliaZhongYao` 的派生（`getDerivedYaoAliases`：172 yao + 930 section = **1,275 行**）**已由 `cachedAppResponse` 24h 缓存兜住**——派生只在缓存未命中时跑（≈1/天/POP），并非每请求；`ext_tcm_aliases` 也**已在用**（手工覆盖 / 隐藏指令表，`getAppYaoAliases` 会合并它）。故在其上再物化，边际收益 ≈1,275 行/天/POP，可忽略；唯一未被缓存的是 Admin 别名板（`listAliases`）。**原「推荐优先」的评估高估，暂缓。**
3. **目录分页**（只渲首屏 + 懒加载）：直接压低「整本读取」，但要改主题渲染 + 分页接口，属独立立项。
4. **跑 `ANALYZE`**：ADR-0011 D4 已实测为负收益，否决。

## 局限

1. 数值取自 **2026-10-12 本地快照**（9,506 items / 13 channels），逐查询累加 `meta.rows_read`，未对整页函数做端到端计量。
2. 本机 vitest 全部套件在 suite 级失败（根因未定位，见 ADR-0016 局限 3），故本审计用 `.scratch/d1-probe/` 下的 `node:sqlite` + Miniflare 探针，而非 vitest。
3. 备选 1 先在沙箱副本验证，随后**落成迁移 `0108` 并应用到本地 D1**（`integrity_check` ok、复测 3,127）；远端 D1 于 2026-10-22 的部署中随 `manage deploy` 应用（远程 `d1_migrations` 137 行、137 个在盘迁移文件逐条命中，见 `.scratch/d1-sync-20261022/probe-ledger-and-indexes.stdout.txt`）。
4. **D1 结论一律以本地快照为准，不连远程**（用户 2026-10-12 定）。

## 验证

- 探针：`.scratch/d1-probe/schema.mjs`（schema / 索引 / 行数）、`eqp.mjs` / `eqp2.mjs` / `eqp3.mjs`（`EXPLAIN QUERY PLAN`）、`quant.mjs`（小表与每本书体量）、`rows-read.mjs`（逐查询 `meta.rows_read`）、`why-6300.mjs`（A/B/C/D 四组对照 + 计划）、`prove-fix.mjs`（沙箱加索引证明修复）、`apply-0108.mjs`（应用迁移并复测）。
- 结论「无全表扫描」由两条证据交叉确认：EQP 无裸 `SCAN items`（除 Admin 选择器）+ 实测 `rows_read` 与返回行数同阶。
- 结论「2× = TEMP B-TREE」由四组对照确认：D（含回表、无排序）= 3,127 = A（覆盖、无排序）⇒ 回表不加倍；B（有排序）= 6,010 ⇒ 排序才是 2× 来源；加同形索引后 B 原样降到 3,127、计划不再出现 TEMP B-TREE。
- 迁移门禁：`scripts/check-migrations.ts` 通过（104 个文件、0108 连续）；应用后 `PRAGMA integrity_check` = ok；`git diff --check` 干净。
