# ADR-0025: 卷作为一级阅读单位——目录按需读取

- 状态：Accepted
- 日期：2026-10-13
- 决策人：用户 + 设计评审
- 关联设计：ADR-0011（`rows_read` 为代价单位）、ADR-0012（物化 + 触发器失效）、ADR-0016（公开读路径缓存 TTL）、**ADR-0024（本 ADR 落实其备选 3、并修正其 D2）**
- 本次探针：`.scratch/book-toc-plan/{probe-book-page-total,probe-volume-content,probe-marker-cost,probe-marker-per-volume,probe-index-clean,probe-marker-config-e2e}.mts`、`.scratch/book-toc-plan/proto/*`

## 背景

书详情页的目录把**整本书的条文全读一遍**才渲染（`getTcmBookChapters` → `fetchSectionsByParents`）。
`伤寒金匮・(宋版)`（27 篇章 / 812 条文）实测该查询 **921 `rows_read`**；`黄帝内经・素问`（81 篇章 / 2,883 条文）
按 ADR-0024 的基线是 **3,045**。它占书页整页读取代价的 **79%**（整页实测 ≈1,165：目录 921 + 附：方剂 114 +
相关推荐 42 + 分类导航 46 + 主题设置 26 + 点查 16）。

ADR-0024 当时的判断是「**接受整本读取**，靠 24h 边缘缓存兜底」（D2），并把「目录分页（只渲首屏 + 懒加载）」
列为**独立立项**（备选 3）。本 ADR 就是那个立项，并且实测推翻了当时两个未经验证的前提。

### 被推翻的前提

| ADR-0024 的假设 | 实测 |
|---|---|
| 「总章数 / 总字数 / 最近更新」必须扫全书才能算，所以目录分页要牺牲头部统计 | **不成立**：`ext_book_stats`（0103 物化）1 行给出字数与条目数；「最近一条」靠重建索引可降到 **1 行** |
| 页面头部统计的代价与目录同阶，取舍是「省 D1」vs「留信息」 | **不成立**：三个统计全部保住后，书页仍可从 ≈1,165 降到 **≈314** |

## 决策

### D1｜卷成为一级阅读单位，有自己的 URL

`/book/<bookId>/v/<篇章 id>/`（TCM 书；`tcm_kind='chapter'` 的那一行的 11 字符 id 就是卷键）。
**卷键用篇章 id 而不是卷名或序号**：篇章 id 是稳定主键（卷改名、卷序调整都不断链）、URL 短
（不剥 `$x{}` 标注时卷名会长达 41 字符且含标记）、卷页查询直接命中 `items_section_order` 索引。
序号做键会在中间插入新卷时让旧链接指错卷；卷名做键在改名时断链。

实测全站 12 本书里 10 本是 TCM 结构，只有「中药」「名词」是扁平条目、**没有卷** —— 那两本保持现有平铺，不引入卷。
（实现上那两本各有一个 root 篇章行，`tcm_parent_id = null`、title 就是书名，但**没有条文**；`getBookVolumes`
以「有没有条文」区分两类书，对它们返回空 ⇒ 目录保持平铺、它们的 root 篇章也不构成卷页（404）。）

### D2｜书页只列卷，正文按需读

书页目录从「27 个卷标题 + 812 条章标题」改为「27 个卷链接」。**目录查询从 921 降到 56 `rows_read`**
（1 行 `tcm_kind='section'` 点查 + 27 行篇章；55 而非 27 是 `ORDER BY` 的 2× 排序放大，
与 ADR-0024 记录的 `getTcmBookChapters` 篇章查询同源，量小不值得再为它加索引）。
那 1 行点查用来区分「结构化 TCM 书」与「扁平书」：中药 / 名词 也各挂一个 root 篇章
（title 就是书名、`tcm_parent_id = null`），但**没有条文**，所以 `getBookVolumes` 对它们返回空、
目录保持平铺（见 D1 末段）。
读者点开某一卷时才读那一卷（1 行篇章 + N 行条文；最大卷 97 条 → 实测 **99 `rows_read`**）。
这是「按需读取」的字面实现：不点不读。

### D3｜卷内不渲染条标题

