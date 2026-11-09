# 前台内容引擎切换：技术规范

> 配套 [ADR-0066](./novel-cms/adr/0066-front-site-standalone-module-engine.md)（架构决策）、[数据完整性核准报告](./front-site-catalog-switch-data-audit.md)（逐项量化）、`CONTEXT.md`（领域词条：题材分类 / 书本信息 / 书本分组 / 独立内容引擎）。
>
> 一句话：前台「站点外壳 → 题材分类 → 书 → 卷 → 正文 → 标注引用 → 中药/名词条目」七层，全部从独立模块取数，`channels`/`items`/`publicFeed`/mustache 主题从前台退场。页面结构与地址不变，视觉按现版 `feed-zh` 一比一移植；**ID 体系整体换新（旧地址一律失效，不做兼容），部分渲染细节必须按本文处置**，否则会丢内容。

## 0. 背景与目标

前台站点（主题渲染的公共页）目前建在 novel-cms 两套老真源上：书 = `channels` 行、正文 = `items` 行、分类 = `ext_category` + `channels.genre`、字数 = `ext_book_stats` 物化。后台已建起一套完全解耦的独立模块：`book_info`/`book_chapter`/`book_chapter_body`/`fang_yao`/`zhong_yao`/`ming_ci` + `settings.book_groups`。两套并行共存、互不读写（ADR-0058 决策 2）。

用户诉求：**正是 `channels`/`items` 的层层叠加耦合是要摆脱的根因**——前台显示不变，数据源整体切到独立模块。

### 需求基线（复核用）

这张表是需求口径的唯一来源，每次动工前先对一遍。只做表内的事；表外的改动一律先问。

| # | 需求（用户原话 / 裁决） | 落点 |
| --- | --- | --- |
| R1 | 前台显示方式不变，只换数据源 | §5 |
| R2 | 前台与 `channels`/`items` 完全解耦 | §1「零耦合不变式」 |
| R3 | **只改前端主题；后端与 `/admin` 不动**（③ 裁决的唯一豁免：一条 `data` 迁移，把站点外壳 4 个字段复制进 `settings`，见 R16） | §3.5、§10 |
| R4 | 分类复用 `/category/`，值换 `book_groups.key` | ADR 决策 2 |
| R5 | 首页书架也换 `book_info` | §5.2 |
| R6 | 档位 3：卷、正文、条目全切 | §3.2 |
| R7 | 砍字数 / 章节数 / 最近更新 | ADR 决策 5 |
| R8 | 标注层 `$f{}`→`fang_yao`、`$u{}`→`zhong_yao`，方剂按书解析 | §4.3、§4.4 |
| R9 | 中药/名词条目页一起切，旧 `/i/[slug]/` 退场 | §3.2 |
| R10 | 旧地址一律 404，不做兼容 | §4.5 |
| R11 | 站点外壳（主题 / `publicFeed` / 主频道）整体弃用 | §3.3 |
| R12 | `ext_annotation_markers` 保留（渲染 `$u{}` 这类标记用） | §3.5 |
| R13 | `ext_marker_citations`：换不了的砍掉 | §4.6 |
| R14 | 站点文件与自定义页一并收口（sitemap 改源、rss/**json**/llms 下线、`[...path]` 下线、`robots.txt` 登记例外） | §3.4 |
| R15 | 中间件不动（前台每请求仍读一次 `channels`，记为已知例外） | §3.4、§6 |
| R16 | **站点外壳 4 个字段搬进 `settings`**（裁决 ③）：`description`/`language`/`copyright`/`publisher` 由一条 `data` 迁移按实例从主频道 `channels.data` 复制到 `settings.webGlobalSettings`；`favicon` 一并按现网生效值写入。前台只读 `settings`，不读 `channels`，显示不变 | §3.4「P1 裁决：③」 |

**本次明确不做**：公开 API、后台页面与 ajax 端点、权限码、建表与加列（DDL）、后台写入链、删书清理、中间件。站点文件端点（`sitemap.xml` / `rss` / `json` / `llms*`）与 `[...path].astro` 自定义页**在范围内**，一并处理。**唯一破例**：为 R16 写一条 `data` 类型迁移（只改 `settings` 的数据，不改 schema、不动后台代码），见 §3.4。

**站点外壳字段的真源（2026-11-07 复核实测，R16 的依据）**：`settings` 全库 13 个分类（`access`/`analytics`/`apiSettings`/`app_login_methods`/`book_groups`/`book_info_statuses`/`contentReview`/`customCode`/`mail_settings`/`mingci_groups`/`signup_sources`/`subscribeMethods`/`webGlobalSettings`）**没有任何一个含** `description`/`language`/`copyright`/`publisher` 键。这 4 个字段今天的真源是主频道行 `channels.data`（`_WgpmyEc5Ze`，`is_primary=1`）：`language="en-us"`、`copyright="©{{current_year}}"`、`description`/`publisher` 为空。`webGlobalSettings` 实际只有 6 个键：`publicBucketUrl`/`favicon`/`itemsOrder`/`itemsSort`/`itemsPerPage`/`siteTitle`，其中 `favicon` 的值是 `/assets/default/favicon.png`（等于 `LEGACY_DEFAULT_FAVICON_URL`，被 `hasUploadedFavicon` 判为「未上传」），真实生效的站点图标来自 `channel.image`（`/assets/default/channel-image.png`）的回退。**裁决 ③**：由迁移把这 4 个键（加改写后的 `favicon`）写进 `settings`，前台只读 `settings`。

数据核准（2026-11-07，本地 D1 只读探针）的结论分两类，必须分开对待：

| 类别 | 结论 |
| --- | --- |
| 内容量对等 | 分类 3/3、书 12/12、卷 445/445、正文 8,066/8,066、方剂 804/804、中药 172/172、名词 17/17 |
| **ID 体系不对等** | 卷 0/445、正文 0/8066、方剂 0/804、中药 0/172、名词 0/17 —— 只有「书」的 ID 两侧相同 |
| **口径不对等** | `is_enable` 不是发布开关；本草 930 条正文在 `section_note`；中药/名词的容器书已软删 |

后两类由 [核准报告](./front-site-catalog-switch-data-audit.md) 逐项量化，本文据此给出实施口径。

## 1. 架构总览

```
前台渲染层（Astro 布局 + 组件，主题 mustache 退场）
  ├─ 站点外壳 FrontLayout/SiteHeader/SiteFooter  ← site.ts ──┐
  ├─ 首页书架 /                                    │
  ├─ 分类落地页 /category/[key]/                    │
  ├─ 书页 /book/[id]/                               ├─→ src/server/catalog/*  （前台唯一取数入口）
  ├─ 卷页 /book/[id]/v/[volumeId]/                  │      ├─ site.ts      → settings（站壳 6 字段 + access，见 §3.4）
  ├─ 中药条目 /zhongyao/[id]/                       │      ├─ groups.ts    → settings.book_groups
  ├─ 方剂条目 /fang-yao/[id]/                       │      ├─ books.ts     → book_info
  ├─ 名词条目 /ming-ci/[id]/                        │      ├─ chapters.ts  → book_chapter + book_chapter_body
  ├─ 标注层引用浮层                                 │      ├─ entries.ts   → zhong_yao / fang_yao / ming_ci
  │    └─ markerPopover.ts                          │      ├─ refs.ts      → fang_yao / zhong_yao（引用目标）
  └─ sitemap.xml /sitemap.xml.ts ───────────────────┘      └─ sitemap.ts   → 上面各表的 URL 集合
```

**核心原则**：新建 `src/server/catalog/` 作为前台页面与 sitemap 的唯一取数入口，消费点只换调用、不碰旧真源。新增取数逻辑全部落在新目录；四个前台页面、`markerPopover.ts`、`sitemap.xml.ts` 按 §9 改写属本次授权范围，既有门禁脚本只做插行级同步（§10）。

**零耦合不变式**：作用域是**前台对外输出**（首页、分类页、书页、卷页、三条条目页、站点外壳、`sitemap.xml`）。在这个作用域内，任何 SQL 都不得出现 `items`、`channels`、`ext_category`、`ext_book_stats`、`ext_book_status`；也不得出现 `loadPublishedFeed`、`loadFeed`、`getPublicJsonData`、`publicFeed`、`new Theme`、`themeContext`、`renderThemeTemplate`。唯一允许的 `ext_*` 表是 `ext_annotation_markers`（标记语法字典）。旧 `/i/[slug]/`（读 `items` + `channels`）整体退场。判据全文见 ADR-0066「零耦合不变式」。

取数只允许来自这些表：`settings`（承载 `book_groups` / `webGlobalSettings` / `access` 三类配置）、`book_info`、`book_chapter`、`book_chapter_body`、`fang_yao` + `fang_yao_body`、`zhong_yao`、`ming_ci`、`pages`（导航固定页，见 §3.4），以及唯一被允许的 `ext_annotation_markers`。`pages` 与其余各表同属独立模块，不含 `items`/`channels` 语义。

**站点文件与自定义页**：`sitemap.xml` 改由新模块生成，`rss`、`json` 与 `llms*` 下线，`[...path].astro` 下线（§3.4）；`404.astro` 去掉自定义页查询，并接住被删路由原有的后台 404 分支（§3.4 / §9 第 19 步）。**中间件不动**：`src/middleware.ts` 仍每请求跑 `loadFeed`，这份注入前台不再消费，但开销仍在，记为已知例外。`robots.txt` 同属例外（仍经 `publicSiteFileResponse` → `loadPublishedFeed`），见 §3.4。

## 2. 全局口径（先定这个，再谈实现）

### 2.1 可见性：`deleted_at IS NULL`，书级另加 `hot_book = 0`

**禁止在前台用 `is_enable` 过滤。** 实测代价：

