# ADR-0016: 公开读路径的服务端缓存——TTL 而非缓存本身，以及为 24h 补上的清理

- 状态：Accepted（已实施）
- 日期：2026-10-12
- 决策人：用户 + 设计评审
- 关联设计：ADR-0011（rows_read 为代价单位、keyset 取代 OFFSET）、ADR-0012（物化与触发器失效）、`CONTEXT.md` 的「数据层（D1）」
- 实测报告：`.scratch/d1-read-cost-report.md`、`.scratch/d1-full-scan-re-audit-2026-10-11.md`
- 本次探针：`.scratch/d1-scan/verify-public-cache.mts`、`.scratch/d1-scan/verify-reader-nav.mts`

## 背景

远程 D1 免费额度 5,000,000 `rows_read`/日，实测日消耗已在 **1M 以上**（用户从用量面板确认）。内容是一个已出版典籍的文字展示站，人工编辑频率远低于读频率。

错误的问题问法是「Workers 有没有缓存」。仓里**已经有两层**，问题不在缺失而在配置：

| 机制 | 位置 | 覆盖 | TTL |
|---|---|---|---|
| CDN 边缘缓存 | `src/server/cache/public-cache.ts` → `src/middleware.ts` 的 `applyWorkerCachePolicy` | 全部公开 HTML（`/`、`/book/{id}/`、`/i/{slug}/`、单段独立页、`/json/`、`/rss/`、`/sitemap.xml`…） | **300s** |
| Worker Cache API | `src/server/tcm/app-cache.ts` 的 `cachedAppResponse` | 3 个 App 端点（GetAllZhongYao / GetAliaZhongYao / GetNav） | **300s** |

300s 在这个流量量级下**等价于没开缓存**。单 URL 每日回源上限 = `min(当日请求数 R, 86400/TTL × POP 数 P)`：

| TTL | P=3 时的上限 | 要开始受益所需 R |
|---|---:|---:|
| 300s | 864 | >864 次/日/URL |
| 1h | 72 | >72 次/日/URL |
| 6h | 12 | >12 次/日/URL |
| 24h | 3 | >3 次/日/URL |

一本书一个 `/book/{id}/`，访问量远够不着 864。于是每个书页请求都回源，和不开缓存一样。而一次书页回源的代价（2026-10-11 快照实测）是：

| 组成 | rows_read |
|---|---:|
| `getTcmBookChapters`（TCM 书页的章节目录） | 6,091 |
| `listCategoryNav` + `listPublishedBookSamples` + `FeedDb.getContent` + 探测 | ≈100 |
| **TCM 书页合计** | **≈6,192** |
| 非 TCM 书页（`getBookChapters` 2,965 + 同上） | **≈3,066** |

模型按 6,300 计入（略向上取整）。5,000,000 ÷ 6,300 ≈ **794 次书页请求就耗尽当日额度**——按访客每次读 1.6 个书页折算，约 **500 名读者/日**。TTL 拉到 24h 后，13 本书各回源一次 = 13 × 6,300 ≈ **81,900 行/日，与流量无关**。

App 侧同病：两个共享缓存端点 `getAppAllYao` 1,385 + `getDerivedYaoAliases` 1,275 = **2,660 行/次未命中**，300s 下按日 400 次调用估算 ≈ **1.06M 行/日**——量级与面板上的 1M+ 吻合，是本次最可能的单一来源。

Cloudflare 文档核实过三条语义（不是推测）：

- Cache API「contents of the cache do not replicate outside of the originating data center」——`caches.default` 是**每数据中心各一份**，上面的算术里 `P` 就是它的乘数；
- 「The two mechanisms are independent」——Cache API 与 CDN 缓存是两套，不能互相借力；
- `cache.put`/`cache.match` **不支持 `stale-while-revalidate` 与 `stale-if-error`**，`cache.put` 也**不兼容 tiered caching**。

## 决策

### D1｜CDN 边缘 TTL 300s → 24h，并加 `stale-while-revalidate=600`

```ts
// src/server/cache/public-cache.ts
export const PUBLIC_CACHE_EDGE_CONTROL =
  "public, max-age=86400, stale-while-revalidate=600, stale-if-error=86400";
```

`stale-while-revalidate` 让过期后第一击先拿旧内容应答、后台刷新，读者不阻塞。`stale-if-error` 维持 24h 不变：回源失败（D1 / Worker 抖动）不该变成读者的错误页。浏览器仍 `no-cache`，即 CDN 是唯一缓存层，行为可控。

### D2｜把 24h 变安全：补上卷板写入的缓存清理

能拉到 24h 的**前提**是写时清理完整。盘点结论：