卷页把该卷全部条文的正文连续铺开，每条一个 `<article id="mf-toc-<条 id>">`，**不输出条标题**。
依据实测：**803/812 条正文以标题开头**（标题是正文首句的截断），1 条正文含标题但不在开头，**0 条正文短于标题**；
剩下 8 条的标题是**裸序号**（`1`/`2`/`3`），而正文自带真实全局编号（`382、`/`383、`）——那 8 条的标题本来就是噪声。

### D4｜「最近更新」靠重建索引，不是放弃

`WHERE book_id = ? AND tcm_kind = 'section' AND status = 1 ORDER BY pub_date DESC LIMIT 1`
实测 **8,348 `rows_read`**（计划走 `items_status_pub_date(status=?)` + `USE TEMP B-TREE FOR ORDER BY`）——
比整页还贵 8 倍。把既有索引 `items_book_kind` **原地重建**为 `(book_id, tcm_kind, status, pub_date)`
（沿用同名，不新增索引个数，同 0097 做法）后降到 **1 行**，且 `COUNT`(813) 与篇章目录(28) 都不回归。

只加一条新索引 `(book_id, pub_date)` **无效**：带 `tcm_kind` 过滤时规划器仍选 `items_book_kind` + TEMP B-TREE（1,625）。

### D5｜头部统计走物化表，口径随之改为「全部已发布条目」

`ext_book_stats`（0103）已有 `chapters_published` / `words_published`。走 `readBookStats(db, [bookId])`
（现有共享读取器，带懒自举与过期判断）实测读全表 **13 `rows_read`** —— 不是 1 行：
`selectStoredStats` 是全表 `SELECT` 再在内存里按 bookId 取（本快照表内 13 行）。
要拿到 1 行就得自己写单行读并绕过懒自举，得不偿失，**接受 13**。
（数字随表内行数走：本 ADR 早期快照是 26。行被触发器标脏时会额外付一次该书全量重算
≈952 行 —— 那是懒自举的自愈代价，见 `refreshBookStats`。）
页面显示位置：卷目录副行「共 N 卷 · 952 条」。
但它数的是该书**全部已发布条目**（代码读 `chapters_published`，即 `status = PUBLISHED` 的计数；
「全部非删除」对应的是另一个字段 `chapters_all`）—— 本书 952 = 27 篇章 + 812 条文 + 113 方剂
（本快照里这三类都是 `status=1`，所以两个字段恰好相等），而页面原先显示的是**条文 812**。
本决策接受物化口径（「共 952 条」），**不接受为保住 812 而付 813 行的 `COUNT`**：按本快照的物化读
**13** 行算是 **62.5 倍**代价（813/13），换一个对读者无差别更优的数字。

### D6｜方剂引用关系物化

卷页正文里的 `$f{桂枝汤}` 必须渲染成可点实体，否则页面直接露出 `$f{...}` 原文。渲染前的
`buildTcmMarkerLayer` 一次调用 **981 `rows_read`**，其中 **847 行是「读整本书的条文」**，
只为让方剂浮层能列出「被哪些条文引用」。

改为物化：`ext_marker_citations(book_id, marker_code, marker_name, section_id, section_title, section_seq)`，
由 `items` 上的三个触发器打**脏标记**（`ext_marker_citation_state.computed_at_ms = 0`），
读路径**懒自举**全量重算（照抄 0103 的既有模式，而不是在触发器里跑重算）。
**前置不变量（这张表成立的前提，别搞反方向）**：正文在 `data.description` 里按**原形保存**，
`$f{桂枝汤}` 是原文的一部分；渲染成 `<span class="mf-mk">` 只发生在**显示时**（`renderTcmMarkers`
是纯函数，收字符串吐字符串、不碰 DB，结果只进响应、从不写回）。引用表只是从那份原文**提取**出来的
派生副本，本身不含任何 HTML。把标记在入库前剥掉、或让写路径改存渲染后的 HTML，都会让这张表**静默变空**。

覆盖 `$f{}` 与 `$u{}`，**两者都被读路径消费**：方剂浮层显示「引用此方剂的条文」，中药浮层显示
「引用此中药的条文」（标题在客户端按 `kind` 选）。`$a{}` 之类纯样式标记不进表（不需要反向索引）；
`$g{}`（名词）不动 —— 它的 `linkType=3` 本来就不生成链接。

