# ADR-0011: 读代价以 rows_read 为准——keyset 取代 OFFSET，单本读取不分页

- 状态：Accepted（已实施）
- 日期：2026-10-11
- 决策人：用户 + 设计评审
- 关联设计：ADR-0002（D1 读路径优化）、`CONTEXT.md` 的「数据层（D1）」词条、迁移 `0097_ext_scan_index_tuning.sql` / `0102_ext_ordering_index_widening.sql`
- 实测报告：`.scratch/d1-full-scan-audit-2026-10-10.md`（探针在 `.scratch/d1-scan/`）

## 背景

`bookWordCounts`（每本书字数）与 `bookStats`（后台书库看板的章节数 / 字数）是同一形状的两次遍历：扫 `items`、按 `_microfeed.bookId` 分组、累加 `countBodyText`。两者原先都用 `LIMIT ? OFFSET ?` 分页（`PAGE_SIZE = 500`）。

问题不在「有没有走索引」——两者都命中 `items_book_id`——而在**计费方式**。D1 的 `rows_read` 按**步进行数**计，OFFSET 取第 k 页要先把前 k×PAGE_SIZE 行走一遍：

| 调用链 | rows_read（改前） | 相对表（9,506 行） |
|---|---:|---:|
| 首页 / 书页 `listPublishedBookSamples` | **104,793** | 11.0× |
| Admin 书库页 `listAdminBooks` | **104,523** | 11.0× |

D1 免费额度是 **5M 行/日**，于是 OFFSET 版首页约 **48 次请求**就耗尽当日额度——不是性能问题，是可用性问题。

另有一个把「收敛参数」变成摆设的细节：`listPublishedBookSamples` 把**当页全部 13 本书**的 id 都传给 `bookWordCounts(db, bookIds)`，而首页本来就要列全部书，于是 `book_id IN (13 个)` 覆盖全库，收敛等于没收敛。

## 决策

### D1｜整库遍历用 rowid keyset，禁止 OFFSET

```sql
SELECT rowid AS rid, json_extract(data, '$._microfeed.bookId') AS bookId, content_text
FROM items WHERE <scope> AND rowid > ? ORDER BY rowid LIMIT ?
```

游标列选 `rowid` 而不是 `id`：`items.id` 是随机短 UUID，按它排序拿不到任何索引顺序；`rowid` 是表序，`status = ?` 命中 `items_status (status)`、`status != ?` 退化为 `INTEGER PRIMARY KEY` 扫描，两种情况下 `rowid > ?` 都是**索引范围条件**，因此不需要 TEMP B-TREE。

keyset 的总行读等于结果集大小，与页数无关（提高 `PAGE_SIZE` 只减少往返、不增加行读）。

### D2｜单本读取一次读完，不叠分页

`bookId !== null` 时改成一条不带 `LIMIT` / `ORDER BY` 的查询。

理由是实测出来的，不是推导的：**给单本查询加 `ORDER BY rowid` 会让 `rows_read` 翻倍**（174 → 347）。因为 `items_book_id (book_id, status)` 在 `status != ?`（后台口径）时只能用 `book_id` 当前缀，rowid 退化为过滤条件而非排序依据，`ORDER BY rowid` 于是引入一次 TEMP B-TREE 全量排序。换成 `LIMIT ? OFFSET ?` 又回到 D1 要禁止的二次方。

单本的条目数本身就是成本下界（`book_id` 索引 seek 已落在下界上），行的顺序与聚合无关，所以既不排序也不分页。本地最大一本（黄帝内经・素问）2,883 条，`content_text` 合计约 118 KB，单条响应远未触及上限。

### D3｜排序索引加宽为 `(列, id)`（迁移 0102）

后台条目列表与公开「最新」取数是**双键**排序 `ORDER BY <col> <dir>, id <dir>`，而前置谓词是**不等值** `status != ?`。0097 建的 `(status, col, id)` 帮不上忙——不等值列无法当作索引前缀用于排序。单列索引只能满足第一个排序键，`id` 落空，于是每个并列组都要临时排序。

原地重建为 `(col, id)`，**沿用同名**（与 0097 重建 `items_book_id` 一致）：索引个数不变，写入开销不变，只是每个条目多带一个 8 字节 rowid 后缀。

| 查询 | 改前 | 改后 |
|---|---:|---:|
| Admin 列表 `created_at ASC` / `pub_date ASC` | 147 | 36 |
| Admin 列表 `created_at DESC` / `updated_at DESC` / `pub_date DESC` | 51 | 36 |
| `latestItems` `updated_at DESC` | 21 | 10 |
| 公开 Feed（`status = ?`，走 0097 索引） | 21 | 21（不受影响） |

### D4｜不跑 `ANALYZE`