| 表 | 若按 `is_enable=1` 过滤 | 丢失 |
| --- | --- | --- |
| `book_chapter_body` | 7,136 / 8,066 行正文 | 88.5% |
| `book_chapter` | 102 / 445 卷（含 1,091 条正文） | 22.9% |
| `fang_yao` | 4 本书的方剂整组为 0 | 743 / 1,585 次引用（46.9%） |

`is_enable` 在独立模块里是导入期语义（本草条目标记、方剂是否有组成、来源卷状态），与「发布」无关。

**同样禁止引入 `channels.status` / `ext_book_status`。** 旧链路靠它们表达「会员/隐藏」，新引擎不继承这个语义，也不做双源判据。

**书级另加 `book_info.hot_book = 0` 判据**（2026-11-07 会话修订）：`hot_book` 是 `book_info` 自带状态列（迁移 0173，`0 公开 / 1 隐藏 / 2 会员`），与旧频道状态无耦合，直接用作书级发布判据。**只对 `book_info` 行生效**——卷/正文/条目仍只看 `deleted_at`，不加书级条件（**sitemap 卷页枚举是例外**：为不产出隐藏书卷的 404 URL，卷查询的 `book_info` EXISTS 子查询额外过滤 `hot_book = 0`，见 §3.4）。

直接后果：现网非软删 10 本中公开 6 本（桂林古本、神农本草经疏、金匮宋版、难经、灵枢、素问），分类与首页只列这 6 本；`伤寒金匮・宋版`（`hot_book=1` 隐藏）与人纪三本（`hot_book=2` 会员）不再出现。旧链路里金匮宋版按 `channels.status=10`（会员）本不显示，现因 `hot_book=0` 公开而出现——这是「不读 `channels`」加上「书级公开判据」的共同结果，已被用户接受。

### 2.2 正文渲染：按 `bencao_yao_name` 分流

| 行类型 | 判定 | 渲染文本 | 行数 |
| --- | --- | --- | --- |
| 本草条目 | `bencao_yao_name` 非空 | `section_text` + `section_note` | 930 |
| 其余 | `bencao_yao_name` 为空 | 仅 `section_text` | 7,136 |

依据：旧正文去掉空白后 100% 是 `section_text + section_note` 的子串（8,066/8,066）；只读 `section_text` 的保留率是 52.3%（本草两本只有 18.1% / 6.7%）；而统一拼接会让「伤寒论・人纪」「金匮要略・人纪」多出 720.8% / 1,346.9% 的讲义内容（约 23.6 万字符）。

**拼接后必须转成 HTML**：旧站每条文是 `<p>` + 原文 + `</p>`（前导缩进保留、字面 `\r` 保留），渲染入口是 `{{{bodyHtml}}}`。新链路要产出等价的 `bodyHtml`：HTML 转义 → 按标记渲染 → 包 `<p>`。禁止把 `section_text` 当 HTML 直接输出。

### 2.3 标记码：`f` 方剂、`u` 中药

可链接码来自 `ext_annotation_markers.link_type`（`f`=2 方剂、`u`=1 中药），不是写死的常量。`$a{}` 是**按语**（`link_type=0`，只上色），`$g{}` 名词解释是 `link_type=3`（只上色不链接）。正文标记实测（全量语料）：`$f` 1,585 次 / 1,343 行，`$u` 57 次 / 24 行，`$a` 264 次 / 210 行。

**`$u` 必须按 §2.2 的分流语料报数**，否则数字不可比。三种口径实测：

| 语料 | `$u` 命中 / 出现 | 说明 |
| --- | --- | --- |
| 旧站正文 | 44 / 57 | 基准 |
| **本次分流**（930 本草行拼 `section_note`） | **44 / 57** | **零回归，验收基线** |
| 只读 `section_text` | 33 / 36 | 丢 11 次命中、21 次出现（都在本草行的 `section_note` 里） |
| 统一 `st + sn` | 48 / 62 | 多 4 次命中，但多出的 5 次出现来自非本草行的 `section_note`，且人纪两本正文膨胀 720.8% / 1,346.9%（§2.2 已否决） |

## 3. 文件级改动清单

### 3.1 新建（唯一允许的新文件）`src/server/catalog/`

前台只读层：五个内容模块各管一段（`groups`/`books`/`chapters`/`entries`/`refs`），加站点配置 `site.ts` 与 sitemap 生成 `sitemap.ts`。七个文件全部只读，没有写侧。

所有函数都收 `db: D1Database`，页面用 `env.FEED_DB` 传入（与后台 ajax 端点同一写法），**不依赖 `Astro.locals.feedDb`**。中间件本次不改，那份注入仍在，但前台取数不挂在它上面。

#### `groups.ts` — 题材分类

```ts
// 复用 @/server/book-info/groups 的 loadBookGroups（缺行回空；已存在但形状非法抛 invalid_book_groups）
import {loadBookGroups} from "@/server/book-info/groups";

export interface CatalogGroup {
  key: string;        // = settings.book_groups.key = book_info.case_division = /category/<key>/ 的 slug
  label: string;      // 显示名（如 伤寒金匮）
  bookCount: number;  // 该分组下公开书行数（deleted_at IS NULL 且 hot_book = 0）
}

export async function listGroups(db: D1Database): Promise<CatalogGroup[]>;
// 按 sort（次 key）稳定排序；bookCount 用一条 GROUP BY case_division 聚合

export async function getGroupByKey(db: D1Database, slug: string): Promise<CatalogGroup | null>;
// slug 即 book_groups.key；查不到返回 null（→ 404）
```

#### `books.ts` — 书本信息

```ts
export interface CatalogBook {
  id: string;            // = book_info.id（与旧 channels.id 同值，故 /book/<id>/ 地址不变；不读 channels 验证）
  title: string;         // book_name
  image: string;         // image_url（当前全空，组件回落占位图）
  author: string;        // author（10 本中 5 本有值）
  description: string;   // comment（书页简介；旧源取 channels.data.description，同为短文本）
  caseDivision: string;  // 归属分组 key
  url: string;           // /book/<id>/
}

export async function listBooksByGroup(db: D1Database, key: string): Promise<CatalogBook[]>;
export async function getBookInfoById(db: D1Database, id: string): Promise<CatalogBook | null>;
export async function listAllBooks(db: D1Database): Promise<CatalogBook[]>;  // 首页书架
```

过滤口径：`deleted_at IS NULL` 且 `hot_book = 0`（不加 `is_enable`）。排序按 `book_name`。分组显示名（`categoryName`）由调用方用 `listGroups()` 的 map 补，不在 `books.ts` 里再查一次 `settings`。

**确实没有对应数据、必须从组件里删掉的字段**：`serialStatus` / `serialStatusLabel`（旧值取自 `_microfeed.serialStatus`）、`wordCount` / `wordCountLabel`（旧值取自 `ext_book_stats`）。这两个字段在旧模板里都有回落分支（「连载中」「暂无字数」），删掉后书卡少两段文字，与 ADR-0066 决策 5 一致。封面与简介不回归。

#### `chapters.ts` — 卷章 + 正文

```ts
export interface CatalogVolume { id: string; name: string; }  // id = book_chapter.id

export async function listVolumesByBook(db: D1Database, bookInfoId: string): Promise<CatalogVolume[]>;
// book_chapter WHERE source_book_id = ? AND deleted_at IS NULL ORDER BY chapter_no
// 注意：不过滤 is_enable（会丢 102 卷）

export interface CatalogSectionRow {
  id: string;            // book_chapter_body.id
  bodyHtml: string;      // 见 §2.2：转义 + 标记渲染 + 包 <p>
}
export interface CatalogVolumeDetail { id: string; name: string; sections: CatalogSectionRow[]; }

export async function getVolumeWithSections(db: D1Database, chapterId: string): Promise<CatalogVolumeDetail | null>;
// 1 行 book_chapter + N 行 book_chapter_body（book_chapter_id = ? AND deleted_at IS NULL，ORDER BY receipt_no）
```

空卷存在且合法：445 卷里有 16 卷没有任何条文，旧站同样如此（显示「本卷暂无内容」）。

#### `entries.ts` — 三个模块的条目页

```ts
export interface CatalogYaoEntry {
  kind: "yao";
  id: string;
  no: number;              // zhong_yao_no
  name: string;            // zhong_yao_name
  alias: string;           // zhong_yao_bei_ming
  textHtml: string;        // zhong_yao_text，见 §2.3 标记渲染
  listRaw: string;         // zhong_yao_list（原样，不解析）
}

export interface CatalogFangEntry {
  kind: "fang";
  id: string;
  no: number;              // fang_no（本模块组内序号，与源 FangNo 无关）
  name: string;            // fang_name
  textHtml: string;        // fang_text
  drinkNum: string;        // fang_drink_num
  bookId: string | null;   // book_info.id（book_no = source_book_legacy_id 反查）
  bookName: string | null; // book_info.book_name；查不到留空，不回落 source_book_name
  bodies: {position: number; showName: string; amount: string}[];  // fang_yao_body
}

export interface CatalogTermEntry {
  kind: "term";
  id: string;
  no: number;              // ming_ci_no
  name: string;            // ming_ci_name
  alias: string;           // ming_ci_bei_ming
  textHtml: string;        // ming_ci_text
  image: string;           // show_image
  bookId: string | null;   // source_book_id（指向 book_info.id）
}

export async function getYaoEntry(db: D1Database, id: string): Promise<CatalogYaoEntry | null>;
export async function getFangEntry(db: D1Database, id: string): Promise<CatalogFangEntry | null>;
export async function getTermEntry(db: D1Database, id: string): Promise<CatalogTermEntry | null>;
// 三条各自单表点查（+ fang_yao_body 一次列表；fang 另按 book_no 点查 book_info 取所属书）
// WHERE deleted_at IS NULL

// 书页「名词」区块与 listTermsByBook 已删除（2026-11-07 会话修订，§5.5）：名词只在
// /ming-ci/<id>/ 单条可达，从正文 $g 标记进入；中药无归属字段，不提供按书聚合。

export interface CatalogFangRef {
  id: string;    // fang_yao.id → /fang-yao/<id>/
  name: string;  // fang_name
}

export async function listFangByBook(db: D1Database, bookInfoId: string): Promise<CatalogFangRef[]>;
// 书页「附：方剂」块。两条点查：book_info.book_no → fang_yao WHERE source_book_legacy_id = ? AND deleted_at IS NULL
// ORDER BY fang_no；book_no 为空或查不到方剂时回空数组（块不渲染），不回退全表、不跨书匹配。
// 与 refs.ts 的 `$f{}` 解析同一条链，但用途不同：这里要整本书的方剂清单，不是按名点查。
```

