# ADR-0006: 受保护的内容读 API（标签 → 书 → 卷章 → 正文）

- 状态：**Accepted**（技术方案已定，可实现；实现未开始）
- 日期：2026-09-24
- 决策人：用户
- 依据：ADR-0008 / ADR-0009 落地后的鉴权现状，加 2026-09-24 远程 D1 与源码实测复核

## 背景

需要给管理后台「内容」分组（`group_content`）下的模块提供**受保护的读 API**，让外部按
标签 → 书 → 卷章 → 正文 逐级获取内容。公开站已有等价的**页面**实现
（`src/pages/category/[slug]/`、`src/pages/book/[id]/`），但没有对应的内容 API。

关键事实（2026-09-24 远程 D1 + 源码实测）：

- **「标签」不是独立实体，就是 `Category`（`ext_category`）**。实测四条分类：
  `cat_x1`=东方玄幻（slug `eastern-fantasy`）、`OteD-aXHV_d`=本草、`j24vLiF3Sym`=内经类、
  `1runoCsI7dr`=伤寒，各带 1 / 1 / 1 / 4 本书。
  **4 个分类里有 3 个的 `slug` 就是中文名本身**（`本草` / `内经类` / `伤寒`），只有东方玄幻有拉丁 slug。
  ⇒ **分类地址以 id 为准**（见决策 1）：中文名生成的 slug 在地址栏会被百分号编码。
- **书 = `channels` 行；章节 = `items` 行**，靠 `data._microfeed.bookId` 关联 —— **不是外键**。
  **卷不是实体**，只是 `items._microfeed.volume` 字符串标记。
- `channels.genre` 已是真实列（`migrations/0023_ext_novel.sql`），`channels_genre` 索引存在；
  但**实测"按标签取书"的查询计划走的是 `channels_status`**（`channels_genre` 未被选中）——
  当前 7 本书的规模下无差别。
- `items` **无 `book_id` 列**（实测 `PRAGMA table_info(items)`：`id` / `status` / `data` /
  `pub_date` / `created_at` / `updated_at` / `content_text` / `content_text_updated_at` /
  `content_text_revision` / `review_status`）。
- **当前全站 34 篇章节，其中已发布 32 篇**（`status = 1`）。
- **API 基路径是 `/api/v1/`**（`API_MAJOR_VERSION = 1` → `API_VERSION = v1` →
  `API_BASE_PATH = /api/v1/`），另有 legacy `/api/`（带 deprecation 头）。
- **JSON 路径上的条件无法走索引。** `json_extract` 本身**在 D1 上可用**，实测：
  ```sql
  SELECT COUNT(*) FROM items
   WHERE json_extract(json_extract(data,'$._microfeed'),'$.bookId') IS NOT NULL;   -- → 32，成功
  SELECT json_extract(data,'$._microfeed.bookId') AS book, COUNT(*)
    FROM items WHERE status = 1 GROUP BY book;                                     -- → 正常返回各书章数
  ```
  ⇒ 按 `bookId` 取章节**可以直接用 SQL**（含 `UPDATE … SET book_id = json_extract(…)` 回填）；
  之所以仍要落列，是因为**无索引 ⇒ 必然扫描**，落列是把扫描换成索引查找。
- **`SQLITE_ERROR 7500` 的根因**：其含义是 **"Wrong number of parameter bindings"**，
  是 **wrangler CLI 不支持 `?` 占位符**的产物，与 SQL 内容无关。实测：
  ```sql
  SELECT COUNT(*) FROM items WHERE status = ?;   -- → code: 7500（普通查询，仅因带 ? 无绑定值）
  SELECT COUNT(*) FROM items WHERE status = 1;   -- → 32（同一查询内联字面量即成功）
  ```
  `src/server/feed/extCategory.ts:509` 的注释把这条 **CLI 参数绑定错误**误栽给了嵌套 JSON 路径，
  注释待更正（见「影响」末尾）。
- **正文格式**：`items.data.description` 存正文；`data.contentFormat` / `data.content_format` 表格式
  （`bodyFormat()` 缺省判为 `html`）。实测**当前 34 篇全部未设置格式且正文均为 HTML**（`<p>…</p>`）。

### 可复用的既有取数函数（均已实测核对）