中药的**名字口径**是这里最容易错的地方：重算时存进表的键是
`normalizeYaoName(stripYaoNo(标记里的名字))`（`$u{吴茱萸(炮)}` → `吴茱萸`），
而 `buildYaoEntry` 的 `entry.name` 只做过 `stripYaoNo` ⇒ 查询前必须补一次 `normalizeYaoName`，
否则中药永远查不到引用。重算的门控也从「本书有方剂」改成「本书不是容器频道 + 本页确有实体标记」，
这样没有方剂的典籍也能给中药挂引用。

**作用域边界（按 `book_id` 建键，不是全局索引）**：引用表以 `book_id` 为键，只收录该书内的
`section`/`chapter` 条文；读路径的 `currentBookId` 也必须是真实书频道。`buildTcmMarkerLayer` 在
`currentBookId` 命中 `CONTAINER_CHANNEL_IDS`（方剂/本草/名词的容器频道，如 `tcmyao00001`）时直接跳过
整张引用表 —— 因此中药条目的**自身详情页**（挂在 `tcmyao00001` 上）不会显示「引用此中药的条文」。
这**不是缺陷**：容器频道不属任何一本书，跨书引用本就不在本表的键空间里；若要支持「某味药被哪些书的
条文引用」，需要另立一张按 `(marker_code, marker_name)` 全局建键的表（独立立项，不在 D6 范围内）。

**实测收益与代价**（本书 812 条文 / 839 个候选行）：

| | 值 |
|---|---|
| 表行数（重算一次要写的行数） | **752**（`$f{}` 726 + `$u{}` 26；116 + 10 个不同名字） |
| 重算的读取 | **847 `rows_read`**（计划 `SEARCH items USING INDEX items_book_kind (book_id=? AND tcm_kind=? AND status=?)`） |
| 重算的**读取**（rows_read） | 首次渲染实测合计 **1,507**（整本 SELECT 847 + DELETE 步进 + 小表；分量是构成项、**相加不必等于实测值** —— DELETE 走索引、实际读的行数少于表里的 752 行） |
| 重算的**写入**（rows_written） | 删 752 + 插 752 = ≈**1,504 行/次重算** ⇒ D1 免费额度（10 万行写/日）约支撑 **66 次重算/日** |
| 单条条文标注层 | **979 → 127–212 `rows_read`** |

⚠️ **752 而非早前写的 478**：478 是**探针口径**（只 `tcm_kind='section'`、`status != 3`、名字不归一化），
而 `ensureMarkerCitations` 用 `tcm_kind IN ('section','chapter')` + `status IN (1,4)` +
`extractMarkerNames`（`$u{}` 会 `stripYaoNo` + `normalizeYaoName`）。差的 274 行主因是
**27 个篇章行也带大量 `$f{}`**。以 752 为准。

单条标注层 979 是实测样本（正文含 1 个 `$u{}`、药名查询 1 次）= 整本 847 + 方剂 114 + 标记表 13 + 药名 5。
**药名查询条数随该条正文出现的 `$u{}` 个数变** —— 含 7 个药名的那条实测总计 981。两个数都对，差别只在样本；
引用表把 847 换成 50–77 后，**药名查询成为最大项**。

**这一项的收益面比 D2 大得多**：标注层在**每条条文的阅读页**上都要跑（本书 812 个 URL），
而书页只有 1 个 URL。两个数都可以直接复算：

| 项 | 算式 | 结果 |
|---|---|---|
| D2 每天省 | 921（现状目录查询）− 56（卷列表） | **865 行/天** |
| D6 每天省 | 812 个条文 URL × (979 − 192) | ≈**639,044 行/天**（= 812 × 787；192 取三样本 183/212/127 的中位量级） |

倍率 ≈ 740× 的来源是 **URL 数**：书页只有 1 个 URL，而标注层在每个条文阅读页上都要跑。
（前提：24h 边缘缓存 ⇒ 每 URL 每天回源 1 次；979 取实测样本值，按 981 算是 640,668 ≈ 641k，量级不变。）

两者互补、不重叠：
D2 管书页目录，D6 管所有内容页的标注层。

### D7｜卷页必须注册进缓存白名单与标签