#### `refs.ts` — 标注层引用解析

```ts
export interface MarkerRef { id: string; name: string; url: string; }

export async function loadFangRefsForBook(db: D1Database, bookInfoId: string): Promise<Map<string, MarkerRef>>;
// book_info WHERE id = ? 取 book_no  →  fang_yao WHERE source_book_legacy_id = <book_no> AND deleted_at IS NULL
// url = /fang-yao/<fang_yao.id>/
// 实测 book_no 与 source_book_legacy_id 逐字相同（5/5），不需要书名匹配、不建外键

export async function findYaoRefByName(db: D1Database, pureName: string): Promise<MarkerRef | null>;
// zhong_yao WHERE zhong_yao_name = <归一化名> AND deleted_at IS NULL，url = /zhongyao/<id>/
// 归一化沿用 markerPopover 现有 normalizeYaoName（去尾部括号注）；zhong_yao 名本身无 "N、" 前缀
```

#### `site.ts` — 站点配置（替代 `publicFeed`）

```ts
export interface FrontSite {
  title: string;          // settings.webGlobalSettings.siteTitle；缺行回落 "microfeed"
  faviconUrl: string;     // settings.webGlobalSettings.favicon.url（迁移后 = 现网频道图）
  language: string;       // settings.webGlobalSettings.language（迁移从主频道复制）
  description: string;    // settings.webGlobalSettings.description → htmlToPlainText
  copyright: string;      // settings.webGlobalSettings.copyright → resolveBuiltInTemplateVariables
  publisher: string;      // settings.webGlobalSettings.publisher
  navPages: {url: string; label: string}[];  // pages 表：复用 @/server/pages/service 的 navigationPages()
  accessPolicy: "public" | "headless" | "offline";  // settings.access.currentPolicy
}
```

`loadFrontSite` 的两条点查固定走 `SELECT data FROM settings WHERE category IN ('webGlobalSettings','access')`，**不经 `loadFeed`/`loadPublishedFeed`**；缺键/缺行给默认值（`title` → `microfeed`、`language` → `zh-CN`、其余空串、`faviconUrl` 空即不输出 `<link rel="icon">`），不抛错。`navPages` 另调一次 `navigationPages()`（`pages` 表，§3.4）；它不在 settings 里，也不属旧真源。

四个站壳字段的取值全部来自 R16 那条 `data` 迁移写入的键——读取侧只做 `htmlToPlainText` / `resolveBuiltInTemplateVariables` 两步转换，不读 `channels`。

`refs.ts` 是 `markerPopover.ts` 的唯一数据入口，`markerPopover.ts` 自身不再写 SQL（`ext_annotation_markers` 的读取仍在 `reads.ts:getAppStyleConfig`，是标记字典，见 §3.5）。原本计划的 `citations.ts` 不再需要——反向引用块整体砍掉（§4.6）。

### 3.2 改写（消费点换调用）

四个前台页面与三条新条目页**一律不再调用 `loadPublishedFeed`**，`publicFeed` 不再存在。

| 文件 | 改动 |
| --- | --- |
| `src/pages/index.astro` | 删 `loadPublishedFeed`/`new Theme`/`renderThemeTemplate`/`loadSiteNav`；改 `loadFrontSite()` + `listAllBooks()`，渲染交 `FrontLayout` + `HomeShelf` |
| `src/pages/category/[slug]/index.astro` | 删同上四件；`getCategoryBySlugOrId`→`getGroupByKey`，`listChannelsByGenre`→`listBooksByGroup`，渲染交 `FrontLayout` + `CategoryShelf` |
| `src/pages/book/[id]/index.astro` | 删同上四件；换 `getBookInfoById`/`listVolumesByBook`/`listTermsByBook`/`listFangByBook`；**移除** `readBookStats`/`getLatestBookSection`/`totalWordCount`/`totalChapterCount`/`latestChapter*`/`getTcmBookEntries`。另有两条旧旁路必须一起删：`:103` 的 `allItems = loaded.publicFeed.items`（无标签时的书页内容回退）与 `:119` 的 `getBookChapters(feedDb, …)`（旧卷目录取数）——它们不在旧清单里，且都会把 `items` 带回前台。**`getTcmBookFang` 不删、改源**：它喂的是书页「附：方剂」块（5 本书共 804 首，是当前可见内容），换成 `listFangByBook` 按 `book_info.book_no → fang_yao.source_book_legacy_id` 取（§5.3），块本身保留 |
| `src/pages/book/[id]/v/[volumeId]/index.astro` | 删同上四件；换 `getVolumeWithSections`/`listVolumesByBook`；正文按 §2.2 产出 `bodyHtml` |
| `src/pages/zhongyao/[id]/index.astro`（**新建**） | `catalog/entries.getYaoEntry`；不再读 `items`、不再调 `getBookById` |
| `src/pages/fang-yao/[id]/index.astro`（**新建**） | `catalog/entries.getFangEntry`（含 `fang_yao_body` 组成列表） |
| `src/pages/ming-ci/[id]/index.astro`（**新建**） | `catalog/entries.getTermEntry`；`source_book_id` 指向 `book_info.id`，书链接走 `catalog/books` |
| `src/pages/i/[slug]/index.astro`（**删除**） | 读 `items` + `channels` 的旧条目页整体退场；旧地址按 §4.5 一律 404 |
| `src/server/tcm/markerPopover.ts` | `loadFangBySourceBook`/`queryYaoByPureName` 两条 SQL 移除，改调 `catalog/refs`；**`buildTcmMarkerLayer` 停用 `ensureMarkerCitations`、浮层删掉 `references` 分组**（反向引用块本次砍掉，§4.6）；函数本身与旧索引写入留在 `front-decoupling:ignore-*` 区段供后台 `fang-references` 复用，静态检查按区段跳过；`CONTAINER_CHANNEL_IDS`（`tcmfang0001`/`tcmyao00001`/`tcmterm0001`）连同两处引用一并删除——新条目页没有「容器书上下文」；链接由 `/i/<id>/` 改为 `/zhongyao/<id>/`、`/fang-yao/<id>/`，同时改掉 `closest('a[href^="/i/"]')` 与 `'/i/' + r.id`（三处硬编码前缀） |
| `src/server/feed/siteNav.ts` | **保留**：后台 `ajax/fangs`、`ajax/volumes` 仍用 `listCategoryNav`。前台四个页面不再调 `loadSiteNav` |

### 3.3 前台渲染层重写（主题退场）

主题的 mustache 契约就是 `publicFeed` 的形状（`_microfeed.volume`/`chapterNo`/`web_url`/`wordCount`、`items.0.title`），保留模板就必须伪造一份旧 JSON，等于换个姿势继续耦合。因此前台改为 Astro 渲染，视觉按现版 `themes/feed-zh/` 一比一移植。

**移植规则**：CSS 与 JS 原样搬，HTML 结构与 class 名不改，只把 `{{变量}}` 换成组件 props。

| 来源（`themes/feed-zh/`） | 去处 | 做法 |
| --- | --- | --- |
| `web-header.mustache` 三个 `<style>`（设计令牌 / novel 样式 / 编译后 Tailwind） | `src/styles/front-site.css` | 三段内容按原顺序拼接，一字不改 |
| `web-body-end.mustache` 第 16 行的脚本（主题切换 / 图片懒加载 / 导航溢出） | `src/scripts/front-site.ts` | 原样迁移，`localStorage` 键名 `microfeed-public-theme` 保持，避免用户偏好丢失 |
| `web-body-start.mustache` 的 header + nav | `src/components/front/SiteHeader.astro` | `{{#category_nav}}` 改遍历 `listGroups()`；`{{#navigation_pages}}` 改读 `catalog/site` 的 `navigationPages()`（`pages` 表，不是 settings，见 §3.4） |
| `web-body-end.mustache` 的 footer | `src/components/front/SiteFooter.astro` | `{{_microfeed.copyright}}`/`{{_microfeed.publisher}}` → `loadFrontSite()`；这两个键由 R16 迁移写进 `settings`，取值口径见 §3.4「P1 裁决：③」 |
| `web-home.mustache` 的书架 | `src/components/front/HomeShelf.astro` | `{{#book_samples}}` → `listAllBooks()`；字数/连载标签删（决策 5） |
| `web-category.mustache` | `src/components/front/CategoryShelf.astro` | 同上 |
| `web-feed.mustache` 的书页正文 | `src/components/front/BookDetail.astro` | 卷目录 + 作者 + 开始阅读 + **「附：方剂」块**（`listFangByBook`，§5.3） |
| `web-item.mustache` | `src/components/front/EntryPanel.astro` | 方剂/中药/名词三种条目共用，字段按 §5.4 |

外层壳由 `src/layouts/FrontLayout.astro` 承担：`<head>`（title/description/canonical/favicon/语言）+ CSS + header + slot + footer + 脚本。它替代 `PublicLayout` 的 `headHtml`/`bodyStart`/`bodyEnd` 三槽，**不再接受主题渲染出来的字符串**。