| 函数 | 位置 | 语义 |
|---|---|---|
| `listCategoryNav(db)` | `extCategory.ts:361` | `visible = 1` 的分类 + 已发布 `book_count`（一次查询） |
| `getCategoryBySlugOrId(db, v)` | `extCategory.ts:259` | 先按 id，再回退 slug |
| `listChannelsByGenre(db, genre)` | `extCategory.ts:376` | 该分类下**已发布**的书，返回公开书卡形状 |
| `getBookById(db, id)` | `extCategory.ts:449` | 单本书，**已发布才返回**（`AND status = ?`） |
| `getBookChapters(db, bookId, baseUrl)` | `extCategory.ts:509` | 该书的**已发布**章节，按 `pub_date` → `chapterNo` 排序 |
| `listVolumeBoard(db, bookId)` | `extVolume.ts:98` | 卷分组**规则**（含草稿，仅供借鉴规则） |
| `FeedDb.getItemById(id, statuses)` | `FeedDb.ts:510` | 单条 item，可传 `[PUBLISHED]` |
| `getIdFromSlug(v)` | `shared/StringUtils.ts:309` | 解析 `{slug}-{11 位 id}` 或裸 11 位 id |

## 权限码与鉴权路径现状

### 权限码只剩一族

| 命名空间 | 值 | 出处 | 用在 |
|---|---|---|---|
| **自研 RBAC 码** | `content:book:read` / `content:category:read` / `content:article:read` / `content:volume:read` | **自研** | **后台页面 / ajax guard 与 API 授权共用** |
| OAuth scope | `content:read` / `content:write` | **上游自带** | **仅** legacy bearer 路径（`apiKeyScopes`） |

`api:*` 一族已随 ADR-0009 全部删除（迁移 `0055_drop_api_permission_codes.sql`），
线上 `ext_permissions` 实测 0 条。**新增内容 API 不新建任何权限码。**

### API 鉴权只剩两条路径

`src/middleware.ts` 按请求头短路分派：

| 请求特征 | 路径 | 权限模型 |
|---|---|---|
| `Authorization: Bearer mflc_…` | login-credential（**自研**） | **自研 RBAC 码**（`content:*:*`，方法感知） |
| `Bearer <其他>` / `x-microfeedapi-key` | legacy bearer（**上游**） | **OAuth scope**（`content:read`/`write`） |

### `requiredApiPermission` 的 fallback 是「不要求码」

未匹配到规则的路径返回 **`null` = 不要求任何权限码**。
⇒ **新端点若登记了 `integrationSuffix` 却漏登 `DOMAIN_RULES`，不是"落到某个默认码"，而是
"对任何已认证凭证开放"。** 这是决策 3 两条登记必须**同时**完成的理由。

## 决策

### 1. 端点形状

挂在现有基路径 `/api/v1/` 下：

| 端点 | 说明 |
|---|---|
| `GET /api/v1/content/categories/` | 标签（分类）列表 |
| `GET /api/v1/content/categories/{categoryId}/books/` | 该标签下的书摘要 |
| `GET /api/v1/content/books/{bookId}/chapters/` | 卷 → 章两级目录 |
| `GET /api/v1/content/chapters/{chapterId}/` | 章节详情（含正文，**原样**） |

路径段用 `categories`（实体真名），对外文档注明"标签即分类"；**不引入 `tags` 作为第二个词**。

**路径参数解析**：

- `{categoryId}` → `getCategoryBySlugOrId()`：**先按 id 查，再回退 slug**。
  与公开分类页 `/category/<id>/` **同一套解析**。参考地址
  `https://feed.881019.xyz/category/OteD-aXHV_d/`（用的就是 id）。
- `{bookId}` / `{chapterId}` → `getIdFromSlug()`：解析 `{slug}-{11 位 id}` 并接受裸 11 位 id。

**术语**：路径一律用 **`chapters`**，不沿用既有 API 的 `items`。
权限码已随跟进改动（2026-09-24，迁移 `0057`）**重命名**为 **`content:chapter:*`**：
初始实现沿用既有的 `content:article:*`（seed 里 `article` 即章节），并评估过不重命名
（要动 seed + 迁移 + ajax guard + 菜单绑定 + i18n）；用户最终决定**统一**——
改码不改行为，迁移只做 REPLACE（`ext_permissions.code` + 派生 `id`、
`ext_menu_permissions.permission_code`、`ext_role_permissions.permission_id` 因引用 id 同步）。
⇒ **残留一处命名不一致**：路径/权限码 `chapters` 与上游端点 `items` 指同一实体
（上游的，不动），记录在「影响」末尾。

