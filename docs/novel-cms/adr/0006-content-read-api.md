# ADR-0006: 受保护的内容读 API（标签 → 书 → 卷章 → 正文）

- 状态：**Proposed**（含待决项，见文末「待决」）
- 日期：2026-09-24
- 修订：2026-09-24 —— 依据代码实测纠正路径前缀、鉴权模型与复用点（初稿三处重大错误）
- 决策人：用户

## 背景

需要给管理后台「内容」分组（`group_content`）下的模块提供**受保护的读 API**，让外部按
标签 → 书 → 卷章 → 正文 逐级获取内容。公开站已有等价的**页面**实现
（`src/pages/category/[slug]/`、`src/pages/book/[id]/`），但没有对应的内容 API。

关键事实（2026-09-24 远程 D1 + 源码实测）：

- **「标签」不是独立实体，就是 `Category`（`ext_category`）**。实测四条分类：
  `cat_x1`=东方玄幻（slug `eastern-fantasy`）、`OteD-aXHV_d`=本草、`j24vLiF3Sym`=内经类、
  `1runoCsI7dr`=伤寒。东方玄幻旗下 4 本书（星河剑歌 / 夜航风暴 / 天工开物录 / 长街听雪）。
- **书 = `channels` 行；章节 = `items` 行**，靠 `data._microfeed.bookId` 关联 —— **不是外键**。
  **卷不是实体**，只是 `items._microfeed.volume` 字符串标记。
- `channels.genre` 已是真实列且有 `channels_genre` 索引 ⇒ 「按标签取书」**已可走索引**。
- `items` **无 `book_id` 列** ⇒ 「按书取章节」只能全表扫描（D1 拒绝嵌套 `json_extract`，SQLITE_ERROR 7500）。
  **当前全站已发布章节仅 32 篇，扫描代价可忽略。**
- **API 基路径是 `/api/v1/`**（`API_BASE_PATH`），另有 legacy `/api/`（带 deprecation 头）。
- **⚠️ 存在三个形似而完全不同的命名空间**（初稿混淆了它们，导致鉴权设计错误）：

  | 命名空间 | 值 | **出处** | 首次提交 | 用在 | 校验者 |
  |---|---|---|---|---|---|
  | **OAuth scope** | `content:read` / `content:write` | **上游自带** | `e273f6c` 2026-08-07 | legacy bearer 路径 | `apiKeyScopes` |
  | **API 集成权限码** | `api:content:read` / `api:page:read` / `api:media:read` / `api:site:read` | **自研** | `3ac9b4a` 2026-09-23 | login-credential + signed-call 路径 | `requiredApiPermission` + `resolveUserPermissions` |
  | **管理后台 RBAC 码** | `content:book:read` / `content:category:read` / `content:article:read` / `content:volume:read` | **自研** | `3ac9b4a` 2026-09-23 | 后台页面 / ajax guard | 页面 guard |

  ⚠️ 上游自带的**只有 OAuth scope** 那一套；`api:*` 码是自研 RBAC 工作引入的
  （`api-permissions.ts`、`signed-call.ts`、`src/server/rbac/seed.ts`、
  `migrations/0035_ext_api_permissions_seed.sql` 均在自研提交内）。

- **⚠️ 同一端点有三条鉴权路径，按请求头分派**（`src/middleware.ts:181/233/283`）：

  | 请求特征 | 路径 | 权限模型 |
  |---|---|---|
  | `Authorization: Bearer mflc_…` | login-credential | **RBAC 码**（`api:*`） |
  | `X-Access-Key: …` | signed-call | **RBAC 码**（`api:*`） |
  | `Bearer <其他>` / `x-microfeedapi-key` | legacy bearer（上游） | **OAuth scope**（`content:read`/`write`） |

  三者按上表顺序短路匹配；前两条是自研 RBAC 路径，第三条是上游遗留路径
  （注释明写 "left completely untouched"）。

## 决策