`themes/feed-zh/*` 与 `themes/default/*` 原文件保留不删（后台主题预览与回滚仍需要），只是前台不再读它们。

### 3.4 站点配置与站点文件端点

| 项 | 现状 | 切换后 |
| --- | --- | --- |
| 站名 | `publicFeed.title`（主频道 `channels.data.title`）；`_microfeed.siteTitle` 优先 | `loadFrontSite().title` ← `settings.webGlobalSettings.siteTitle`（**实测存在**，值「肘后斋」，与主频道 `title` 逐字相同）。缺行时回落 `microfeed`（与 `PublicLayout` 默认一致） |
| 站点图标 | `resolveEffectiveFavicon(settings.favicon, channel.image)` → 当前生效值 `channel-image.png` | `loadFrontSite().faviconUrl` ← `settings.webGlobalSettings.favicon.url`。**迁移把 `favicon` 改写成现网生效值**（`/assets/default/channel-image.png`，`contentType: image/png`），因此图标不变；同时 `hasUploadedFavicon` 从此为 true，`publicFeed` 侧的图标输出也保持一致（同值）。键名是 `favicon` 对象，不是 `favIcon` |
| 描述 / 语言 / 版权 / 出版方 | `publicFeed.description` ← `channel.description`；`language` ← `channel.language`；`_microfeed.copyright` ← `channel.copyright`；`authors[0].name` ← `channel.publisher` | **迁移写入 `settings.webGlobalSettings` 的 4 个键**：`description`（存 `channel.description` 原文，读取时 `htmlToPlainText`）、`language`（`en-us`）、`copyright`（`©{{current_year}}`，读取时套 `resolveBuiltInTemplateVariables`）、`publisher`（空）。`loadFrontSite()` 只读 `settings`，显示与今天逐字一致 |
| 站点隐藏策略 | `hidePublicWeb(content)` ← `settings.access.currentPolicy`（经 `loadFeed` 带出） | `loadFrontSite().accessPolicy` 点查 `settings` 的 `access` 行（实测 `{"currentPolicy":"public"}`）；`headless`/`offline` 仍 404，行为不变 |
| 导航固定页 | `publicFeed.navigation_pages` ← `@/server/pages/service` 的 `navigationPages()`，读 **`pages` 表**（`status != DELETED` 且启用导航的行） | `catalog/site` 的 `navigationPages()`，同一张 `pages` 表（已并入 §1 的十处允许来源）。**不是 settings** —— settings 里没有任何页面配置。当前 `pages` 仅 2 行（`system-404`、about 已删），导航实际为空 |
| 主题设置对前台的作用 | 后台换主题即换前台外观 | 失效（§3.3）。后台主题页保留，只影响预览 |
| `sitemap.xml` | 经 `publicSiteFileResponse` 取 `publicFeed.items` + `listPages` | 新增 `catalog/sitemap.ts` 生成：`/`、3 个分类页、6 个书页（公开）、对应公开书的卷页、804 个方剂页、172 个中药页、17 个名词页；`lastmod` 取各表 `updated_at`（七张表都有此列，无需省略分支） |
| `rss/`（`index.ts` + `stylesheet.ts`） | `rssFeedResponse` 读 `publicFeed.items` | **删除**（同一批处理：路由与 `pages/i/[slug]/rss/` 一并退场） |
| `json/`（`index.ts`）与 `pages/i/[slug]/json/` | `jsonFeedResponse` 读 `publicFeed`（整份 JSON Feed，含 `items`） | **删除**。它与 `rss` 是同一类公开订阅输出（`subscribe_methods` 里 `json` 与 `rss` 并列、都由 `PUBLIC_URLS` 自动填 URL），只删 rss 会留一条旧的 `channels`+`items` 出口。主题页脚不渲染订阅链接，删除不影响站内导航 |
| `llms.txt` / `llms-full.txt` / `api/llms*` | `llmsContent` 读 `publicFeed` | **删除三个路由**；`server/site-files/public.ts` 里的 `llmsContent` 分支保留不删（模块本次不重构） |
| `robots.txt` | 经 `publicSiteFileResponse` → `loadPublishedFeed`（带 `itemsOrder`/`itemsSort` 的 items 窗口）→ `robotsContent()`，输出只用 `request` 与 `hidden` | **不改**。它不显示内容，但每次请求仍触发 1 行 `channels` + 7 行 `settings` + 一个 items 窗口的读取；override 模式下模板还会拿到 `publicFeed`。与中间件并列为第二处已知例外，见 §6 |
| `[...path].astro` 自定义页 | `loadPublicPageRoute` 读 `items` 的 page 行 + `locals.feedContent` | **删除**。自定义页功能随旧内容体系退场，站内不再产出该类地址 |
| `404.astro` | 先 `loadPublicPageRoute(env, request, "404")` 找自定义 404 页；`[...path].astro` 同时承担后台路径的 404 渲染 | 去掉这次查询，公共路径只渲染 `PublicNotFoundHeading`（无自定义 404 页的站点表现与今天一致）；`[...path].astro` 下线后，它原有的后台 404 分支（`isAdminPathname` → `AdminShell` → `adminPageNotFound`，注入缺失时抛 `adminContextUninitialized`）整段迁入 `404.astro`，避免后台未匹配地址退化成公共标题。这是删路由的必要连带处理，后台代码没有新增功能 |
| 中间件 | 每个非 App 请求都跑 `loadFeed`，注入 `locals.feedContent`/`feedDb`/`feedCrud`（`src/middleware.ts:485`） | **不改**。前台页面不再消费这份注入，但请求仍会触发一次 `channels` 读；记为已知例外，见 §6 |

`sitemap.xml` 的口径与 §2.1 一致：只列 `deleted_at IS NULL` 的行，书级另加 `hot_book = 0`，不按 `is_enable` 过滤。三条条目页与卷页的 id 全部是新模块 id，旧地址不进 sitemap。

#### P1 裁决：③ 把 4 个字段搬进 `settings`

用户裁决 ③。做法是一条 **`data` 类型迁移**（`0189_data_front_site_settings.sql`（0188 之后的下一个空位，届时若被占用则顺延）），把主频道的 4 个站壳字段按实例复制进 `settings.webGlobalSettings`，并把 `favicon` 改写成现网生效值。前台此后只读 `settings`，站壳零读 `channels`，显示逐字不变。

**为什么必须是「按实例复制」而不是写死值**：这是可多实例部署的产品，本机 `language="en-us"`、`copyright="©{{current_year}}"` 只是当前实例的值，别的实例未必相同。迁移必须 `UPDATE settings SET data = json_set(...)` 里用子查询取各自的 `channels` 主频道值，不能把本机字符串写进迁移文件。

**迁移要做的四件事**：

| # | 动作 | SQL 要点 |
| --- | --- | --- |
| 1 | 复制 `language`/`copyright`/`description`/`publisher` | `json_set(data, '$.language', (SELECT json_extract(data,'$.language') FROM channels WHERE is_primary=1), …)`，`category='webGlobalSettings'` |
| 2 | 把 `favicon` 改成现网生效值 | 当 `json_extract(data,'$.favicon.url')` 为空或等于 `LEGACY_DEFAULT_FAVICON_URL` 时，取主频道 `image` 写入 `favicon.url`，`contentType` 取 `image/png` |
| 3 | 处理缺行/缺键 | 主频道缺失时该键不写（四条 `UPDATE` 各带 `... IS NOT NULL` 条件，子查询为 NULL 时整条不执行）；`settings` 行不存在时不建行（`loadFrontSite` 已有缺行回落）。实现不得用 `COALESCE(..., '')` 写空串 |
| 4 | 回滚 | 按 MIG-004：`data` 类型迁移必须带 `-- rollback:`，内容为 `json_remove` 上述 5 个键并还原 `favicon.url` |

**取值不做 JS 转换**：`description` 存原文（HTML），`copyright` 存 `©{{current_year}}` 原文——两者在 `loadFrontSite()` 读取时分别套 `htmlToPlainText()` 与 `resolveBuiltInTemplateVariables()`，与 `FeedPublicJsonBuilder` 用同一对函数。写进迁移的是原始值，语义留在代码里，避免迁移里塞业务逻辑。

**三条连带影响，必须写进验收**：

1. **「零迁移」这条边界以 R16 为唯一例外打开**：只有一条 `data` 迁移，不改 schema、不加列、不改后台代码；`settings` 行结构与既有 key 形状都不动（`webGlobalSettings` 本来就是 `[key: string]: unknown` 的松散包）。
2. **这 4 个键在后台没有编辑入口**：`/admin` 的站点设置表单不含这四个字段，写入后无人可改。这是本次接受的缺口；要维护就得加后台表单，属独立工作（不在本次）。在补表单之前，改站名以外的站壳字段只能直接改库。
3. **`favicon` 的语义从此变成「站点图标」**：值不再是 legacy 默认图而是频道图，后台 favicon 卡片会显示为「已有自定义图标」。视觉与前台输出都不变，但这是语义迁移，需在迁移注释里写明。

**与 ①② 的差别**（备查）：① 会让 `<html lang>` 变 `zh-CN` 且 `language` 硬编码；② 让 `site.ts` 保留一条 `channels` 点查，例外从 2 处变 3 处。③ 是唯一既零读 `channels` 又不改显示的路，代价是开一条 data 迁移 + 4 个键暂时没有后台入口。
### 3.5 明确不动