`isPublicPagePath`（`src/server/cache/public-cache.ts:125`）只认 `isBookPath` = `/^\/book\/[^/]+\/$/`（单段）。
新路由是四段，落不进白名单 ⇒ 中间件给 `no-store` ⇒ **每次访问都实付 ~1,080 行**，按需读取省下的全被吃掉。
`publicCacheTagsForPath` 同理漏掉，即使缓存了也不会被编辑失效（最长陈旧 24h）。
所以卷页必须同时进这两处，并挂书页同款四个标签（`mf:items` / `mf:pages` / `mf:theme:current` / `mf:public`）。

## 考虑过的备选

1. **同页 fetch 按需加载**（不跳转，点卷后拉该卷内容插入 DOM）：需要新 API 端点并登记 OpenAPI，还要处理加载态/失败态，
   且丢掉 SEO 与「无 JS 也能读」。否决。
2. **同页全部内联**（把整本正文塞进书页）：最坏一本 `神农本草经疏` 正文 541,904 字符 ≈1.55 MB，手机上不可接受。否决。
3. **给卷页新增主题模板类型 `webVolume`**：要动 `CODE_FILES` + 主题 manifest schema + theme-kit + 其余 7 个捆绑主题的校验，
   等于改主题格式约定。改为**复用 `getWebFeed()`**，让 `web-feed.mustache` 按上下文渲染「卷列表」或「卷正文」两形态。否决。
4. **只读卷列表、放弃头部三个统计**（本轮讨论的第一版方案）：实测证明不必牺牲（见 D4/D5），且砍到 28 行的收益
   会被「读者还是要看到统计」的需求抵消。否决。
5. **把渲染结果写回 D1**（`$f{}` 入库时就改写成 `<span class="mf-mk">`）：那样确实不用再提取引用，
   但会**反转**「原文入库、显示时渲染」的方向 —— 编辑器插的是 `$f{}`、App 端点显式返回原文、
   正文按原形保存（`data.description` + `content_format`）三条约定同时被打破，且渲染规则一变就要回填全库。否决。
6. **给卷页每卷一个独立 Cache-Tag**（精确失效）：写路径要算出「这次改动影响哪几卷」，正文改动确实只影响所在卷，
   可行但要在 `putContent` 里多一次查篇章。暂缓 —— 24h TTL 下「整本书的卷页一起失效」的代价只是下次回源多几百行。

## 后果

- 书页预算 ≈1,165 → **≈314 `rows_read`**，全是实测值：
  26 主题/设置 + 15 `getBookById` + 1 探测 + **56 卷列表** + 13 物化统计 + 1 最近更新 + **114 附：方剂**
  （`getTcmBookFang`，该书 113 首）+ 42 相关推荐 + 46 分类导航。
  （物化统计本快照实测 13 行 —— `ext_book_stats` 表内 13 行；ADR 早期快照是 26 行。
  `getTcmBookFang` 是**早前 1,051 与 200 两版分解都漏掉的一项**，本轮补上并重算。）
- 卷页预算（实测，**不含** `loadPublishedFeed` 26 与 `loadSiteNav` 46）：15 `getBookById` + 56 `getBookVolumes`
  （1 行点查 + 55 篇章，上一卷/下一卷需要篇章顺序）+ 99 `getVolumeSections`（最大卷 97 条）+ 标注层 **605**
  （`ext_annotation_markers` 13 + 该书方剂 114 + 该卷实体的引用查询 ≈478）≈ **775 `rows_read`**。
  比早前按旧标注层（981）估的 ~1,080 更低 —— D6 把 981 换成了按实体的引用查询。
- 阅读页「返回」的锚点约定随之改变（见 CONTEXT.md「章节回跳锚点」）：从 `/book/<id>#mf-toc-<条id>`
  改为 `/book/<id>/v/<篇章id>#mf-toc-<条id>`。**两侧必须同时改**，否则返回到书页顶部。