| 写入 | 是否清理 |
|---|---|
| 书 / 分类 / 设置 / 主题 CRUD | ✅ `Cache-Tag` + `purgePublicCache` |
| 内容写入（`FeedDb.putContent`） | ✅ `_purgePublicCacheTags` |
| **卷板四个写入处理器** | ❌ **零清理**，全走裸 `FEED_DB.batch()`，绕开 `FeedDb.putContent` |
| 别名板写入 | ❌ 只影响 App，本轮不动 |

卷名 / 卷序 / 归档改写 `_microfeed.volume`、`title`、`tcm_parent_id`，**会改变 `/book/{id}/` 的 HTML**。300s TTL 下这个缺口最多陈旧 5 分钟，无所谓；24h 下最多陈旧 24 小时，不可接受。故这是 D1 的正确性前置，不是可选优化。

新增 `purgeVolumeBoardCache(database, changedItemIds)`（`src/server/admin/volume-handlers.ts`），四个处理器（assign / rename / reorder / order）全部补调用，标签为 `mf:items` + `mf:pages` + 每条被改条目的 `mf:item:{id}`。

**刻意不 purge `mf:public`**：首页 / 分类页 / feed 只呈现书名、封面与 ADR-0012 物化后的章节数，这三项都不随卷名卷序变化。走 `database.purgePublicCacheTags()` 而非直接调 `purgePublicCache()`，为复用 `FeedDb` 实例上那三个开关（非 preview / 有 ACCOUNT_ID / 传了 purger，见 `FeedDb.ts:156-159`）。

### D3｜App 共享缓存 TTL 300s → 24h，并纳入 `GetBookChapter`

`APP_CACHE_TTL = 86400`，理由同 D1：P 个 POP 上 864 的未命中上限让 300s 形同虚设。

`GetBookChapter` 是三个「已缓存」端点里唯一漏掉的那个——`GetBookChapter.ts` 手写的 `cache-control: public, max-age=300` 从未生效过（`applyWorkerCachePolicy` 把所有 `/api/*` 强制成 `private, no-store`）。改为 `cachedAppResponse("book-chapters", …, bookId)`：键按 `bookId` 分份。可共享的前提已核对：`getAppBookChapters`（`reads.ts:364-387`）只返回 `bookId / chapterSection / chapterHeader / signatureId` 四个字段，不含正文、不含调用者身份，SQL 只取 `status = 1`。

`cachedAppResponse` 增第三个可选参数 `keySuffix`，未传时行为与之前逐字一致，三个既有调用点不动。

`GetAllMingCi` **继续排除**：其返回随调用者 `app:mingci:view` 权限变化（有码全量、无码空数组），共享键会把有码用户的数据吐给无码用户。

### D4｜`/category/{slug}/` 纳入公开缓存白名单

`isStandalonePagePath` 的正则只认**单段**路径，`/category/` 这段自己匹配但加上 slug 变成两段就落空，整页因此走 `private, no-store`。新增 `isCategoryPath` 并纳入 `isPublicPagePath`，标签按书页同款补 CHANNEL_PRIMARY + ITEMS + PAGES + THEME_CURRENT。

顺带记录一个此前没被注意到的事实：**`/category/` 单段本来就是可缓存的**，漏网的只有带 slug 的两段路径。

### D5｜章页删掉整本书的章节取数，导航收成一个「返回」

`src/pages/i/[slug]/index.astro` 为了算「上一章 / 下一章 / 目录」三段导航，把**整本书**的章节列表拉出来（非 TCM 2,965 行、TCM 6,091 行）只为确定当前章的位置——在 5M 额度下这是单页最贵的一笔。

**备选方案实测全部堵死**：便宜地只取两个邻居，需要按阅读序键做有界 seek，而那个键是 `COALESCE(json_extract(data,'$._microfeed.no'), CAST(json_extract(data,'$._microfeed.section') AS TEXT))`，没有任何索引能覆盖它（调书页排序索引时实测：每种候选形状都留下 TEMP B-TREE，该轮工作因此中止）。退回到 `pub_date` / rowid 排序能便宜地回答，但答错——「篇章 → 条文」会跳序。

因此删除而非廉价化。`index.astro` 移除 `bookChapters` 取数、`chapters` map、`currentChapterIndex`、`previousChapter`、`nextChapter`；`toc_url` 只依赖 `item._microfeed.bookId`（本就在手，零额外读取）。

导航本身做成**一个「返回」**：既不付整书扫描，也仍然是「回到我刚点开的那一章」而不只是回页首。做法是把当前章 id 编进 hash——阅读页的 `toc_url` 是 `/book/<bookId>#mf-toc-<itemId>`，书页按同一约定给每个目录行设 `id="mf-toc-<item id>"`（`themes/feed-zh/web-feed.mustache`）。于是「返回」落在读者刚才点开的那一行上；对一份八千条的中医典籍目录来说，这是「一次点击」和「一段很长的滚动」的差别。