`extCategory.ts`（公开 API `content-read.ts` 仍用）、`bookWordCount.ts`（后台仍用）、所有后台页与 ajax 端点（含 `ajax/tcm/fang-references` 反向引用视图；`extBook.ts` 已于 2026-11-09 移除，其删书清理路径不存在，见 ADR-0071）、权限码、OpenAPI 契约、`content-read.ts`、`zhong_yao`/`ming_ci`/`fang_yao` 后台模块、`siteNav.ts`、`themes/**`、`Theme` 类、`src/middleware.ts`、`src/server/site-files/public.ts`。

`siteNav.ts` 内含 `listCategoryNav`（`ext_category JOIN channels`），但它**不在零耦合不变式的作用域里**——判据是「前台页面不再调用 `loadSiteNav`」，而不是「这个文件里没有旧表名」。它保留是因为后台 `ajax/fangs`、`ajax/volumes` 仍在用，静态检查不扫它。

`/json` 与 `i/[slug]/json` 两个路由文件属**删除**，不属「不动」。

`ext_annotation_markers` 前台**仍然读**（`getAppStyleConfig`，标记语法与配色），这是唯一的 `ext_*` 例外，定位见 ADR-0066 决策 16。`ext_marker_citations` 与 `ext_marker_citation_state` 彻底不动：前台不再读也不再写（§4.6），后台视图继续读，表与数据原地保留。

## 4. 关键映射机制

### 4.1 卷的旧 ID ↔ 新 ID（数据对等核对用，不做地址映射）

旧地址按 §4.5 一律失效，本节与 §4.2 的业务键**不进入运行时**。它们的作用是证明「两侧的卷/条文是同一批内容」，切换前用它核对行数与顺序没有漂移；唯一残留用途是数据不变式断言与实施时的抽查脚本。

映射键是 `chapter_section`，不是 `source_chapter_legacy_id`（后者只对上 26/445）：

```
book_chapter.source_book_id + book_chapter.chapter_section
  ↔ items.book_id + items.data._microfeed.section
```

实测 445/445 双向命中，`(source_book_id, chapter_section)` 445/445 唯一。注意 `chapter_section` **按书作用域唯一**：全局有 22 组重复（「伤寒金匮・宋版」与「金匮要略・宋版」都用 0–21），跨书查必须带 `source_book_id`。

### 4.2 条文的旧 ID ↔ 新 ID（数据对等核对用，不做地址映射）

映射键是 `receipt_no`，两侧 8,066/8,066 双向命中，且 `receipt_no` 全局唯一（8,066 个不同值）：

```
book_chapter_body.receipt_no
  ↔ items.data._microfeed.receiptNo
```

### 4.3 方剂按书解析（标注层 `$f{}`）

旧：`items WHERE tcm_kind='fang' AND json_extract(data,'$._microfeed.sourceBookId')=?`。
新：`book_info.book_no` → `fang_yao.source_book_legacy_id` → 该书方剂。**不用书名做中介**，也不建外键。

实测 5 组，`book_no` 与 `source_book_legacy_id` 逐字相同：

| `book_info.id` | `book_no` = `source_book_legacy_id` | 书名 | 行数 |
| --- | --- | --- | --- |
| `5IGM9t76quT` | 1001000 | 伤寒杂病论・(桂林古本) | 329 |
| `ydyQltIuQv6` | 10002 | 金匮要略・(宋版) | 202 |
| `q6u5siNb2hT` | 10001 | 伤寒金匮・(宋版) | 113 |
| `XNK0VFX39Xv` | 9040000 | 伤寒论・(人纪) | 111 |
| `Kcb7X2K5LTh` | 9050000 | 金匮要略・(人纪) | 49 |

SQL 过滤只加 `deleted_at IS NULL`（**不加 `is_enable`**，否则 1001000 与 9050000 两组全被裁掉，丢 618 次引用）。同一本书内方剂名无重复，按名建 Map 安全。

解析结果对照：旧 1,535/1,585（96.85%），新 1,534/1,585（96.78%）。唯一回归是 `滑石乱发白鱼散`（旧名）vs `滑石白鱼散`（新名），需加一条名称别名或接受该处降级为纯文本。

**解析范围锁在本书，不做跨书回落**（D5 裁决 A）。现网与上表都按「当前书」查方剂，实测比全局名表少解析 27 次跨书引用，涉及 25 个名字。典型是人纪版《金匮要略》（`9050000`）正文引用 `桂枝汤`/`五苓散`/`大承气汤`/`四逆汤`，而 `fang_yao` 把同名方剂登记在宋版（`10001`/`10002`）与桂林古本（`1001000`）下，人纪组内查不到。

「本书优先 + 全局回落」能把命中从 1,534 提到 1,561（+27），但不采纳：同名方剂在宋版与桂林古本各有独立行（`桂枝汤` 在 `10001`、`10002` 各一条，`fang_yao.id` 不同），跨书命中后必须再定「落到哪本书的哪一行」——这套书本优先级就是旧 `sourceBookId` 语义的复刻，等于把刚摘掉的东西装回标注层。这 27 次是现网既有缺陷，按书沿用与今天持平，不构成回归。

落到实现上是一条硬约束：`refs.ts` 里查 `fang_yao` 的 SQL **必须带 `source_book_legacy_id = ?`**，不允许出现无该书条件的 `WHERE fang_name = ?` 全表匹配。测试要覆盖这一点：给某一书的正文塞一个只登记在别书的方名，须降级为纯文本而不是链接到别书条目。

这里出现的 `source_book_legacy_id` 是 `fang_yao` 自己的列（源书号 `10001` 等），与 `book_info.book_no` 逐字对应，两侧都是新表的列，不读 `channels`、不建外键。带 `legacy` 字样不代表依赖旧表；真正服务导入映射的 `source_fang_legacy_id`、`book_chapter.source_chapter_legacy_id` 前台一律不读。

方剂页的「所属书」也不走 `source_book_name`：实测 5 组的 `source_book_name` 与 `book_info.book_name` 逐字相同（5/5，五本书都 `deleted_at IS NULL`），因此按同一个 `book_no → source_book_legacy_id` 反查 `book_info` 取书名并链到书页。`/fang-yao/[id]/` 只依赖 `fang_yao`、`fang_yao_body`、`book_info` 三张新表；反查不到时「所属书」留空，不回落到 `source_book_name`，也不展示 `source_fang_legacy_id`。

### 4.4 中药按名解析（标注层 `$u{}`）

旧：`queryYaoByPureName` 取 `items.title` 去掉 `^\d+[、.．]` 后的纯名去匹配。
新：`SELECT ... FROM zhong_yao WHERE zhong_yao_name = ? AND deleted_at IS NULL`。

`zhong_yao.zhong_yao_name` 172 个与旧纯名集合 172 个**完全相同**（仅旧/仅新均为 0），名表维度零回归。

未命中实测是 **12 个名字 / 13 次**，`zhong_yao` 里确实没有这些行（模糊匹配也无同名异写），属既有数据缺口，不是换源造成：`丹参`、`天冬`、`天麻`、`杏子`、`桂`、`桂心`、`牛膝`、`石菖蒲`、`菖蒲`、`远志`、`麦冬`、`大猪胆汁`。命中次数随正文语料变：旧正文 44/57、本次分流 44/57、只 `section_text` 33/36、`st+section_note` 48/62（§2.3 表格）。

方剂浮层里的「组成」行另有一套键：`fang_yao_body.yao_legacy_id` 是源内序号，与 `zhong_yao.id` 交集 0/2,025；只能按 `show_name` 匹配 `zhong_yao_name`，覆盖 1,930/2,025 = 95.3%，余 95 行（4.7%）不生成链接、只显示文字。

中药解析没有书目作用域，这是数据模型决定的，与 D5 不冲突：`zhong_yao` 本身没有归属列（D3 已确定不造这个字段），全局按名查是唯一可行做法；方剂则明确有 `source_book_legacy_id` 归属，跨书属于主动越界。

### 4.5 旧地址处置：一律失效，不做兼容（D1 裁决 A）

受影响的地址与锚点：

| 资源 | 数量 | 切换后 |
| --- | --- | --- |
| 分类页 `/category/<ext_category.id>/` | 3 | 404；`getGroupByKey` 只认 `book_groups.key`，旧地址段变 `/category/<key>/` |
| 卷页 `/book/<bookId>/v/<volumeId>/` | 445 | 404；旧 `volumeId` 是 `items.id`，新卷页用 `book_chapter.id` |
| 页内锚点 `#mf-toc-<sectionId>` | 8,066 | 失效；锚点 id 换 `book_chapter_body.id` |
| 条目页 `/i/<id>/`（方剂 804 / 中药 172 / 名词 17） | 993 | 404；改为 `/fang-yao/` `/zhongyao/` `/ming-ci/` + 新 id |

合计 1,441 个页面地址 + 8,066 个锚点。**不写 301、不建重定向表、不给任何新表补 `legacy_item_id`、不做任何 `items` 回查**。

三条被否掉的路与理由：

| 路线 | 为什么否 |
| --- | --- |
| 路由层反查 `items` 后 301 | 前台保留一条运行时 `items` 查询，直接违反零耦合不变式 |
| 一次性迁移给 5 张表补 `legacy_item_id` 并回填 | 该列的内容就是 `items.id`，只是把「运行时查询依赖」换成「表结构依赖」：此后每次数据迁移、快照、种子导入都要维护它，新模块永久携带旧表 ID 语义。用户裁决：新模块与 `items` 不允许有任何关系 |
| 手工维护 1,441 条 `旧 id → 新 id` 的重定向表或静态清单 | 数据来源仍是 `items.id`，切换后无真源可复核，等于一份永久人工跟进的死数据；且同样把旧 id 概念留在新模块里 |

代价与接受理由：外部链接、书签、已抓取的搜索结果会 404。这个库目前没有外部收录与站外跳转依赖，站内所有链接（导航、书页卷目录、条文锚点、标记浮层）切换后都按新 id 生成，不会自己产出旧地址；地址体系此后保持稳定。