- `items_book_kind` 索引变宽一列（`pub_date`），写入略贵、索引个数不变。
- ⚠️ **部署顺序是硬前提**：`getAppStyleConfig` 现在 `SELECT … small_font_scale …`，该列由 0109 新增。
  若代码先于迁移上线，这条查询在每个 TCM 内容页上抛 `no such column` → `withEmpty` 兜成**空样式** →
  **全部 `$f{}` / `$u{}` 标记退化成原文**（不报错，静默退化）。必须**先应用迁移再发版**。
  本轮已实测到这条：单测的内存 schema 缺该列时，收到的正文就是 `用 $f{吴茱萸汤} 治之。`，一个字面标记都没渲染。
- **触发器的 `json_extract(NEW.data, …)` 不是新增暴露面 —— 而且真正的防线是表达式索引，不是触发器。**
  直觉上「触发器对每行求值 json_extract，遇非法 JSON 会中止写入」是风险，但**在这张表上不可达**：
  `items` 上有 **11 条以 `json_extract(data, …)` 为表达式的索引**（`items_tcm_kind_name`、
  `items_source_book_id`、`items_section_order`、`items_fang_order_v2` …），维护索引就必须求值表达式
  ⇒ 非法/空串的 `data` **根本写不进 items**。
  **实测证据**：把全库 **10 个触发器全部 DROP** 之后，`UPDATE items SET data = '' …` 仍抛 `malformed JSON`。
  ⇒ 本迁移**不设 `json_valid` 守卫**（该分支不可达，属死代码）。`items.data` 可空；
  `json_extract(NULL, …)` 返回 NULL 不抛错，NULL 行也安全。
- 卷页单页体积：主题 CSS ≈50 KB + 卷正文 0.2~20 KB + 标注浮层 runtime 0~132 KB（中位 21 KB），中位 ≈90 KB。

## 实现状态（2026-10-13 收尾时）

代码已接入 D1–D7（D6 早前完成），全部接线项与路由/模板/缓存注册就位，实测见「验证」。
逐条对账：

| 决策 | 状态 |
|---|---|
| D1 卷页路由 `/book/<id>/v/<篇章 id>/` | **已实现**：`src/pages/book/[id]/v/[volumeId]/index.astro`。1 篇章行 + 该卷条文实测 **99 rows_read**（最大卷 97 条）；404 入口五个：`hidePublicWeb` / `!book` / TCM 容器频道 / 该 id 不是篇章或篇章已删（`getVolumeSections` 带 `status != 3`）/ 篇章不属于本书（`volumeIndex < 0`） |
| D2 书页只列卷 | **已接线**：书页改调 `getBookVolumes`（**56 rows_read** / 27 卷 = 1 行点查 + 55 篇章），不再调 `getTcmBookChapters`；模板按 `book_volumes.length` 渲染卷目录，扁平书改用平铺列表 |
| D3 卷内不渲染条标题 | **已接入**：模板输出 `<article class="mf-volume-section" id="mf-toc-<条 id>"><div class="mf-rich-content">正文</div></article>`，无条标题；正文由按卷一次的标注层渲染 |
| D3' 标注层两道门（2026-10-13 补记） | **已修**：`buildTcmMarkerLayer` 曾只用 `data-tcm-kind`（可链接实体）当「本页有标记」的判据，只含非链接码（`$a/$m/$w/$q/…`）的卷整层作废、正文裸露原文。本地快照 **700 个全非链接码条目**（占带标记条目 22.5%）受影响；全库不可链接 occurrence 6,139 / 14,349（42.8%）是 occurrence 占比——混合页的非链接码本就正常渲染，不计入受影响数。现分成「样式渲染门」与「弹层激活门」两道（见 ADR-0015「解析之后还有两道门」）：受影响卷（如辨痓湿暍 14 条全 `$a`）现已出灰色小字实体；`J5q0VbsovYa` 等含 `$f/$u` 的卷指标不回归（37 实体 / runtime 仍在） |
| D4 索引重建 + `getLatestBookSection` | **已接线**：书页头部「最近更新」走它，实测 **1 row** |
| D5 统计走物化 | **已接线**：书页头部走 `readBookStats(db, [bookId])`，实测 **13 rows_read**（本快照表内 13 行；ADR 早期快照是 26）。口径 = 全部已发布条目（`chapters_published`）：伤寒金匮 952 条 / 112,427 字，显示在卷目录副行「共 27 卷 · 952 条」 |
| D6 引用表 | **已实现**：`ensureMarkerCitations`（脏标记 + 懒自举）+ `findMarkerReferences`（按 `(book_id, marker_code, marker_name)` 查索引，`f`/`u` 都被读）。首个变更周期读取 **1,507** 行、写入 ≈1,504 行，之后每页读取 **127–212 行**；等价性与脏标记闭环都由仓库内测试守卫 |
| D7 卷页缓存注册 | **已实现**：`isBookScopedPath`（书页 `/book/{id}/` 与四段卷页 `/book/{id}/v/{卷}/` 一条正则）进 `isPublicPagePath`，`publicCacheTagsForPath` 挂书页同款四标签（`mf:items` / `mf:pages` / `mf:theme:current` / `mf:public`） |