两个配套细节：

- 书页的目录是客户端重建的（分组 + 排序，`themes/feed-zh/web-body-end.mustache`），行会被重新挂载，浏览器自带的 hash 滚动因此不可靠（可能在重建完成前就发生）。所以在重建收尾处按 `location.hash` 再 `scrollIntoView({block: "center"})` 一次，并给该行加一个淡出的高亮类——光滚动在一份长目录上不足以回答「我是从哪一行来的」。
- 页头原有的返回按钮与底部这个新按钮共用同一个 `toc_url`，两处指向一致。

模板侧改动集中在 `themes/feed-zh/web-item.mustache`（三段导航改为单个返回）与 `web-header.mustache`（`.mf-reader-nav` 只剩一项后改居中，新增 `.mf-reader-return` 与 `.mf-toc-came-from`）。

**这是用户确认过的产品取舍**：书页本身已列全部章节，且 D1 之后书页被 24h 边缘缓存挡着，返回过去不再花钱。

## 依据

实测取自 2026-10-11 固定快照（9,506 个 items / 13 个 channel），非本次改动的产物；行读是 `meta.rows_read`。

**改前 / 改后（日行读，模型值）**：

| 路径 | 300s TTL 现状 | 24h TTL 后 |
|---|---|---|
| 13 个书页 | 随流量线性，500 读者即超额 | **≈81,900（恒定）** |
| App 两个共享端点 | ≈1.06M | **≈5,320** |
| App 篇章目录 `GetBookChapter` | 随调用线性（≈163 行/次） | **≈2,119（13 本 × 163）** |
| 章页 `/i/{slug}/` | 3,066 / 6,192 行/次 | `markerLayer` 取数 + `getBookById`，估算 200–600 行/次 |
| 首页 / 分类 / 导航 | 随流量 | ≈5,000 |

**总额度含义（5M 行/日）**：典型 ≈200K 行/日（**4%**）；极端情况——全部 9,506 个章 URL 一天内被抓完——≈4.8M，压线但不超。对比现状约 1M+ 且随流量线性增长。

**章页地板**：额度允许约 **10,000 个独立章 URL/日**（500 行/次）；现状 3,066 行/次只允许 **1,633 个 = 语料的 17%**。这是本次唯一没有完全消除的风险，因为爬虫每章只抓一次，TTL 对它无效；彻底解法是物化整书章节目录表（见 D5 备选），属独立立项。

## 后果

- D1 用量从「正比于流量」变成「正比于独立 URL 数」+「App 的两个全库端点」。书页这一项变成与访客数无关的常数。
- 代价是**旧数据可见窗口从 5 分钟变成最长 24 小时**。已由用户确认接受（站点内容为已出版典籍，人工编辑低频）。
- 每本被编辑的书/章最长 24 小时不反映变更，除卷板外其余写入都会立即 purge。
- **主题模板必须重新安装才生效**：`themes/feed-zh` 是随仓发布的内置主题，而页面渲染读的是 D1 `themes` 表里安装时冻结的 `bundle_json` 快照，不是磁盘源文件。改模板后不重装，dev 与生产都看不到——表现就是「源码改了、界面照旧」。**本 ADR 的模板改动已装进本地实例**：`microfeed-theme.json` 升到 `0.1.39`，`validate` / `test`（11 个 fixture）通过后 `theme install --local` 落地，theme id `03537909-81c8-45df-92ea-187fab565b2d`，状态未激活。按 AGENTS.md 的两步设计，激活需在后台 Settings → Themes 预览确认后单独执行；激活后只保留 0.1.39 与 0.1.38，删除 0.1.36 / 0.1.37。生产站同样需要走一遍 install + activate。
- Cache API 每条目 24h TTL 与 13 个 bookId 键，存储增长可忽略。

## 备选（否决）