本库从未 `ANALYZE`（无 `sqlite_stat1` / `sqlite_stat4`），0097 的注释把「用结构而非统计解决」写成了设计前提。本次在沙箱副本上验证了这个前提是对的——跑完 `ANALYZE`（129 行 `sqlite_stat1`）后：

- `bookWordCounts` 全库从 `SEARCH … USING INDEX items_status_created_at` **翻成裸 `SCAN items`**（统计告诉规划器 `status = 1` 命中 100%，顺序扫表确实比 9,506 次索引查找便宜——**规划器是对的**）；
- Admin 列表 / `latestItems` / `bookStats` 的计划**一个都没变**。

即：`ANALYZE` 修不了任何一项，还会把原本走索引的查询翻成裸扫。**明确不做。**

## 依据（本地 D1 实测，`meta.rows_read`）

真实生产函数端到端（`.scratch/d1-scan/probe-final.mts`）：

| 调用链 | 改前 | 改后 | 改善 |
|---|---:|---:|---:|
| 首页 / 书页 `listPublishedBookSamples` | 104,793 | **9,547** | **11.0×** |
| Admin 书库页 `listAdminBooks` | 104,523 | **9,523** | **11.0×** |
| `getAdminBook`（单本） | 178 | 178 | 持平 |
| `bookWordCounts`（单本） | 174 | 174 | 持平 |
| 公开 Feed（20 条） | 27 | 27 | 持平 |
| `FeedDb.getContent`（channels + settings + theme） | 8 | 8 | 持平 |

语句数也一并下降（首页 22 → 15 条）。改后的数值就是**重算**的下界：要算全站字数必须触碰全部 9,506 行已发布条目。

**注意这只削掉了 11×，没削掉「放大」本身。** 修复前是 104,793 ÷ 13 个输出 = **8,061×**，修复后是 9,547 ÷ 13 = **734×**。剩下的是聚合语义决定的——精确字数必须读全部正文。要再降只能**停止重算**（物化，或产品上不展示），加索引与改 SQL 实测都更贵（`GROUP BY` 版 19,012 行读）。完整归因与两条出路见 `.scratch/d1-full-scan-audit-2026-10-10.md` 附二。

**额度含义（5M 行/日）**：首页 **48 次/日 → 524 次/日**；Admin 书库页 **48 次/日 → 525 次/日**。

## 后果

- 收益集中在两个最显眼的页面上，且是**结构性**的——表越大差距越大（OFFSET 是二次方，keyset 是线性）。
- 单本读取的响应不再有 `PAGE_SIZE` 上界。当前最大 2,883 条 / ~118 KB，可接受；若将来出现数万条的巨型书，需要重新评估（届时正确的解法是物化聚合，而不是把 OFFSET 加回来）。
- 迁移 0102 是原地重建索引，`CREATE INDEX IF NOT EXISTS` 幂等，回滚按文件尾部的说明改回单列即可。

## 备选（否决）

- **单条 SQL `GROUP BY book_id` + `SUM(length(content_text))`**：耗时快 15.6×（118 ms vs 1,838 ms），但 `countBodyText` 会先剥 HTML/markdown 再去空白，`LENGTH` 把标记字符全算进去——**字数系统性偏大**。而 `bookWordCount.ts` 文件头明写了「不引入会漂移的派生列」，这是它要解决的问题本身。
- **物化表（`ext_book_stats` + 写入钩子）**：能把首页降到约 13 行读，但需要新表、写入钩子与回填，且要推翻 `bookWordCount.ts` 的既有决定。收益（9,547 → 13）在**当前额度下不必要**——524 次/日已经够用。留作额度真正逼近瓶颈时的下一步。
- **跑 `ANALYZE`**：见 D4，负收益。
- **把 `status != ?` 改写成 `status = 1`**：`status = 1` 确实能用上索引前缀排序（消掉 TEMP B-TREE），但语义不等价——会排除 `status = 2`（未发布）与 `4`（不列出）的条目，而后台列表要连草稿一起列。**否决。**
- **只删 `/rss` `/json` 路由**：热路径在数据层（`FeedDb` / `FeedPublicJsonBuilder`），页面与 feed 共用同一数据层，删路由既不降成本又损失订阅 / SEO 自发现。**否决。**

## 验证

- `.scratch/d1-scan/probe-final.mts`：改前 / 改后同一脚本对照，上表数字由它产出。
- `tests/unit/server/bookWordCount.test.ts`（16 用例）：含「永不出现 OFFSET」「整库用 rowid 游标分页」「单本不用 rowid 游标」三条形状断言。
- `tests/unit/server/extBook.test.ts`、`tests/unit/server/extCategory.test.ts`：夹具补齐 `content_text` / `book_id`（生产写入路径本来就填这两列，夹具此前缺失，是本 ADR 顺手修掉的预存缺陷）。
- 迁移 0102：在副本上连跑两次验证幂等，`PRAGMA integrity_check` = ok，`items` 索引数不变（17）。