实现侧不产生任何「兼容分支」：三条新条目路由按新 id 单表点查，未命中即 404；`/category/[slug]/` 未命中 `book_groups.key` 即 404。

### 4.6 反向引用索引：前台砍掉（R13）

浮层里「引用此方剂 / 引用此中药的条文」这块，画的是哪些条文提到了当前方剂/中药。它的数据源是前台自己算并写入的旧索引表：

```
卷页渲染 → ensureMarkerCitations(db, bookId)
  → SELECT computed_at_ms FROM ext_marker_citation_state   // 时间戳短路
  → SELECT id, rowid AS seq, data FROM items
      WHERE book_id=? AND tcm_kind IN ('section','chapter') AND status IN (1,4)
  → 扫 $f{}/$u{} 与 fangList
  → DELETE FROM ext_marker_citations WHERE book_id=? → 分片 INSERT OR REPLACE
```

`section_id` 是 `items.id`、`section_seq` 是 items 的 rowid、`book_id` 是 `channels.id`，整张表都是旧体系语义，新模块不能沿用。

**换成新模块要动三处，都不在「前端主题」内**：

| 要动的东西 | 属哪一层 |
| --- | --- |
| 建 `ext_citation_index` + `_state` 两张表 | 数据库 schema（迁移） |
| 后台保存正文后按书重算 | 后台写入链 |
| 后台方剂编辑器的反向引用视图改读新表（`ajax/tcm/fang-references`）；删书清理路径随 `extBook.ts` 移除（ADR-0071）而失效 | 后台 / ajax |

用户裁决「换不了的砍掉不要了」+「后端 / admin 不需要改动」，因此**前台直接不再提供这一块**：

- `buildTcmMarkerLayer` 不再调用 `ensureMarkerCitations`；浮层不再有 `references` 分组，其余分组（药名、方名、组成、按语配色）与点击跳转全部保留；
- `ajax/tcm/fang-references.ts` 仍导入 `ensureMarkerCitations`，删掉整段实现会让后台编译失败。函数与旧索引写入因此保留在 `markerPopover.ts` 末尾的 `front-decoupling:ignore-start/end` 区段，只服务后台视图；静态解耦检查精确跳过该区段，前台取数链不经过它；
- `ext_marker_citations` / `ext_marker_citation_state` 一行不动，前台取数链零读零写，后台视图继续读（数据停在切换时刻）。

**显示影响**：条目浮层少一段反向引用列表。这是本次唯一被接受的功能减法，其余显示不变。将来若要做，按上表三处另开一次工作，不在本次范围。

## 5. 视图形状字段映射

前台渲染从 mustache 模板换成 Astro 组件后，下表的「字段」即组件 props 的键名。**语义不变，来源整体换新**。三组分别对应导航/书架、书页/卷页、条目页。

### 5.1 导航与分类页

| 字段 | 旧来源 | 新来源 | 备注 |
| --- | --- | --- | --- |
| `category_nav[].slug` / `[].id` | `ext_category.slug` / `ext_category.id` | `book_groups.key`（两个字段同值） | 旧模板两个字段都用过；组件统一只传 `key` |
| `category_nav[].name` | `ext_category.name` | `book_groups.label` | — |
| `category_nav[].bookCount` | `channels.genre` 计数 | `COUNT(book_info WHERE case_division=key)` | 伤寒金匮 3→5（见 §5.6） |
| `category_books[]` | `listChannelsByGenre` | `listBooksByGroup` | 组件只读 title/image/author/url |
| `site_title` / `favicon` / `description` / `language` / `copyright` / `publisher` | `publicFeed.title` / `_microfeed.siteTitle`；`favicon` 经 `resolveEffectiveFavicon`（settings → `channel.image`）；其余 4 项真源是主频道 `channels.data` | `loadFrontSite()`（§3.4）：全部读 `settings.webGlobalSettings`，4 个缺失键由 R16 迁移补齐 | 显示逐字一致 |
| `navigation_pages[]` | `publicFeed.navigation_pages` | `catalog/site` 的 `navigationPages()`（`pages` 表） | 不是 settings |

### 5.2 首页书架与书卡

| 字段 | 旧来源 | 新来源 | 备注 |
| --- | --- | --- | --- |
| `book_samples[]` | `listPublishedBookSamples`（channels） | `listAllBooks`（book_info） | 9→10 张（§5.6） |
| 书卡 `title` | `channels.data.title` | `book_info.book_name` | — |
| 书卡 `image` | `channels.data.image` | `book_info.image_url` | 当前全空，组件回落占位 |
| 书卡 `author` | `channels.data.authors[0].name` | `book_info.author` | 5 本由空变有值 |
| 书卡 `description` | `channels.data.description` | `book_info.comment` | — |
| 书卡 `categoryName` | `channels.genre` → `ext_category.name` | `case_division` → `book_groups.label` | — |
| ~~书卡 `wordCountLabel`~~ | `ext_book_stats` | **删除** | 决策 5；组件不再渲染该行 |
| ~~书卡 `serialStatusLabel`~~ | `_microfeed.serialStatus` | **删除** | 新模块无对应列 |

### 5.3 书页与卷页

| 字段 | 旧来源 | 新来源 | 备注 |
| --- | --- | --- | --- |
| `book_title` | `channels.data.title` | `book_info.book_name` | — |
| `book_volumes[]` | `getBookVolumes`（items 篇章） | `listVolumesByBook`（book_chapter） | id 不同，URL 见 §4.5 |
| `volume_sections[].id` | `items.id` | `book_chapter_body.id` | 锚点 id 变 |
| `volume_sections[].bodyHtml` | `items.description` | `section_text`(+`section_note`) 转 HTML | §2.2 |
| `novel_detail.author` | `channels.data.authors[0].name` | `book_info.author` | 5 本由空变有值 |
| `novel_detail.firstChapterUrl` | `/book/<id>/v/<首卷 id>/` | 同（卷 id 换 `book_chapter.id`） | — |
| `book_fang[]`（「附：方剂」块） | `getTcmBookFang`：`items WHERE tcm_kind='fang' AND json_extract(data,'$._microfeed.sourceBookId')=?` | `listFangByBook`：`book_info.book_no` → `fang_yao WHERE source_book_legacy_id=?`（§4.3 同一条链） | 5 本书共 804 首，**块必须保留**；排序沿用 `fang_no` |
| ~~`book_terms[]`（「名词」区块）~~ | `getTcmBookEntries` 里 `tcm_kind='term'` 的部分 | **删除**（2026-11-07 会话修订；正文 `$g` 标记仍链接 `/ming-ci/[id]/`） | §5.5 |
| ~~`novel_detail.totalWordCount`~~ | `ext_book_stats` | **删除** | — |
| ~~`novel_detail.totalChapterCount`~~ | `ext_book_stats` | **删除** | — |
| ~~`novel_detail.latestChapter*`~~ | `getLatestBookSection`（items） | **删除** | — |

### 5.4 三条条目路由的 id 解析

旧 `/i/[slug]/` 用 `getIdFromSlug` 取末尾 11 位 id，canonical 是 `/i/<itemId>/`（`PUBLIC_URLS.webItem`）。切换后拆成三条路由，各自单表点查，不再有「先查 A 再查 B」的跨表猜测：

| 路由 | 取数 | 备注 |
| --- | --- | --- |
| `/zhongyao/[id]/` | `zhong_yao` 单行 + 标记渲染 | `zhong_yao_list` 原样不解析 |
| `/fang-yao/[id]/` | `fang_yao` 单行 + `fang_yao_body` 组成列表 + 按 `book_no` 点查 `book_info` 取所属书 | 不读 `source_book_name`；`source_fang_legacy_id` 不展示 |
| `/ming-ci/[id]/` | `ming_ci` 单行 | `source_book_id` → `book_info.id` 出「所属书」链接 |

三表主键都是 `VARCHAR(11)`，与 `items.id` 交集分别是 0/172、0/804、0/17。旧地址按 §4.5 一律 404，不做兼容。

### 5.5 书页的扁平条目目录

旧：`getTcmBookEntries` 按 `items.book_id` 取 `tcm_kind IN ('yao','term')`，172 条中药挂在容器书 `4KbG9bDqdz3`、17 条名词挂在 `tcmterm0001`。

新源不再有两个容器书页（两行在 `book_info` 已软删，`deleted_at IS NULL` 列书后消失），因此：

| 条目 | 新表的归属能力 | 前台呈现 |
| --- | --- | --- |
| 中药 | `zhong_yao` 没有归属字段 | **不做书页聚合**，只在 `/zhongyao/[id]/` 单条可达，从条文里的 `$u` 浮层进入 |
| 名词 | `ming_ci.source_book_id` 存在，分散在 4 本真实书（伤寒论・人纪 8、神农本草经疏 7、伤寒杂病论 1、黄帝内经・灵枢 1） | **书页目录不再列名词**（2026-11-07 会话修订），只在 `/ming-ci/[id]/` 单条可达，从正文里的 `$g` 标记进入 |

`listTermsByBook` 已随书页「名词」区块一并删除（无其他调用方）；不为 `zhong_yao` 造归属字段。

### 5.6 内容可见范围变化

书级判据 = `book_info.hot_book = 0`（§2.1 修订），只对 `book_info` 行生效。现网非软删 10 本中公开 6 本：

| 分类 | 非软删 | 公开（`hot_book=0`） | 说明 |
| --- | --- | --- | --- |
| 伤寒金匮 | 5 | 2 | 桂林古本、金匮宋版；伤寒金匮・宋版隐藏、人纪两本会员 |
| 本草 | 2 | 1 | 神农本草经疏；人纪神农本草经会员 |
| 内经 | 3 | 3 | 难经、灵枢、素问 |

