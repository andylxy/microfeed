# ADR-0012: 物化每本书的章节数与字数（推翻「不引入派生列」）

- 状态：Accepted（已实施）
- 日期：2026-10-11
- 决策人：用户 + 设计评审
- 关联：ADR-0011（keyset 取代 OFFSET）、迁移 `0103_ext_book_stats.sql`、`src/server/feed/bookWordCount.ts`、`src/server/feed/extBook.ts`、`CONTEXT.md` 的「数据层（D1）」
- 实测报告：`.scratch/d1-read-cost-report.md` §9

## 背景

ADR-0011 用 keyset 取代 OFFSET，把首页从 **104,793** 行读降到 **9,547**（11.0×）。但 9,547 行仍然只产出 **13 个数字**（每本书一个字数）——放大 **734×**。

逐语句归因（实测）：

| 语句 | rows_read | 返回 |
|---|---:|---:|
| `channels`（列书） | 26 | 13 |
| `ext_category`（分类名） | 4 | 3 |
| **`bookWordCounts` × 13 次（逐本一次）** | **9,517** | 9,506 |
| **合计** | **9,547** | |

原因是语义的，不是实现的：**「每本书多少字」是跨行聚合**——该书所有条目正文字数之和，不是任何一行的字段。`channels` 那 13 行上根本没有这个数（实测 `_microfeed.wordCount` 13 行**全部为空**），`items` 里也没有一行是「书」（`items.id = channel.id` 的行数 = **0**）。

三条省钱思路实测全堵死：

| 想省的办法 | 实测 |
|---|---|
| 加索引 | 不变 —— 9,506 是「**必须**读的行」，不是「找不到的行」 |
| 一条 SQL `GROUP BY` | **19,012** 行，比 9,506 **贵一倍** |
| 跑 `ANALYZE` | **负收益** —— 会把查询从走索引翻成裸 `SCAN items` |

⇒ 唯一出路是**不再每次重算**。

## 决定

### D1｜物化到 `ext_book_stats`，两种口径并存

```sql
CREATE TABLE IF NOT EXISTS ext_book_stats (
  book_id            VARCHAR(11) PRIMARY KEY,
  chapters_published INTEGER NOT NULL DEFAULT 0,  -- 公开口径：status = 1
  words_published    INTEGER NOT NULL DEFAULT 0,
  chapters_all       INTEGER NOT NULL DEFAULT 0,  -- 后台口径：status != 3
  words_all          INTEGER NOT NULL DEFAULT 0,
  computed_at_ms     INTEGER NOT NULL DEFAULT 0   -- 0 = 过期，需重算
);
```

两种口径必须并存：公开站只算已发布，后台书库看板要连草稿一起算。一次扫描（`status != 3`）同时产出两组数，不分两遍。

用 `ext_*` 新表而不是给 `channels` 加列：符合「新逻辑放 `ext_*` 表 / 新文件」的分叉约束。

### D2｜**用数据库触发器做失效**，不用应用层写入钩子

```sql
CREATE TRIGGER ext_book_stats_dirty_on_insert AFTER INSERT ON items BEGIN
  UPDATE ext_book_stats SET computed_at_ms = 0 WHERE book_id = NEW.book_id; END;
CREATE TRIGGER ext_book_stats_dirty_on_update AFTER UPDATE ON items BEGIN
  UPDATE ext_book_stats SET computed_at_ms = 0 WHERE book_id IN (OLD.book_id, NEW.book_id); END;
CREATE TRIGGER ext_book_stats_dirty_on_delete AFTER DELETE ON items BEGIN
  UPDATE ext_book_stats SET computed_at_ms = 0 WHERE book_id = OLD.book_id; END;
```

`items` 的写入点分散在 **6 个文件**（`FeedDb` / `items/service` / `ajax/feed` / `extContentReview` / `tcm-entry-handlers` / `volume-handlers`）。逐处挂钩子**漏一个就静默漂移**——正是 `bookWordCount.ts` 顶部注释警惕的那类问题（「声明值从不重算，任何编辑都会让它说谎」）。