1. **端点形状** —— 挂在现有基路径 `/api/v1/` 下（**不是**裸 `/content/`）：
   - `GET /api/v1/content/categories/` — 标签（分类）列表
   - `GET /api/v1/content/categories/{categoryId}/books/` — 该标签下的书摘要
   - `GET /api/v1/content/books/{bookId}/chapters/` — 卷 → 章两级目录
   - `GET /api/v1/content/chapters/{chapterId}/` — 章节详情（含正文原样）—— **待决 E2**

   路径段用 `categories`（实体真名），对外文档注明"标签即分类"；**不引入 `tags` 作为第二个词**。
2. **必须登记路由白名单**：`src/server/api/access.ts` 的 `integrationSuffix()` 是**硬编码白名单**。
   未登记的路径 `apiPathDetails()` 返回 `null` ⇒ `decideApiRequest()` 判 `not-found` ⇒ **请求直接 404**。
   四个新路径**必须**在此函数登记（并决定是否同时支持 legacy `/api/`）。
3. **鉴权**：新端点主要服务 **signed-call 路径**（`X-Access-Key`），即用户描述的
   "凭证 → 取角色权限 → 校验 → 通过返回 / 不通过返回错误码"：
   `decideSignedApiRequest` → `requiredApiPermission(pathname, method)` → `resolveUserPermissions` 校验。
   - **权限码用 `api:*` 命名空间**。`api-permissions.ts` 的 `DOMAIN_RULES` 需加 `content` 前缀规则
     （否则落到默认 `api:content:read`，虽能通过但不可控、无法细粒度）。
   - **粒度待决（E1）**：复用粗粒度 `api:content:read`（零新建）vs 新增细粒度
     `api:content:category:read` 等（需迁移 seed + `seed.ts` + `PERMISSION_CODES` 镜像 + 测试）。
   - ⛔ **纠正初稿**：`content:category:read` 等是**管理后台 RBAC 码**，在 API 集成路径上**不会被查询**，不可用于此。
   - **必须拒绝 legacy 路径访问**：legacy bearer 走的是**上游 OAuth scope**（只有 `content:read`/`write`，
     无资源细分）。若内容 API 允许 legacy 路径，则**任何持有 `content:read` scope 的 key 都能读全部内容**，
     细粒度 RBAC **形同虚设**。故 `/api/v1/content/*` 必须**仅**接受 login-credential 或 signed-call，
     对 legacy bearer 返回 401/404（实现上需在中件里按路径判断）。
4. **只返回已发布（`status = 1`）**：不含草稿、不含已删除，不提供放开开关。
5. **复用既有取数函数**（**不要另写**）：
   - 端点 1 → `listCategoryNav(db)`（`extCategory.ts:361`）：`visible = 1` 过滤 + `book_count`
     （`LEFT JOIN channels ON ch.genre = c.id AND ch.status = ?`），一次查询即得。
     （`listCategories(db)` 是**后台用**，**不过滤 visible**，不可直接用于对外 API。）
   - 端点 2 → `listChannelsByGenre(db, genre)`（`extCategory.ts:376`）：`WHERE genre = ? AND status = ?`
     走 `channels_genre` 索引，直接返回 `ChannelBookSummary[]`。
   - 端点 3 → 复用 `listVolumeBoard(db, bookId)`（`extVolume.ts`）的**分组规则**
     （`volumeOrder` → 最小 `chapterNo` → 首章 `pub_date` → id，未分卷桶恒排最后），
     但该函数现含草稿，**需新增"仅已发布"过滤**。**不在 API 层另写一套分组逻辑。**
   - 端点 4 → 见待决 E2。
6. **正文原样返回**：取 `items.data.description`，不转 markdown、不重渲染。
   （`content_html` 仅为对外渲染别名，见 `docs/novel-cms/CONTEXT.md` 约束 4。）
7. **`items` 增加 `book_id` 真实列 + 索引 + 回填**，作为 ADR-0004「高频查询字段落成真实列」政策的延伸。

## 待决（需用户拍板）

- **E1 鉴权粒度**：复用粗粒度 `api:content:read`（零新建、与现有 items/channels 一致）vs
  新增细粒度 `api:content:category:read` / `api:content:book:read` / `api:content:chapter:read`
  （需迁移 0035 式 seed + `seed.ts` + `PERMISSION_CODES` 镜像 + `admin-endpoint-guards.test.ts`）。