## 局限

1. 数值取自 **2026-10-13 本地快照**（9,506 items / 13 channels），Miniflare 绑本地 D1 副本累加 `meta.rows_read`。
2. `loadPublishedFeed` 的代价只能在 vitest（vite 处理 `*.mustache?raw`）里量 —— node/tsx 直接跑会
   `ERR_UNKNOWN_FILE_EXTENSION`。
3. **`ANALYZE` 会改变规划器选择**：同一「最近一条」查询在 ANALYZE 后基线从 8,348 变 1,625。
   本 ADR 的对照实验一律用**干净副本、不跑 ANALYZE**，与 ADR-0011 D4「ANALYZE 负收益」一致。
4. 本书 812 条文的 `pub_date` 大量并列（同一时间戳），所以「最近更新」本身有歧义（基线与索引修复后返回两条不同条文、
   时间戳相同）。这是数据问题，索引不解决。
5. 远端 D1 迁移由用户自行应用（仓库红线：生产由用户管理）。
6. **迁移 0109–0112 必须先于代码上线**（见「后果」）；本 ADR 的实现按「迁移已应用」验证。
   本批新增的**卷页**让这个静默退化面变大：卷页同样走 `getAppStyleConfig`，0109 缺列时它的正文与阅读页一样
   把 `$f{}` / `$u{}` 退化成原文 —— 退化面从 812 个阅读页扩到 **+27 个卷页**；而卷页被 D7 缓存 24h，
   迁移补上后也不会主动 purge（最长陈旧 24h）。
7. D6 的等价性只在本书（812 条文 / 126 个可点名）上验证过；更大书的引用表行数未实测。
8. **⚠️ plan §6.6 未按字面满足：生产环境 400px 窄屏仍有横向溢出。** 它不是卷页引入的，但也不构成
   对该条验收的满足 —— 按字面 §6.6 是「400px 窄屏无横向溢出」，而实测（无头 Chrome 153，400×900）
   卷页与**书页**都是 `scrollWidth 515 > clientWidth 385`。
   证据表明与 D1–D7 无关：① 换成「卷页自身」口径，`.mf-volume-page *` 里右边界超过 `clientWidth + 1`
   的元素数是 **0**；② 超宽元素 100% 是 `.fq-header-right`（站点公共头部）；③ 用**改动前的主题
   `local.feed-zh@0.1.40`** 测同一书页，结果一模一样（515 / 385 / 同一元凶）。
   plan §6.6 当时只在**原型**上验过（原型 CDP 记的「横向溢出 0/0」），而原型不渲染真实站点头部
   —— 所以那个 0/0 从未覆盖过公共头部。修共享头部是独立的范围外事项（与 plan §8「范围外发现」同类；
   `plan.md` 在 `.scratch/` 下、不在 git 跟踪内，尚未登记它）。**在它修好之前，本 ADR 对 §6.6 只记
   「卷页自身不新增溢出」，不记「无横向溢出」。**
9. **plan §6.6 的第二半「明 / 暗 / 护眼三态」同样没有生产实测** —— 生产只实测了浅色，
   原型 §10 自证「未覆盖暗色 / 护眼两态」。补齐是独立一批改动。
10. **只有 feed-zh 接入了两形态，其余 7 个捆绑主题对结构化 TCM 书会渲染空目录**：书页对结构化 TCM 书传
   `items: []`（改前会传整本书的条文列表），而那些主题的 `web-feed.mustache` 读的是 `{{#items}}`
   —— 不认 `book_volumes`，于是目录区块为空。本 ADR 的验收全部基于 feed-zh（中医站实际使用的主题），
   这也是备选 3（复用 `getWebFeed()` + 上下文分形态）**没有选**「新增 `webVolume` 模板类型」的代价：
   换模板格式约定，就得同步 7 个主题。要覆盖它们应是独立一批改动。