触发器把失效钉在数据层：任何一条 `items` 写入都会把对应那本书标成过期，**绕不过去**。这也让「推翻不引入派生列」这个决定有了安全网——漂移不再依赖人记得挂钩子。

过期标记用 `computed_at_ms = 0` 而不是比时间戳：读路径只判「是否 > 0」，不需要时钟参与，也不会因时钟回拨误判。

### D3｜懒自举，不做回填

`readBookStats` 读表 → 缺失或过期的书当场重算一次并写回。新部署**不需要回填步骤**，任何绕过写入路径造出来的书在第一次被读到时自愈。

## 后果（本地 D1 真机实测）

| 路径 | 修 OFFSET 前 | 修 OFFSET 后 | **物化后（稳态）** | 冷启动一次 |
|---|---:|---:|---:|---:|
| 首页 `listPublishedBookSamples` | 104,793 | 9,547 | **43** | 9,548 |
| Admin `listAdminBooks` | 104,523 | 9,523 | **30** | — |
| `getAdminBook`（单本） | 178 | 178 | **17** | — |
| 公开 Feed（20 条） | 27 | 27 | 27 | — |

**相对最初状态：首页 104,793 → 43 = 2,437×；Admin 104,523 → 30 = 3,484×。**

**额度含义（5M 行/日，按首页计）**：48 次/日 → 524 次/日 → **116,279 次/日**。

**触发器失效路径**：改 1 条 `items` → 只有那 1 本书被标记过期 → 下一次读 **218 行**（只重算那一本）→ 再下一次回到 **43 行**。

**正确性**：13 本书的物化值与独立计算（不同查询形状）**逐字一致**；`PRAGMA integrity_check` = ok；触发器 16 个（原 13 + 3）；静态审计无新增裸 SCAN。

**已知代价**：
- 每条 `items` 写入多一次 `UPDATE ext_book_stats`（写额度 100K/日，可忽略）。
- 被编辑的那本书，下一次读要重算（成本 = 该书的条目数，本地最大 2,964）。编辑频率远低于读频率，这笔账划算。

## 备选（否决）

- **6 处应用层写入钩子**：见 D2，漏一个就静默漂移。否决。
- **TTL 过期**（不接触发器，按时间判过期）：TTL=1h 时每天最多 24 次全量重算 ≈ 228K 行/日，比触发器的「只重算被改的那一本」差一个量级；TTL 拉长则数据陈旧。否决。
- **只物化章节数，字数不显示**：那是产品决策，且丢掉首页卡片的字数标签。若真要省，正确的做法是单独评审「首页要不要显示字数」，而不是把它混进本 ADR。否决。
- **`items.word_count` 派生列**：字数只能在 JS 层算（`countBodyText` 要剥 HTML/markdown 再去空白，SQLite 的 `replace` 复现不了 U+3000 全角空格），给每一行存自己的字数不能直接回答「整本书多少字」，仍需跨行求和。否决。
- **KV / 边缘缓存聚合结果**：ADR-0011 与 ADR-0012（`.scratch`）已否决 KV；边缘缓存只能挡首页，挡不住 `no-store` 的 Admin 书库页。否决。

## 附：本次**推翻**的既有决定

`bookWordCount.ts` 顶部原写「不引入会漂移的派生列」。本次显式推翻，理由：

1. 那条决定是在「读代价不是瓶颈」的前提下做的。实测要产出 13 个数字必须读 9,506 行，且 **Admin 书库页是 `no-store`，没有任何缓存遮挡**。
2. 推翻的同时引入了**数据层失效**（D2），把「漂移」这个当初的主要顾虑钉死在数据库里，而不是靠人工纪律。
3. 物化的是**聚合结果**（整本书一个数），不是「每行的派生副本」——后者的漂移面是 O(行数)，前者是 O(书数)。