- **TTL = 1h**：平台期 4.68M 行/日，仍然超额。6h（780K）可行但不是稳态最优；24h 的边际收益高、边际陈旧代价为零（写时已清理），故取 24h。
- **改用 KV 做全局缓存**：ADR-0011 与 ADR-0012（`.scratch`）已否决过 KV。KV 的读另计 1M 次/日额度，且多引入一套一致性问题，而 `caches.default` 已覆盖同类需求。
- **Durable Object 做全局写穿透缓存**：每请求 DO 调用成本远高于 D1 读取本身的开销，否决。
- **物化每章的 prev/next**：读取侧收益与直接删除**完全相同**（`toc_url` 只需 `item._microfeed.bookId`，本就在手）。物化买不到额外的行读节省，代价却是 O(条目数) 的漂移面 + 无法索引化的排序键 + `items` 写入点分散在 6 个文件（ADR-0012 D2 记录的坑）。否决。
- **物化整书章节目录表**（一趟扫描换一个 O(书) 的行）：比物化 prev/next 大一整级收益（顺带把书页 TOC 从 6,091 压到 ~13），但要新表 + `items` 触发器 + 触发失效，且 ADR-0012 的 `ext_book_stats` 已经堵住了「只涨不跌」的那条路。本轮不做，额度真正逼近瓶颈时单独立项。
- **给 `/api/v1/content/*` 加缓存**：已核实**无任何消费方**——`src/client/`、`src/components/`、`src/pages/[adminPath]/` 三处 grep 全空，移动端不用，只被服务端自身与 OpenAPI 文档引用。D1 开销 ≈ 0，无需处理，保持 `no-store`。
- **跑 `ANALYZE`**：ADR-0011 D4 已实测为负收益，否决。

## 局限

1. **章页残留成本未实测**。`buildTcmMarkerLayer` 的两个取数（`loadFangBySourceBook` / `queryYaoByPureName`，`markerPopover.ts:121` / `:150`）在本 ADR 里只给了 200–600 行/次的估算，没有本地实测值。缺的是「以哪个 bookId 的各条文正文字数 / 引用密度为样本」——需在本机 dev server 上对一本真实典籍跑 `explain` + 代理取 `meta.rows_read`，`.scratch/d1-scan/` 下的探针目录即为此准备。
2. 所有 `rows_read` 数值取自 2026-10-11 固定快照，非本次改动的实测产物；本次改动只调整 TTL、白名单与「是否取数」，不改变任何 SQL，故沿用该快照是合理的。
3. 新行为由两个 tsx 探针断言（各 10 项 / 28 项，见 `验证`）。`publicCacheTagsForPath` 的分类页标签与 `applyWorkerCachePolicy` 的白名单判定仍**没有**进 vitest。`tests/worker/app-public-cache.test.ts` 已加 `GetBookChapter` 分键用例，但只过了 `tsc`，未实际执行——本机 vitest 全部套件在 suite 级失败（`TypeError: Cannot read properties of undefined (reading 'config')`，含从未改动的文件作对照），根因尚未定位；本地 D1 本身完好（89,976,832 字节、9,506 items / 13 channels）。
4. 流量量级（日 PV、App 调用数、POP 数）无仪器化数据（`observability.enabled = false`），额度模型按参数化推演。`P=3` 是假设值；`P` 越大，TTL 收益越显著（未命中上限 = `86400/TTL × P`），故本 ADR 的方向性结论对 `P` 不敏感。
5. **D1 结论一律以本地快照为准，不连远程**（用户 2026-10-12 定）。本 ADR 的数字全部来自本地快照。

## 验证

- `git diff --check` 干净；`yarn typecheck` 0 errors / 0 warnings / 5 hints（805 文件，hints 全在既有测试文件）；`yarn i18n:check` 通过；`tsx scripts/check-bundled-themes.ts --test` 9 个 fixture × 7 个主题全 ok。
- `.scratch/d1-scan/verify-public-cache.mts`（10 项）：TTL 常量、`/category/{slug}/` 拿到五个标签、`/category/` 单段本来就可缓存、分类页经 `applyWorkerCachePolicy` 出正确的 CDN 头与 `Cache-Tag`、书页不受影响、后台路径与带 `Authorization` 的 `/api/*` 仍 `no-store`、404 不缓存。
- `.scratch/d1-scan/verify-reader-nav.mts`（28 项）：渲染 `web-item.mustache` 后底部导航只剩一个「返回」链接（有箭头图标、`aria-label="阅读导航"`）、不再出现「已是第一章 / 已是最后一章 / 目录」、返回指向带 `#mf-toc-<id>` 锚点的书页、页头返回按钮与底部指向同一 URL、正文未被破坏；`web-feed.mustache` 的章节目录行与方剂目录行都带 `id="mf-toc-<item id>"` 且链接仍指向章页；`web-body-end.mustache` 的重建收尾在 `list.appendChild(fragment)` 之后读 `location.hash`、`getElementById` 取行、`scrollIntoView({block: "center"})` 并加高亮类；阅读页的 `toc_url` 按 `currentBookId != null && itemId` 构造、缺 id 时不产生坏锚点；`.mf-reader-return` / `.mf-toc-came-from` 已定义且只引用真实存在的 CSS 变量。
- `tests/worker/app-public-cache.test.ts`（4 个用例）：三个既有端点各一例，新增 `GetBookChapter` 一例——按 bookId 分键、首请求写缓存后断开 D1 仍返回同一响应体。辅助函数的键参数改成 `CACHE_ORIGIN` 之下的完整路径，以覆盖带分键的 URL。