首页书架与分类只列这 6 本公开书（原按 `channels.status` 判「会员/隐藏」的两本宋版书，现按 `hot_book` 判：金匮宋版公开出现、伤寒金匮宋版隐藏不出现）。这是「不读 `channels`」加上「书级公开判据」的共同结果，已确认接受。旧链路数值（分类 3、首页 9 张）基于 `channels.status`，与本模块无对应列，不再作为对照基线。

**站点外壳不产生显示变化**（R16 裁决 ③）：`<html lang>` 仍是 `en-us`、页脚版权仍是 `©2026`、站点图标仍是 `channel-image.png`——4 个缺失键由 `data` 迁移从主频道复制后写进 `settings`，`favicon` 改写成现网生效值。`description`/`publisher` 旧值本就为空，迁移写入空串。唯一非显示层的连带变化：`settings.favicon` 从 legacy 默认图变为频道图（后台卡片显示「已有自定义图标」），以及这 4 个键暂时没有后台编辑入口（§3.4）。

## 6. 错误处理策略

- **fail-fast**：`book_groups` 已存在但形状非法时，沿用 `loadBookGroups` 的 fail-closed（抛 `invalid_book_groups`），前台不吞成空；缺行回空数组（ADR-0059 决策 5 口径）。
- **404 口径不变**：书/卷/条目查不到、站点隐藏（`shouldHideFrontSite`）→ 一律 404。站点隐藏改读 `settings.access`（§3.4），行为与旧 `shouldHidePublicWeb` 一致。
- **TCM 容器频道不再有专门判定**：旧代码用 `isTcmContainerChannel`（判 `microfeed.tcmContainer`）把三张容器频道打成 404。新引擎没有容器书概念——两行容器书在 `book_info` 已软删，`getBookInfoById` 查不到即 404，判定自然成立。`CONTAINER_CHANNEL_IDS` 与两处调用一并删除，不留分支。
- **标注层引用查不到** → 沿用现状降级为纯文本上色（`renderTcmMarkers` 的 unknown 分支），不抛错。本次新增的降级点：方剂名 1 处（`滑石乱发白鱼散`）、跨书方剂引用 27 次（25 个名字，D5 裁决按书解析的既有结果，不是本次引入）、方剂组成 95 行（46 个药名）、既有两套源都缺的 35 个方剂名 / 50 次与 12 个中药名 / 13 次。
- **站点配置缺行不抛错**：`loadFrontSite` 对 `settings` 缺行/缺键给默认值（`title` 回落 `microfeed`（与 `PublicLayout` 的默认 `title` 一致）、`language` 回落 `zh-CN`、`description`/`copyright`/`publisher` 回落空串、`faviconUrl` 空即不输出 `<link rel="icon">`、`accessPolicy` 回落 `public`），避免配置缺失导致整站 500。
- **站点图标的回退链由迁移接住**：旧链路在 `settings.favicon` 判为「未上传」时回退 `channel.image`；新链路没有这个来源，改由 R16 迁移把 `favicon` 直接写成现网生效值。若某实例迁移时主频道无 `image`，`favicon` 保持原值（legacy 默认图），不报错。
- **两处已知的旧真源读取**（不属页面取数路径，不写进「零读」）：① `src/middleware.ts:485` 每个非 App 请求都跑 `loadFeed` 并注入 `locals.feedContent`/`feedDb`/`feedCrud`，前台页面不再消费但请求仍触发一次 `channels` + `settings` 点查；② `robots.txt` 经 `publicSiteFileResponse` → `loadPublishedFeed`（带 items 窗口），输出只用 `request` 与 `hidden`。两处都保留原样，页面全部走 `catalog/*` 与 `env.FEED_DB`。
- **空卷**：445 卷中 16 卷无条文，渲染「本卷暂无内容」，与现状一致。

## 7. 依赖管理

无新依赖。复用 `@/shared/TcmMarkers`（`renderTcmMarkers`/`markersToPlainText`，纯函数）、`@/server/book-info/groups`（`loadBookGroups`）、`@/server/pages/service`（`navigationPages`，取导航固定页）、`@/shared/StringUtils`（`htmlToPlainText`，站壳描述转纯文本）、`@/shared/TemplateVariables`（`resolveBuiltInTemplateVariables`，展开 `copyright` 里的 `{{current_year}}`）、`@/server/admin/annotation-marker-handlers` 背后那张 `ext_annotation_markers`（只读）。后两个函数与 `FeedPublicJsonBuilder` 用的是同一对，站壳输出口径不会分叉。不引第三方库。

## 8. 验证策略

- **门禁只在手动触发时跑**（AGENTS.md「最高指令」）。测试只写不跑。
- **解耦门禁**：`scripts/check-front-site-decoupling.ts`，手动触发 `node --import tsx scripts/check-front-site-decoupling.ts`；不并入 `yarn check`，也不并入 `microfeed-gate-subset`。扫描范围就是下面「解耦断言」逐字列出的那一份，四处已知例外显式登记。规则编号 `DECOUPLE-001`～`006` 分别覆盖禁用词、内容表可见性、方剂书作用域、旧地址兼容痕迹、旧出口退场、新路由齐备。执行期的 `.scratch/front-site-catalog-switch/verify.mjs` 是这份清单的临时镜像，只做静态自检，不调用项目门禁。判定细则：`DECOUPLE-002` 拒绝 `FROM ${...}` 动态表名（改显式 SQL 才能静态核对可见性）；`DECOUPLE-003` 在剥注释后的 `loadFangRefsForBook` / `listFangByBook` 函数体里核对 `source_book_legacy_id = ?`，注释里出现字面量不算通过；`DECOUPLE-004` 只认重定向语义里的 301，尺寸与数值字面量不参与判定。
- **契约/运行时测试**（实施清单第 21 步，只写）：`tests/unit/server/catalog-contract.test.ts` 覆盖 `catalog/*` 七个模块取数形状、`/category/[key]/` 解析、三条新条目路由、书页「附：方剂」块、`loadFrontSite` 的缺行回落、旧地址 404、不写 301、方剂不跨书解析、引用解析基线（固定语料口径复算）；`tests/unit/server/tcm-marker-popover.test.ts` 随标注层改源整体重写夹具与断言（旧版本全量依赖 `items` + `ext_marker_citations` + `/i/`，切源后无法成立）。
- **数据不变式断言**（防将来任一侧漂移）：分类 3 组、书 alive 10（其中公开 `hot_book=0` 6）、卷 445、正文 8,066、方剂 804、中药 172、名词 17、`(source_book_id, chapter_section)` 唯一、`receipt_no` 全局唯一。
- **口径断言**：`catalog/*` 的 SQL 不得出现 `is_enable`（可写成静态检查），书级判据 `hot_book = 0` 为允许项（§2.1 修订）；本草分流按 `bencao_yao_name` 判定。
- **解耦断言**（D1/D5/站点壳裁决的落地）：① `src/server/catalog/**`、四条前台页面、三条条目路由、`markerPopover.ts`、`sitemap.xml.ts` 的源码里不得出现 `items`/`channels`/`ext_category`/`ext_book_stats`/`ext_book_status`/`legacy_item_id`/`ext_marker_citations`/`ensureMarkerCitations`；② 同样范围不得出现 `loadPublishedFeed`/`loadFeed`/`getPublicJsonData`/`publicFeed`/`new Theme`/`themeContext`/`renderThemeTemplate`；③ 方剂解析不得出书——给《金匮要略・人纪》的正文塞一个只登记在宋版的方名，须渲染为纯文本；④ 旧地址一律 404——旧卷 id、旧条目 id、`/category/<ext_category.id>/` 三条各一例，断言 404、不写 301。扫描范围明确不含 `src/middleware.ts`、`src/pages/robots.txt.ts`、`src/server/site-files/public.ts`、`src/server/feed/siteNav.ts` 四处（前两处是 §6 的已知例外，后两处是后台/站点文件模块，本次不重构）。注释与 `front-decoupling:ignore-start/end` 后台专用区段不参与判定，理由见 §4.6。P1 裁决 ③ 之后 `site.ts` **不需要任何白名单**——它不读 `channels`，4 个站壳字段全来自 `settings`。
- **引用解析断言必须固定语料**：验收基线是「新名表 + §2.2 分流语料」= `$f` 1,534/1,585、`$u` 44/57。只读 `section_text` 会得到 `$u` 33/36、统一 `st+sn` 会得到 48/62，两者都不是本次渲染口径，写进断言会误判。复算用 `.scratch/catalog-audit/audit-matrix.py`。测试只在固定语料上复算口径，不读 `docs/` 散文、不把全量数字硬编成第二份真源（AGENTS.md 硬性红线）；全量数字由只读探针取证。
- **视觉回归**：前台改组件后，取值不变的页面（首页/分类/书页/卷页的 DOM 结构）应与改前逐块对照 class 名与层级；CSS 与脚本是原样搬运，不允许「顺手优化」；`front-site.ts` 里来自 mustache 资产的 14 条英文注释随资产保留，作为「注释用中文」的已登记例外（新增说明一律中文，见 §9 第 9 步）。这项靠人工对照存档截图，不写成自动断言。
- **不做 dev server 端到端实测**；需要代价数字时用只读探针（`.scratch/catalog-audit/`）。

## 9. 实施清单（顺序化、原子化）

前置：需求基线 R1–R16 已定（对应 D1–D8 裁决 + P1 裁决 ③），已回填 §2.1/§2.2/§2.3/§3.2–§3.5/§4.3–§4.6/§5/§5.6。清单里没有建表与加列（DDL）、没有后端与 admin 代码改动；中间件不动；**唯一的库改动是第 0 步那条 `data` 迁移**。

**第零批：站点外壳字段入库（R16，独立可回滚）**