## 验证

- **数据层实测**（沙箱副本，已应用 0111/0112）：`getBookVolumes` → 27 卷 / **56 rows_read**（1 行「有没有条文」点查 + 55 篇章）；
  `getVolumeSections`（最大卷）→ 97 条 / **99 rows_read**；`getLatestBookSection` → **1 rows_read**。
  卷页与整本目录对同一条条文**逐字段一致**（`title`、`web_url`、`_microfeed` 全部 12 个键）。
- **接线后整页实测**（`.scratch/book-toc-plan/probe-volume-page.mts`，同一快照副本，调真实生产函数）：
  书页卷列表 27 卷 / **56** 行；卷页单卷 97 条 / **99** 行；**卷级标注层**（整卷合并一次）**605** 行、
  runtime 130,141 字节，**合并 97 段 → 切回 97 段**，切回后残留字面 `$f{`/`$u{` **0 段**；
  「最近更新」**1** 行；统计 **13** 行（口径 952 条 / 112,427 字）。
- **HTTP 端到端实测**（本地 `manage dev` + 真实主题 `local.feed-zh@0.1.44`，非单测合成数据）：
  书页 `/book/q6u5siNb2hT/` 200 —— 27 个卷链接、`目录 · 27卷`、副行「共 27 卷 · 952 条」、`112427 字`、
  `最近更新：夫治伤寒之法`、无条文行；
  卷页 `/book/q6u5siNb2hT/v/3F9tb8wzp8n/`（最大卷）200 —— **97 个 `<article id="mf-toc-…">`**、卷头「97 条」、
  **106 个已渲染实体**、runtime 已注入、**正文 0 处字面标记**；`/book/q6u5siNb2hT/v/Zvxqu65iRGE/` 200（1 条，正文「岁乙未…」）。
  卷页正文与阅读页走**同一条渲染链**：`bodyToHtml(description, content_format)` 再进标注层
  （阅读页的 `content_html` 就是这样来的，`FeedPublicJsonBuilder`）。本快照 8,513 行 section/chapter
  恒为 `content_format:"html"` 所以看不出差别，但单条改成 markdown 时卷页不会露原文（plan §4.4）。
  阅读页 `/i/BG98PR1K126/` 200，返回 = `/book/q6u5siNb2hT/v/3F9tb8wzp8n#mf-toc-BG98PR1K126`（两侧约定一致）。
  扁平书侧：`/book/4KbG9bDqdz3/`（中药）200 且仍是 **172 条平铺**、无「目录 · N卷」；
  `/book/4KbG9bDqdz3/v/F5Pf7dvj0rJ/`（它的 root 篇章）**404**；yao 阅读页返回 = `/book/4KbG9bDqdz3#mf-toc-vVJUANA6k8h`。
- **卷页渲染 CDP 实测**（无头 Chrome 153，`.scratch/book-toc-plan/probe-volume-render.mjs`，`mobile:false` 设视口）：
  `.mf-volume-page` 确实拿到页面根样式（`background rgb(245,246,248)` / `min-height 900px` / `box-sizing border-box`）；
  带 `#mf-toc-<条 id>` 进入时 `.mf-toc-came-from` 加在 **`<article class="mf-volume-section">` 本身**
  （不是正文里第一个内联 `<a>`）；400px 下「上一卷/下一卷」按钮 `white-space: normal`、会换行不出容器。
  ⚠️ 测视口必须用 `mobile:false` —— `mobile:true` 会让 `innerWidth`（400 设成 515）大于设定宽度，溢出判据失真。
- **D7 缓存注册**由 `tests/worker/public-cache.test.ts` 的「caches volume pages with the book page's
  invalidation groups」守卫：`/book/<id>/v/<篇章 id>/` 拿到 `public` + `mf:items` + `mf:pages` + `mf:theme:current`。
- 整页拆解（实测 `rows_read`）：`loadPublishedFeed` 26 / `getBookById` 15 / `tcmProbe` 1 /
  **`getTcmBookChapters` 921** / `getTcmBookFang` 114 / `listPublishedBookSamples` 42 / `listCategoryNav` 46 ≈ **1,165**。