**章节详情不复用既有端点**：上游 `/api/v1/items/{itemId}/` 有两条硬冲突 ——
① 传 `[PUBLISHED, UNLISTED, UNPUBLISHED]` ⇒ **含草稿**；
② 其 `content_html` 经 `bodyToHtml(description, contentFormat)` **转换过**（markdown 会被渲染），
与决策 7「原样」冲突。
⇒ 接受"**两个章节形状并存**"：上游 JSON Feed 形状 + novel 原样形状。

### 2. 响应形状（**白名单，绝不整对象透传**）

既有函数会带出内部字段（`Category` 的 `parent_id`/`sort`/`visible`/`created_at`；
`getBookChapters` 的 `status`/`date_published`/`_microfeed`（含 `wordCount`/`web_url`）
以及 **`...data` 的全部字段**）。**每个端点显式挑字段**：

| 端点 | 响应形状 |
|---|---|
| 1 | `{ id, name, slug, bookCount }` |
| 2 | 公开书卡形状（**即为契约**）：`{ id, title, image, link, author?, description?, serialStatus?, serialStatusLabel?, wordCount? }`（`description` 已由 `bodyToPlainText` 转纯文本） |
| 3 | `{ book: { id, title }, truncated, volumes: [{ name, chapters: [{ id, title, chapterNo, pubDate? }] }] }` |
| 4 | `{ id, title, chapterNo, volume, contentHtml, contentFormat }` |

- 端点 4：`contentHtml` = `items.data.description` 的**原始值**（见决策 7）；
  `volume` 取 `_microfeed.volume`（未分卷为空串）；`chapterNo` 取 `_microfeed.chapterNo`（缺失为 0）。
- 端点 3：未分卷的桶 `name` 为空串（与 `listVolumeBoard` 一致），恒排最后。

### 3. 必须同时登记两处（缺一不可）

**`integrationSuffix()`**（`src/server/api/access.ts`）—— 硬编码白名单，四条：

```ts
suffix === "content/categories/" ||
/^content\/categories\/[^/]+\/books\/$/u.test(suffix) ||
/^content\/books\/[^/]+\/chapters\/$/u.test(suffix) ||
/^content\/chapters\/[^/]+\/$/u.test(suffix)
```

登记位置：放进 **`!legacy && (...)` 守卫内**（`search` / `pages` / `site-files` 已在其中）。
**拒绝 legacy 分两段**（决策 4）：
1. `integrationSuffix` 的 `!legacy` 守卫 —— 挡掉 **legacy 基路径**（`/api/content/*` → 404）；
2. `src/middleware.ts` 的 legacy 分支里，对 `pathname.startsWith(`${API_BASE_PATH}content/`)`
   直接返回 404 —— 挡掉 **legacy 凭证打在 v1 基路径上**（`/api/v1/content/*`）。

第二段是**必需的**：`integrationSuffix` 只区分基路径，不区分请求头；一把持有 OAuth
`content:read` scope 的 legacy key 打在 `/api/v1/content/*` 上，`decideApiRequest` 会放行。
实测验证（2026-09-24）：`Bearer some-legacy-key` → `/api/v1/content/categories/` 在加第二段前返回 401、
加后返回 404；若该 key 真持有 `content:read` scope，加前会返回 200 —— 所以第二段必须存在。
未登记则 `apiPathDetails()` 返回 `null` ⇒ `decideApiRequest()` 判 `not-found` ⇒ **请求直接 404**。

**`DOMAIN_RULES`**（`src/server/api/api-permissions.ts`）—— 三个前缀：

| 前缀 | 码 |
|---|---|
| `content/categories` | `content:category:read` |
| `content/books` | `content:book:read` |
| `content/chapters` | `content:article:read` |

未登记则 `requiredApiPermission()` 返回 `null` ⇒ **新 API 对任何已认证凭证开放**。

三个前缀互不包含（`suffix.startsWith(prefix)` 首个匹配，无顺序陷阱）。

### 4. 鉴权