0. 新建 `migrations/NNNN_data_front_site_settings.sql`（`data` 类型，带 `-- rollback:`）：按实例把主频道 `channels.data` 的 `description`/`language`/`copyright`/`publisher` 复制进 `settings.webGlobalSettings`，并把 `favicon` 改写成现网生效值（细节见 §3.4）。主频道缺键时该键不写，不用 `COALESCE` 落空串（§3.4 迁移动作 #3）。这条迁移独立于页面改造，可以先跑并观察一段时间（前台仍走旧链路，不受影响）。

**第一批：取数层（不改页面）**

1. 新建 `src/server/catalog/groups.ts`。
2. 新建 `src/server/catalog/books.ts`。
3. 新建 `src/server/catalog/chapters.ts`（含 §2.2 渲染分流）。
4. 新建 `src/server/catalog/entries.ts`（三模块单条点查）。
5. 新建 `src/server/catalog/refs.ts`（`$f`/`$u` 引用解析，唯一读 `fang_yao`/`zhong_yao` 的入口）。
6. 新建 `src/server/catalog/site.ts`（站点配置 + `shouldHideFrontSite`）。
7. 新建 `src/server/catalog/sitemap.ts`（URL 集合，供 `sitemap.xml` 使用）。

**第二批：渲染层（先骨架后页面）**

8. 新建 `src/styles/front-site.css`：从 `themes/feed-zh/web-header.mustache` 三段 `<style>` 与 `web-home.mustache` 的一段首页专属 `<style>` 按原顺序原样提取，共四段。实施时核准出首页那一段只存在于 `web-home.mustache`，三段 header CSS 不含 `.mf-home-*` 规则，只搬三段会让首页书架失去样式；这一处按视觉零回归补齐。
9. 新建 `src/scripts/front-site.ts`：从 `web-body-end.mustache` 原样迁移主题切换/懒加载/导航溢出脚本。六段脚本里的 14 条英文注释随资产保留（翻译会改动资产本身），作为「注释用中文」的唯一已登记例外；文件头的新写说明用中文，`@ts-nocheck` 是移植无类型脚本所需。
10. 新建 `src/layouts/FrontLayout.astro`、`components/front/{SiteHeader,SiteFooter,HomeShelf,CategoryShelf,BookDetail,EntryPanel}.astro`（§3.3）。
11. 改写 `src/pages/index.astro`：`loadFrontSite` + `listAllBooks`，删 `loadPublishedFeed`/`Theme`/`loadSiteNav`。
12. 改写 `src/pages/category/[slug]/index.astro`：`getGroupByKey` + `listBooksByGroup`。
13. 改写 `src/pages/book/[id]/index.astro`：换 `catalog/*`，移除字数/章节数/最近更新、两条旧旁路（`publicFeed.items` 回退、`getBookChapters`）与 `getTcmBookEntries`；`getTcmBookFang` 改调 `listFangByBook`，**「附：方剂」块保留**（§5.3）。
14. 改写 `src/pages/book/[id]/v/[volumeId]/index.astro`：换 `catalog/chapters`，正文走 §2.2 的 HTML 产出。

**第三批：条目路由与标注层**

15. 新建 `zhongyao/[id]`、`fang-yao/[id]`、`ming-ci/[id]` 三条前台路由；删除 `i/[slug]/index.astro`。
16. 改 `markerPopover.ts`：删 `loadFangBySourceBook`/`queryYaoByPureName` 两条 SQL，改调 `catalog/refs`；`buildTcmMarkerLayer` 不再调用 `ensureMarkerCitations`，浮层删掉 `references` 分组（§4.6）；三处 `/i/` 硬编码前缀改新路由；`CONTAINER_CHANNEL_IDS` 与两处判定删除。**实现修正**：`src/pages/[adminPath]/ajax/tcm/fang-references.ts` 仍导入 `ensureMarkerCitations`，整段删除会让后台编译失败，所以该函数与其旧索引写入保留在文件末尾的 `front-decoupling:ignore-start/end` 区段内，只供后台反向引用视图复用；静态解耦检查精确跳过该区段，前台取数链不经过它。后台代码一行未改。

**第四批：站点文件与自定义页（§3.4）**

17. 改写 `src/pages/sitemap.xml.ts`：改调 `catalog/sitemap`，不再经 `publicSiteFileResponse`，不再读 `publicFeed`/`listPages`。
18. 删除 `src/pages/rss/index.ts`、`src/pages/rss/stylesheet.ts`、`src/pages/i/[slug]/rss/index.ts`、**`src/pages/json/index.ts`、`src/pages/i/[slug]/json/index.ts`**、`src/pages/llms.txt.ts`、`src/pages/api/llms.txt.ts`、`src/pages/api/llms-full.txt.ts`。`server/site-files/public.ts` 保持原样（`robots.txt` 与中间件的运行时站点文件覆盖仍在用，§6 记为已知例外）。
19. 删除 `src/pages/[...path].astro`；`src/pages/404.astro` 去掉 `loadPublicPageRoute` 查询，公共路径只渲染 `PublicNotFoundHeading`，并把被删路由原有的后台 404 分支（`isAdminPathname` → `AdminShell`，注入缺失时抛 `adminContextUninitialized`）迁入本页，避免后台未匹配地址退化成公共标题。

**第五批：守门**

20. 加静态检查 `scripts/check-front-site-decoupling.ts`：`src/server/catalog/**`、四条前台页面、三条条目路由、`markerPopover.ts`、`sitemap.xml.ts` 里出现禁用表名/符号即失败（注释与后台专用区段除外），清单见 §8。同步在 `scripts/check-server-layout.ts` 白名单登记新增的 `catalog/` 顶层目录，并清掉 `scripts/check-endpoint-registration.ts` 里随 llms 旧 base 路由一起下线的两条豁免登记（`/api/v1/llms*` 两条保留）。
21. 写契约/运行时测试（只写不跑），含 §8 的解耦断言四条与固定语料口径的引用解析基线；不写 `docs/` 散文断言（AGENTS.md 硬性红线）。文件为 `tests/unit/server/catalog-contract.test.ts` 与重写后的 `tests/unit/server/tcm-marker-popover.test.ts`。

## 10. 实施边界

- **改动范围（只有这些）**：四个前台页面改写、三条条目路由新建、`i/[slug]` 删除、`[...path].astro` 删除、`404.astro` 去掉自定义页查询并接住后台 404 分支、`src/server/catalog/` 七个只读模块、`FrontLayout` 与六个前台组件、`front-site.css`、`front-site.ts`、`markerPopover.ts`、`sitemap.xml.ts` 改源、`rss`/`json`/`llms*` 八个路由文件删除、1 个静态检查脚本、**1 条 `data` 迁移**（写站点外壳 4 个键 + `favicon`）。**零 DDL、零后端与 admin 代码改动。**
- **唯一的库改动**：`migrations/NNNN_data_front_site_settings.sql`，只 `json_set`/`json_remove` `settings` 行，不建表、不加列、不改既有 key 形状，且带 `-- rollback:` 可回退。这条迁移独立于页面改造，可先跑先观察。
- **已知缺口**：迁移写入的 4 个键在 `/admin` 站点设置表单里没有编辑入口，写入后只能改库；补齐表单属独立工作，不在本次。
- **排除范围**：所有后台页面与 ajax 端点（含 `ajax/tcm/fang-references`、后台写入链；`extBook.ts` 已于 2026-11-09 移除，见 ADR-0071）、公开 API（`content-read.ts`/OpenAPI）、`extCategory.ts`、`bookWordCount.ts`、权限码、`zhong_yao`/`ming_ci`/`fang_yao` 后台模块、`themes/**`、`Theme` 类、`siteNav.ts`、`src/middleware.ts`、`src/server/site-files/public.ts`。
- **硬边界**：作用域内不得出现 `items`/`channels`/`ext_category`/`ext_book_stats`/`ext_book_status`，也不得出现 `loadPublishedFeed`/`loadFeed`/`publicFeed`/`new Theme`/`themeContext`/`renderThemeTemplate`（ADR-0066「零耦合不变式」）。三件事同样算越界：为旧地址回查 `items`、给新表补 `legacy_item_id`、建 `旧 id → 新 id` 的重定向表或静态清单（R10）。把新数据组装成 `publicFeed` 形状喂给旧模板，同样算越界（R11）。
- **唯一允许的 `ext_*` 读取**：`ext_annotation_markers`（标记语法字典，15 行配置）。其余 `ext_*` 表在前台一律不可读，包括 `ext_marker_citations`。
- **旧表与旧数据一行不动**：`channels`/`items`/`ext_category`/`ext_book_stats`/`ext_marker_citations` 全部原地保留，不删表、不写清理迁移、不改数据。
- **允许新增文件**：`src/server/catalog/{groups,books,chapters,entries,refs,site,sitemap}.ts`、三条前台路由、`FrontLayout.astro` 与六个前台组件、`front-site.css`、`front-site.ts`、1 个静态检查脚本、2 个契约测试文件（其中 `tcm-marker-popover.test.ts` 为重写既有文件）、1 条 `data` 迁移。既有脚本只做插行级同步：`check-server-layout.ts` 白名单、`check-endpoint-registration.ts` 豁免清单。
- **不允许的事**：任何 DDL（建表、加列、改索引）；给 `book_info`/`book_chapter`/`book_chapter_body`/`fang_yao`/`zhong_yao`/`ming_ci` 加列；除第 0 步那条 `data` 迁移之外再写任何迁移（尤其不许用迁移改后台代码依赖的表结构）；动 `themes/**` 的 CSS 内容（只允许原样搬运到 `front-site.css`）；改任何 `/admin` 下的文件。
- **文档同步**：ADR-0066、本文、[核准报告](./front-site-catalog-switch-data-audit.md)、`CONTEXT.md`。