- 索引对照（干净副本，无 ANALYZE）：`items_book_kind` 重建前 ①最近一条 **8,348** / ②COUNT 813 / ③篇章目录 28；
  重建后 **1 / 813 / 28**。
- 条标题删除依据：正文以标题开头 **803/812**、含标题但不在开头 1、正文短于标题 **0**、标题为裸序号 8。
- 标注层成本：一次调用 **981**（`ext_annotation_markers` 13 + 该书方剂 114 + **全书条文 847** + 药名 7×1）；
  按卷建层后 runtime 0~132,248 字节（中位 21,232）。
- 卷级标注层切分（原型口径，全书 812 条一次建层）：合并正文一次建层后按分隔符切回 **812/812 段成功**，
  且切回后的单条输出与单独建层**逐字一致**（A/B）。生产按卷建层的等价实测见「接线后整页实测」。
- **D6 等价性已固化成测试**（`tests/unit/server/tcm-marker-popover.test.ts` 的
  「agrees with the substring scan it replaced」）：参照实现（旧算法的逐字复刻）就内嵌在测试文件里，
  60 条引用 + 同条重复提及 + 跨书 + 无关各一例，断言逐条相等且同样在 50 条处截断。
  **变异检查**：把 `MAX_REFERENCES` 由 50 改成 60，该用例**确实失败** ⇒ 不是空转。
  中药侧另有「lists 条文 citing a 中药」用例，覆盖 `$u{吴茱萸(炮)}` 与 `$u{吴茱萸}` 归一到同一味药、跨书排除。
- 一次性探针（`.scratch/book-toc-plan/probe-d6-equivalence.mts`）：三条样本、四个方剂条目逐一比对，
  `findMarkerReferences` 与原「整本子串扫描」给出的引用**逐条一致**（id 与 title 都同，同样在 50 条处截断）。
  成本：首次（脏 → 重算）1,507 行；之后每页 **183 / 212 / 127** 行（含方剂表 114 与标记表 13 的固定开销）。
- **D6 脏标记闭环**（`.scratch/book-toc-plan/probe-d6-dirty-loop.mts`）：改一条正文 → `computed_at_ms` 变 0 →
  渲染一次 → 引用数 70 → 71 且试验条文出现；还原 → 再渲染 → 回到 70 且试验条文消失。
- **脏标记闭环也进了仓库**（同文件「rebuilds the index after a write, via the dirty flag」）：
  夹具里照抄了 0111 的三个触发器，断言「首次渲染盖时间戳 → 写入后 `computed_at_ms` 变 0 →
  下次渲染新条文进索引且时间戳复归」。
- **变异检查**（证明上面两条测试都不是空转）：① 把 `ensureMarkerCitations` 的新鲜度判断改成
  「有 state 行就直接返回」（忽略脏标记）⇒ 脏标记用例**失败**；② 把重算的 SELECT 从
  `tcm_kind IN ('section','chapter')` 改成 `= 'section'` ⇒ 差分用例**失败**（篇章分支漏掉）。
- **无方剂典籍的中药引用有真实数据证据**：`神农本草经・(人纪)`（方剂 0、3 条含 `$u{}`）实测
  中药浮层拿到引用（5 味各 1 条），不再只是单测推理。
- 回归：`tests/unit/server/tcm-marker-popover.test.ts` **7/7**（含差分等价性、脏标记闭环、中药引用三条）；
  `tests/unit/server/` 25 个文件全过、worker 相关 2 个文件全过；typecheck 0 error。
- **⚠️ 下面是原型（`proto/toc-volume-read-prototype.html`，书页内的折叠手风琴形态）的 CDP 实测，不是生产卷页**：
  无头 Chrome 153，1424×749 / 400×800 —— 27 卷 / 812 条、首屏展开 0、可见正文 0、页面内条标题元素 0、
  点卷显示该卷全部条（最大卷 97 条、空正文 0）、横向溢出 0/0、hash 自动展开所属卷。
  **生产是「一卷一页」**：没有展开/收起，hash 直接在卷页内滚动（见上面「HTTP 端到端实测」那条）。