走 login-credential 路径（`Bearer mflc_…`）：
`decideLoginCredentialApiRequest` → `requiredApiPermission(pathname, method)` →
`resolveUserPermissions` 校验 → 通过返回数据 / 不通过 403。

**必须拒绝 legacy 路径访问**：legacy bearer 走上游 OAuth scope（只有 `content:read`/`write`，
无资源细分）。若内容 API 允许 legacy 路径，则**任何持有 `content:read` scope 的 key 都能读全部内容**，
细粒度 RBAC 形同虚设。实现方式分两段（见决策 3）：`!legacy` 守卫挡 legacy 基路径，
`middleware.ts` 的 legacy 分支拦 v1 基路径上的 legacy 凭证。
（现状缓解：线上 `api_keys` 0 行，暂无 key 可用；但这是**会变的事实**，不能作为设计依据。）

### 5. 只返回已发布 + 404 语义

一律只返回 `status = 1`（不含草稿、不含已删除），不提供放开开关。**找不到即 404**：

| 端点 | 404 条件 |
|---|---|
| 1 | 无（返回空列表即可） |
| 2 | `getCategoryBySlugOrId` 返回 null，**或** `category.visible = 0` |
| 3 | `getBookById(db, bookId)` 返回 null（不存在**或未发布**） |
| 4 | `getItemById(id, [PUBLISHED])` 返回 null；**或所属书未发布**（`getBookById(chapter._microfeed.bookId)` 返回 null） |

端点 4 校验所属书，是为了避免**下架书的内容仍可单章读到**。

### 6. 复用既有取数函数（**不要另写**）

| 端点 | 取数 |
|---|---|
| 1 | `listCategoryNav(db)` —— 一次查询即得 `visible` 过滤 + 已发布 `book_count`。<br>（`listCategories(db)` 是**后台用**，不过滤 `visible`，不可用于对外 API。） |
| 2 | `getCategoryBySlugOrId(db, {categoryId})` → 取 **`.id`**（`channels.genre` 存的是分类 id）→ `listChannelsByGenre(db, id)` |
| 3 | `getBookById(db, bookId)`（校验已发布 + 拿 `book.title`）+ `getBookChapters(db, bookId, baseUrl)`（已发布章节集合）+ 套用 `listVolumeBoard` 的**分组规则** |
| 4 | `FeedDb.getItemById(id, [STATUSES.PUBLISHED])` → 取 6 个字段；再 `getBookById` 校验所属书 |

**卷分组**：复用 `listVolumeBoard`（`extVolume.ts:98`）的**分组规则**
（桶按 `volume` 名；组序 `volumeOrder` ?? 首章 `chapterNo` → 首章 `pub_date` → id；未分卷桶恒排最后）。
⚠️ 该函数查 `WHERE status != DELETED`（**含草稿**）且在 JS 里过滤 `bookId`，
⇒ 正确组合是 **`getBookChapters` 拿已发布集合 + `listVolumeBoard` 的分组规则**，
**不要直接调 `listVolumeBoard`**，也**不在 API 层另写第三套分组逻辑**。

### 7. 正文原样返回 + 格式标识

`contentHtml` 取 `items.data.description`，**不转 markdown、不重渲染**
（`docs/novel-cms/CONTEXT.md` 约束 4）。

因为"原样"意味着**内容可能是 markdown**，响应同时给 **`contentFormat`**
（取 `data.contentFormat ?? data.content_format`，经 `bodyFormat()` 归一，缺省 `"html"`），
调用方据此决定如何渲染——否则字段名叫 `contentHtml` 却在 markdown 时名不符实。
（实测现状：34 篇全 HTML、格式全未设置 ⇒ 目前 `contentHtml` 与转换后结果相同。）

### 8. 目录上限与截断点

端点 3 一次给全，但设**硬上限 5000 章/书**，响应带 **`truncated: boolean`**。
**截断发生在分组前**：先把 `getBookChapters` 的扁平有序列表截到前 5000 条，再分组。
⇒ 语义可预测（"阅读顺序前 5000 章"），`truncated: true` 同时意味着**末卷可能不完整**。
现状 32 章远低于上限，此限制只为防病态数据把响应撑爆。

### 9. `items` 增加 `book_id` 真实列 + 索引 + 回填（**本次范围内**）