- **E2 章节详情端点是否与既有 `/api/v1/items/{itemId}/` 重复**：后者**已存在且已返回 `content_html`**
  （`jsonFeedResponse`，JSON Feed 形状），差异在于它①含 `UNLISTED`/`UNPUBLISHED`（草稿）
  ②无 `volume`/`chapterNo` 小说元信息。三选一：
  (a) 直接复用该端点，只新增其余三个导航端点；(b) 新建 novel 专用 `/content/chapters/{id}/`（两形状并存）；
  (c) 扩展既有端点加 novel 字段。
- **E3 术语**：路径用 `chapters` 还是沿用既有 API 的 `items`？同一实体两个名字会漂移
  （这正是本 ADR 否决 `tags` 的理由，须一致适用）。
- **E4 目录上限**：端点 3"一次给全"是否设硬上限（如单书 5000 章）+ `truncated` 标志？

## 理由（trade-off）

- **端点粒度**：曾考虑单个宽端点（一次返回整棵 分类→书→章节 树）。否决：正文体积大、
  与目录使用频率不同，混在一起会让目录请求变重。定为"目录与正文分离、目录一次给全"。
- **`categories` vs `tags`**：`tags` 更贴近使用方心智，但它**不是实体**；若 API 另叫 `tags`，
  同一张 `ext_category` 就有两个名字，日后必然漂移。选 `categories` + 文档注明。
- **卷章分组位置**：公开 `/book/` 页其实**不在服务端分组**（传扁平 `items` 给主题）。
  曾提议前端分组，被否决 —— 服务端返回两级结构更符合调用方需要，故复用 Admin 的 `listVolumeBoard`。
- **`book_id` 列（方案 A）**：
  - 备选 B（按 `bookId` 缓存目录）：零迁移，但冷启动与失效后仍需全表扫描。
  - 备选 C（维持现状）：当前 32 章代价可忽略，但随规模线性劣化。
  - 选 A 因它**不是新政策，而是 ADR-0004 在 `bookId` 上的补漏**（ADR-0004 当初只落了
    `items.review_status` 与 `channels.genre`）。加性列不破坏上游升级兼容性，回填仅数十行。
  - ⚠️ **诚实说明**：按现阶段 32 篇已发布章节，此项**没有可测量的即时收益**，是面向规模的提前准备。

## 影响

- **必改** `src/server/api/access.ts` → `integrationSuffix()`：登记四个新路径，否则 404。
- **必改** `src/server/api/api-permissions.ts` → `DOMAIN_RULES`：加 `content` 前缀（或按 E1 细粒度）。
- **OpenAPI 登记**：改 `src/shared/OpenApiDocument.ts` **必须同步 `src/shared/OpenApiTranslations.ts`**，
  否则 `tests/unit/openapi.test.ts` 红三条（缺条目 / 死条目 / 序列化仍英文）。`yarn lint:openapi` 查不出这类缺漏。
- **新增迁移**：`ALTER TABLE items ADD COLUMN book_id TEXT` + `CREATE INDEX items_book_id`；
  回填需在**应用层**执行（D1 拒绝嵌套 `json_extract`）。⚠️ 该限制目前**源自代码注释，尚未实测**，
  实施前应先验证。
- **写入路径同步**：`_microfeed.bookId` → `book_id`（item 创建/更新 handler、导入章节）。
- **查询双读**：优先 `WHERE book_id = ?`，缺失时回退 JSON 解析，**保证不丢章节**。
- `listVolumeBoard` 需增加「仅已发布」过滤参数，让 API 与 Admin 卷面板共用同一套分组逻辑。
- 若 E1 选细粒度：需同步 `PERMISSION_CODES`（`Constants.ts`）与 `src/server/rbac/seed.ts`，
  二者由 `tests/unit/admin-endpoint-guards.test.ts` 强制相等。
- 后续可评估是否把 `volume` / `chapter_no` 也落列（ADR-0004 已预留此口子）。