作为 ADR-0004「高频查询字段落成真实列」政策的延伸。理由：JSON 路径条件无法走索引，
落列把扫描换成索引查找。加性列不破坏上游升级兼容性，回填仅数十行（且**可直接用 SQL**）。

**纳入本次而非留待后续**：现在提前做，避免章节量上来后"按书取章节"变成全表扫描而引发事故。
（诚实说明：按当前 32 篇已发布章节，此列**没有可测量的即时收益**。）

## 理由（trade-off）

- **端点粒度**：曾考虑单个宽端点（一次返回整棵 分类→书→章节 树）。否决：正文体积大、
  与目录使用频率不同，混在一起会让目录请求变重。定为"目录与正文分离、目录一次给全"。
- **`categories` vs `tags`**：`tags` 更贴近使用方心智，但它**不是实体**；若 API 另叫 `tags`，
  同一张 `ext_category` 就有两个名字，日后必然漂移。选 `categories` + 文档注明。
- **卷章分组位置**：公开 `/book/` 页**不在服务端分组**（`src/pages/book/[id]/index.astro` 用
  `getBookChapters` 取扁平列表后把 `items` 交给主题）。曾提议前端分组，被否决 ——
  服务端返回两级结构更符合调用方需要，故复用 Admin 的分组规则。
- **`book_id` 列（方案 A）**：
  - 备选 B（按 `bookId` 缓存目录）：零迁移，但冷启动与失效后仍需全表扫描。
  - 备选 C（维持现状）：当前 32 章代价可忽略，但随章节量线性劣化，且劣化是**静默**的。
  - 选 A 因它**不是新政策，而是 ADR-0004 在 `bookId` 上的补漏**（ADR-0004 当初只落了
    `items.review_status` 与 `channels.genre`）。
- **截断在分组前**：分组后截断会得到"完整卷但条数不定"的结果，调用方无法预估响应规模；
  分组前截断语义确定，代价是末卷可能不完整（已由 `truncated` 显式告知）。

## 影响

**必改（缺一即出错）**

- `src/server/api/access.ts` → `integrationSuffix()`：登记决策 3 的四条模式，
  **放进 `!legacy && (...)` 守卫内**（同时实现"拒绝 legacy"），否则 404。
- `src/server/api/api-permissions.ts` → `DOMAIN_RULES`：加决策 3 的三个 `content/*` 前缀规则。
  **漏登即"对任何已认证凭证开放"。**

**新增**

- 四个端点文件（挂在 `src/pages/api/v1/content/...`），各自按决策 2 白名单组响应。
- OpenAPI 登记：改 `src/shared/OpenApiDocument.ts` **必须同步 `src/shared/OpenApiTranslations.ts`**，
  否则 `tests/unit/openapi.test.ts` 红三条（缺条目 / 死条目 / 序列化仍英文）。
  `yarn lint:openapi` 查不出这类缺漏。
- 迁移：`ALTER TABLE items ADD COLUMN book_id TEXT` + `CREATE INDEX items_book_id`；
  回填 `UPDATE items SET book_id = json_extract(data, '$._microfeed.bookId')`。

**同步 / 兼容**

- 写入路径同步：`_microfeed.bookId` → `book_id`（item 创建/更新 handler、导入章节）。
- 查询双读：优先 `WHERE book_id = ?`，缺失时回退 JSON 解析，**保证不丢章节**。
  `getBookChapters` 是首选改造点（它已是公开读路径的唯一入口）。
- 门禁：`yarn typecheck`（含 `astro check`）+ `yarn test`。

**遗留（不阻塞本次）**

- **命名不一致**：权限码已随迁移 `0057` 统一为 `content:chapter:*`，与路径 `chapters` 一致；
  与上游端点 `items` 的差异是**上游的**，不动。
- `getBookChapters` 会为每章算 `wordCount`（`chapterWordCount`），端点 3 的目录不需要这份开销；
  若成为热点再考虑给该函数加"免算字数"的开关。
- 后续可评估是否把 `volume` / `chapter_no` 也落列（ADR-0004 已预留此口子）。
- 顺带（代码改动，不属本 ADR 范围）：`src/server/feed/extCategory.ts:509` 的注释与实测不符，
  应更正为"JSON 路径无法走索引"，并说明 `SQLITE_ERROR 7500` 是 wrangler CLI 的参数绑定限制。
