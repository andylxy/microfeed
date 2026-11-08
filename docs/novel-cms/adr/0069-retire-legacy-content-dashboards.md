# ADR-0069: 退役 6 个 legacy 内容看板，保留共享数据层与 9 枚复用权限码

删除 `/admin/term/`、`/admin/books/`、`/admin/volumes/`、`/admin/categories/`、`/admin/fangs/`、`/admin/yao/` 的页面、ajax、组件与 handler；这 6 个模块没有专属数据库表，本决策**不删任何表**，`items` 9,506 行、`channels` 13 行与 5 张字典表全部保留；16 枚相关权限码删 7 枚、留 9 枚并重建 9 条 code 叶；App 8 个内容端点与前台独立内容引擎不变。删 6 看板后旧表 `items` / `channels` / `ext_category` 失去 TCM 结构化写方，App 8 端点读到的旧表数据成为冻结快照——7 项后果与维护责任见「旧表不再维护的后果与维护责任」。

- 状态：Accepted（2026-11-08 决策定稿；2026-11-08 实施主体完成：0191 迁移、39 行备份、9 条 code 叶重建、i18n 迁移（184 键/语言实删、12 键迁 shared）、测试适配（rbac / permission-tree-endpoints / rbac-tree-equivalence / admin-menu）；**另修正 0154 挂靠缺陷**（新增 0192 把 mail-settings 两码叶移到 page_login_methods，ADR-0038 结构规则）；code-review 修复（0192 命名改 data 类、4 处英文注释改中文、source-architecture 看板测试改写、seed 标记区注释移出、RbacPermissionDocs 补 book-chapter 文档与 category:read gate 修正）；部署与门禁由用户另行触发）
- 关联：ADR-0025 / 0027 / 0036（卷看板）、ADR-0041 / 0042（权限节点与侧栏）、ADR-0053（权限快照）、ADR-0057（页面守卫）、ADR-0064 / 0065 / 0066（独立模块与前台引擎）、ADR-0068（同类退役先例）
- 证据范围：本地真库只读探针 2026-11-08，实例 `ctwh-881019-xyz`（`items=9506`、`d1_migrations=188`、`MAX(name)=0190_data_retire_alias_module.sql`、`ext_permissions=69`、`ext_permission_nodes=113`、`ext_role_permissions=59`、`ext_user_permissions` 9 行 / 151 个码 token）；工作树 HEAD `273d40f`；第二轮 4 路只读代码调查（2026-11-08 15:12）
- **结论：有条件可以**。5 个条件见「实施前置条件」。远程生产库行数与 App 客户端缓存策略是本仓库取不到的量，见「仓库内无数据」。

## 背景与题面冲突

这 6 个页面是旧 `items` / `channels` 派生看板：数据按 `tcm_kind` 存在 `items`（section 8,066 / fang 804 / chapter 447 / yao 172 / term 17），书存在 `channels`（13 行），分类与书籍状态放在共享字典表。前台站点自 [ADR-0066](docs/novel-cms/adr/0066-front-site-standalone-module-engine.md) 起改读独立模块表。

用户原始诉求是「数据库表到 UI 全部删除」。核实出三处与题面的冲突，按 Q1 与 Q4=A 收窄：

1. **6 个模块没有专属表**。可删的是页面与代码，不是表；删 `items` / `channels` 会丢 9,506 行内容并断 App 8 个端点。
2. **共享数据层不能整组删**。6 个 feed 数据层文件（`extBook` / `extCategory` / `extVolume` / `extFang` / `extTcmEntries` / `extBookStatus.ts`）与 5 张字典表（`ext_category` 3 行 / `ext_book_stats` 13 行 / `ext_book_status` 4 行 / `ext_marker_citations` / `ext_marker_citation_state`）被 17 项依赖（10 端点 + 7 模块/页面，第二轮代码调查口径）：App 的 `GetNav`、4 个 `/api/v1/content/*` 端点、`/api/v1/feed/`、`/api/feed/`、后台 book-statuses 与 fang-references 等。
3. **16 枚权限码中有 9 枚被独立模块复用**，整组删会打断 `book_info` / `ming_ci` / `zhong_yao` 三个模块与内容读取 API。

**App 端点口径（2026-11-08 用户裁定「按代码现状」）**：用户第二轮答复称 App 8 端点的数据获取已更换为新模块、只保留接口名称和签名。只读核实与该陈述不一致：`src/pages/api/AppBookRequest/` 下 8 个内容端点 **8/8** 全部 `import … from "@/server/tcm/reads"`（`GetNav.ts:8`、`GetBookChapter.ts:10`、`GetChapterContent.ts:10`、`GetBookIdFang.ts:10`、`GetAllZhongYao.ts:5`、`GetAliaZhongYao.ts:5`、`GetAllMingCi.ts:6`、`GetTipsStyleConfig.ts:5`）；`src/server/tcm/reads.ts` 929 行的 9 条 SQL 读 `items` / `channels` / `ext_category`（`:382 FROM ext_category c JOIN channels`）/ `ext_annotation_markers`（`:914`）；`git status --short` 与 `git diff HEAD --stat` 对这三个路径均无输出，不存在未提交的替换。已切独立模块的是 `src/server/catalog/`（24 处 `FROM book_info / book_chapter / book_chapter_body / fang_yao / fang_yao_body / zhong_yao / ming_ci`），对应 `CONTEXT.md:239-241`「独立内容引擎」与 `:247-249`「零耦合不变式」（判据只管前台对外输出，不含 App 端点）。

因此本决策按代码现状定稿：App 8 端点属于「仍需保留的依赖」，不是「已解耦」；把端点改接独立模块不在本决策范围。这处口径不改变删除边界——Q1 与 Q4=A 在两种口径下都要求保留 `items` / `channels` / `ext_category` / 6 个 feed 数据层文件。

## 逐项核实结果

| # | 核实面 | 结论与数字 |
|---|---|---|
| 1 | 专属数据库表 | 0 张；数据在共享 `items` 9,506 行 / `channels` 13 行 |
| 2 | `tcm_kind` 分布 | section 8,066 / fang 804 / chapter 447 / yao 172 / term 17 |
| 3 | 共享字典表 | 5 张：`ext_category` 3 / `ext_book_stats` 13 / `ext_book_status` 4 / `ext_marker_citations` / `ext_marker_citation_state` |
| 4 | 代码面 | 33 个独占文件 + 17 个共用文件 = 50 个唯一物理文件 |
| 5 | App 8 端点 | 8/8 import `@/server/tcm/reads`，读旧表；前台 `catalog/` 才读独立表（24 处） |
| 6 | 共享数据层被引用 | 17 项（10 端点 + 7 模块/页面，第二轮代码调查口径） |
| 7 | 权限码 | 16 枚相关：`content:book` 4 / `content:category` 5 / `content:volume` 2 / `content:fang` 1 / `content:term` 2 / `content:yao` 2 |
| 8 | 权限节点 | 6 个 legacy page 行（sort 101 / 103 / 104 / 108 / 110 / 111）+ 16 个 code 叶 |
| 9 | 权限快照 | 9 行 / 151 个码 token → 137 个 |
| 10 | 文案 | 218 键/语言、436 定义；可删 206 键/语言（412 定义），须迁移 12 键/语言（24 定义） |
| 11 | 测试 | 直接引用 17 文件 144 处（并集约 35 文件）；整文件删 4 个 `volumes-*.test.ts`、行级改 13 个 |
| 12 | 快照分类 | `durable` 登记 `channels` / `items` / `ext_category` / `ext_book_status`，`ephemeral` 登记 `ext_book_stats` / `ext_marker_citations` / `ext_marker_citation_state`；本决策不删表，无需改动 |
| 13 | 编号边界 | `migrations/` 最大 0190、台账 188 条 → 新迁移 **0191**；ADR 最大 0068 → **0069**；`scripts/frozen-migration-names.txt` 103 行止于 0107，不追加 |
| 14 | 历史文档 | 7 份历史 ADR 共 14 处（0006 / 0016 / 0024 / 0025 / 0027 / 0036 / 0049）原文不改；3 份活文档列为实施期同步 |

## 决策

1. **删除边界（Q1）**：整文件删 6 个 `src/pages/[adminPath]/{term,books,volumes,categories,fangs,yao}/index.astro`、19 个 ajax 文件（`term` 3 / `yao` 3 / `volumes` 6 / `books` 3 / `categories` 3 / `fangs` 1）、5 个物理组件目录（`books` / `volumes` / `categories` / `fangs` / `tcm-entry`，其中 `term` 与 `yao` 共用 `tcm-entry/TcmEntryBoardApp.tsx`）、4 个 handler（`book-handlers` / `category-handlers` / `volume-handlers` / `tcm-entry-handlers.ts`）。`items` / `channels` / 5 张字典表 / App 8 端点 / 9 枚复用码全部保留。
2. **共享数据层（Q4=A）**：6 个 feed 数据层文件与 5 张字典表保留，只清理其中零引用的函数。行级改 `src/shared/` 8 个文件（`Constants` 6 行、`StringUtils` 约 17 个 URL 构造器、`AdminPageGuards` 6 行、`RbacPermissionDocs` 18 块、`AdminReturnTarget` 约 24 行、`ExtVolume` / `ExtBook` / `ExtCategory` 局部）。`SNAPSHOT_TABLES` 不改：本决策不删表，`assertClassifiedTables`（`snapshot.ts:762-783`）与 `rowCounts`（`:499-505`）的键比对不涉及变更；若将来另案删表，旧表名仍须留在分类清单（先例见 ADR-0068）。
3. **权限码与节点（Q5=A）**：删 7 枚不复用码（`content:category:{create,update,delete,order}`、`content:volume:{read,update}`、`content:fang:read`）、6 个 legacy page 行与 16 个 code 叶；保留 9 枚复用码（`content:book:{read,create,update,delete}`、`content:category:read`、`content:term:{read,manage}`、`content:yao:{read,manage}`），并为它们重建 9 条 code 叶：`page_book_info`(111) 挂 4 条 book 码、`page_ming_ci`(112) 挂 2 条 term 码、`page_zhong_yao`(113) 挂 2 条 yao 码；`content:category:read` 新建隐藏页 `page_content_api` 并挂其下。隐藏页不进侧栏，只承接权限树归属。
4. **文案（Q6=A）**：删 206 键/语言（412 定义）；把 12 键/语言（24 定义）迁到已存在的共用命名空间 `shared`（`zh-CN.ts:683`），再改 14 行引用。`categories` 侧 7 键、`volumes` 侧 5 键；已确证 `volumes` 侧 4 键为 `paginationAria` / `previous` / `pageIndicator` / `next`（`src/components/admin/shared/AdminPagination.tsx:60,71,74,83`）。`errors.general.adminContextUninitialized`（`zh-CN.ts:3260`）在 `general` 子命名空间，不在待删 12 个 legacy errors 键内（`category` 3 / `volumes` 3 / `fang` 2 / `books` 4）。改 i18n 后须跑 `yarn i18n:check`，执行时机由用户手动触发门禁。
5. **迁移与回滚（Q7=A）**：新迁移 `0191_data_retire_legacy_content_dashboards.sql`（`data` 类，按 `docs/agents/arch-gates.md:28-29` 必须带 `-- rollback:` 块）。删前把权限侧的行导出到 `.scratch/backups/legacy-dashboards-rbac.json`；代码与迁移同一次 `manage deploy` 上线，先单独 apply 会让线上旧代码引用已删的页面守卫项与权限码。
6. **文档与术语（Q2=A / Q3=A / Q8=A）**：本 ADR 记决策沿革；`CONTEXT.md` 只处理 9 个相关词条（1 删 / 8 收紧），其余约 20 处含实现细节的词条不动；7 份历史 ADR 原文不追溯改写；3 份活文档（`docs/front-site-catalog-switch.md`、`docs/agents/domain.md`、`docs/zh/admin-group-tree.md`）列为实施期同步。

## 数据完整性核准

全部数字为 2026-11-08 本地真库只读探针结果，取数命令见「核准命令」。

| # | 方向 | 当前值 | 删除后值 | 异常条件 | 处置 |
|---|---|---|---|---|---|
| 1 | `items` / `channels` 行 | 9,506 / 13 | 不变 | 删表或删行会断 App 8 端点与 4 个内容读取端点 | 不删表、不删行 |
| 2 | 5 张字典表 | 3 / 13 / 4 行 + 2 张引用表 | 不变 | 删 `ext_category` 会断 `GetNav` 与 `/api/v1/content/*` | 全部保留 |
| 3 | 权限码 | `ext_permissions` 69 行，含 7 枚不复用码 | 62 行 | 保留 7 枚会在后台出现无页面可指的孤儿码 | 0191 内按码名精确删 7 行 |
| 4 | 角色授权 | `ext_role_permissions` 59 行，16 枚相关码共 29 行 | 49 行（删 10 行、留 19 行） | 漏删会在授权表里留指向已删码的行 | 0191 内按 `permission_id` 删 10 行 |
| 5 | 权限快照 | 9 行 / 151 个码 token | 9 行 / 137 个 | 不重算则 7 行留幽灵码，与 ADR-0053 唯一物化镜像不变量冲突 | 0191 内全量重算；本地只读模拟 `onlyInRebuilt=0`、`memberDiff=0`、除被删码外 `codeDiff` 零变化，逐行 token 21,1,1,22,22,21,21,21,21 → 19,1,1,20,20,19,19,19,19 |
| 6 | 权限节点 | 113 行 = 6 legacy page + 16 个相关 code 叶 + 其余 | 101 行（推算：113 − 22 + 10） | 只删不建会让 9 枚复用码在权限树里无可授节点 | 0191 内按「先删 22 行、再建 10 行」执行；101 为按 Q5=A 操作推算，实施期须以真库 `SELECT COUNT(*)` 复核 |
| 7 | 节点排序 | `page_term` 与 `page_book_info` 同为 sort 111；`page_media` 与 `page_ming_ci` 同为 sort 112 | 111 处重复减 1，112 处仍重复 | 断号不新引入异常 | `menu.ts:46`、`rbac-handlers.ts:137`、`permission-tree-handlers.ts:39` 用 `ORDER BY sort, code`，不改其余行相对顺序 |
| 8 | 侧栏 | 「内容」分组 6 个可见 legacy page 行 | 少 6 项；`page_content_api` 隐藏不进侧栏 | 隐藏页误设 `visible` 会多出 1 项无页面可指的入口 | 新建行 `visible=0`、`path` 留空，`entry_code` 留空（触发器只拦「入口门码非空且路径空」） |
| 9 | 文案定义 | 436 个（218 键/语言） | 24 个（12 键/语言） | 先删后迁会让 14 行引用失去定义 | 先在 `shared` 建 24 个定义、改 14 行引用，再删 412 个定义 |
| 10 | App 缓存桶 | `nav` / `chapters` / `content` / `fang` / `zhongyao` / `yao-aliases` / `style-config` / `terms` 对应的 24h 桶 | 全部不变 | 端点未改，桶内内容无需失效 | 不触发清桶 |
| 11 | 迁移台账 | 188 条，`MAX=0190` | 189 条，0191 | 0191 是 `data` 类，缺 `-- rollback:` 块会被 `scripts/check-migrations.ts` 规则④拒绝 | 按 `docs/agents/arch-gates.md` 写回滚块；历史迁移与冻结清单不动 |
| 12 | 快照分类 | `durable` / `ephemeral` 已登记全部相关表 | 不变 | 本决策不删表 | 不改 `SNAPSHOT_TABLES` |

### 备份范围更正（Q7=A 的 33 行 → 39 行）

Q7=A 方案阶段记为「导出 33 行节点 / 码 / 授权」。本轮真库逐表复核为 **39 行**，33 行作废：

| 来源 | 行数 | 取数 |
|---|---|---|
| 6 个 legacy page 节点 | 6 | `page_books` / `page_volumes` / `page_categories` / `page_fangs` / `page_yao` / `page_term` |
| 16 个相关 code 叶 | 16 | `code LIKE 'content:book:%' OR … OR 'content:yao:%'` |
| 7 枚不复用权限码 | 7 | `ext_permissions.code` |
| 7 枚码对应的角色授权 | 10 | `category:create/delete/order/update` 各 1 行、`volume:read` 3 行、`volume:update` 1 行、`fang:read` 2 行 |
| **合计** | **39** | 6 + 16 + 7 + 10 |

### 0191 迁移内容（方案骨架，不是迁移文件）

```sql
-- rollback: 由 .scratch/backups/legacy-dashboards-rbac.json 的 39 行备份重建
--           6 个 page 节点、16 个 code 叶、7 枚权限码、10 行角色授权；
--           撤销 9 条重建叶与隐藏页 page_content_api；最后按
--           src/server/rbac/snapshot.ts 的 AGGREGATE_SELECT 全量重算
--           ext_user_permissions（9 行 / 151 个码 token）。
-- 顺序：先删 22 行节点 → 删 10 行授权 → 删 7 枚码 → 建 9 叶 + 1 隐藏页
--       → 全量重算 ext_user_permissions。
```

快照重算必须排在删码之后：`AGGREGATE_SELECT`（`src/server/rbac/snapshot.ts:122-133`）读 `ext_permissions`，顺序决定聚合看到新值还是旧值。`INSERT ... SELECT` 按位置匹配 5 列，与 `refreshUserSnapshotStatements` 同形。完整 SQL 在实施期按真库取数写出，本轮不建 `migrations/` 文件。

### 旧表不再维护的后果与维护责任（2026-11-08 code-review 补充）

本决策删 6 个看板的 handler 与 ajax，正是旧表 `items` / `channels` / `ext_category` 的**专门写入口**。删除后这些表不再有活跃的 TCM 结构化写方，App 8 端点（仍读 `src/server/tcm/reads.ts`）读到的是**冻结快照**。逐方向核准（只读调查 2026-11-08，HEAD `273d40f`）：

| # | 方向 | 量化 | 触发条件 | 处置 |
|---|---|---|---|---|
| 1 | `ext_category` 冻结 | GetNav 读 id/name/sort；`category-handlers` 删后**零写方** | 静态（已冻结） | 分类名/排序/可见性永久固定 |
| 2 | 书行 `channels.status` 冻结 | tier 门读 `status IN (1,10)`；`extBook` 四写函数（`extBook.ts:260,312,379,419`）删后**零写方**；`channels` 13 行 − 站点主频道 | 静态 | 会员书（status=10）永久保持，无法上/下架/转会员；主频道行数实施期 `SELECT` 复核 |
| 3 | 章/条文结构冻结 | `getAppBookChapters`/`getAppChapterContent` 读 `tcm_kind`/`tcm_parent_id`/`receiptNo`；卷板删后无 dashboard 改结构 | 静态 | chapter 447 / section 8,066 行只读 |
| 4 | yao/term/fang 仅脚本可改 | `tcm-entry-handlers` 删后无后台；仅 `import-yao.mjs`/`import-term.mjs`/`sync-yao-from-golden.mts` 可重跑 | 内容需更新时 | 人工跑脚本（`--apply`/INSERT OR REPLACE） |
| 5 | `purgeAppNavCache`/`purgeAppBookCache` 零调用方 | GetNav+GetBookChapter 的 24h 桶失去显式失效通道 | 任何外部写 `channels`/`ext_category`（当前无写方，潜伏） | 外部写后 App 目录最长陈旧 24h；其余桶经 `FeedCrudManager`/`annotation-marker-handlers` 存活 |
| 6 | 旧表↔独立表双源漂移 | 无 `items`→独立表迁移、无双向同步；fang 804、yao 172 各存一份 | 独立模块编辑生效时 | App 读冻结旧表、前台读活跃独立表，随编辑漂移 |
| 7 | 会员书误设连带 | `status=10` 固定后，历史误设（应为 1 却为 10）无后台可修正 | 历史数据（实施期 `SELECT` 核对 status 分布） | 只能跑 SQL |

**存活写方**：`ajax/feed.ts`→`FeedDb.putContent`（`FeedDb.ts:732,684`）写 `items`/`channels` 且保留 `_microfeed` 口袋，但不写 `ext_category`、不设 `tcm_kind`（通用编辑器路径）；`annotation-marker-handlers.ts:212,273,306`（未删）是 `ext_annotation_markers` 唯一活跃写方+清桶；`import-ctwh/main.ts:71,89`、`import-yao.mjs:148`、`import-term.mjs`、`sync-yao-from-golden.mts:73` 可重跑。

**维护责任（2026-11-08 用户裁决选路①）**：**接受冻结快照**。删 6 看板后旧表无专门写方，风险 1–4 就位，后续更新靠导入脚本（`import-yao.mjs`/`import-term.mjs`/`sync-yao-from-golden.mts`）手动执行；不保留最小写入口。同次裁决另定：App 8 端点走「**新建端点读独立模块表（`book_info` 等），与旧表完全解耦**」，旧链路（`tcm/reads.ts` 与 `withEmpty`）随新端点上线退役，见「范围之外」。

**App 8 端点改读独立模块表（2026-11-08 用户裁决方向，可行性量化）**：用户裁定 App 8 端点走「新建端点读独立模块表（`book_info` 等），与旧完全解耦」，旧链路（`tcm/reads.ts` 与 `withEmpty`）随新端点上线退役。本轮对该方向逐端点核准；Android 客户端源码 `D:/git/app/AndroidProject-old`（用户本机，本仓库外）只读复核。

**App wire 事实**：8 端点全部经 `RequestServer`（`/api/AppBookRequest/`）+ `IRequestApi` 子类调用（hjq http 反射绑定）。关键点：`GetChapterContent`（App 侧 `ChapterContentApi`）只发 `signatureId`+`bookId`+`contentId`(int，=chapterSection)，服务端 `GetChapterContent.ts:24` 只读 `chapterId??signatureId`——**`contentId` 完全忽略**；`GetBookChapter`/`GetBookIdFang` 只发 `bookId`(String)；其余 5 端点无参。**App 对 id 透传不解析**：GetNav 返 `bookNo`→存 `TabNavBody`；GetBookChapter 返 `signatureId`→存 `Chapter.signatureId`；GetChapterContent 原样回传。id 只当不透明字符串。

| 端点 | 独立表映射 | 可行性 | 阻塞点 |
|---|---|---|---|
| GetAllZhongYao | `zhong_yao` 172 行（text/list） | 可直接映射 | 无 |
| GetAliaZhongYao | `yao_alia` 47 行 | 可直接映射 | 无 |
| GetAllMingCi | `ming_ci` 17 行 + `ming_ci_list` | 可直接映射 | 与旧 429 名单对齐核对 |
| GetChapterContent | `book_chapter` + `book_chapter_body` | 可直接映射 | 派生 `signature`=MD5(text)（表无列、源 Signature 非唯一 8037/8066 且 admin 不编辑）；`sectionvideo` 无源（仅 ext1 5 行） |
| GetBookChapter | `book_chapter`（`source_book_id`→`book_info.id`） | 有条件 | GetNav 须返 `book_info.id` 作 bookNo |
| GetBookIdFang | `fang_yao` | 有条件 | 联结键是 `source_book_legacy_id`（源 BookId 10001 等），**非** `book_info.id`；需 `book_info.book_no`↔`source_book_legacy_id` 桥 + GetNav 返回 id 统一 |
| GetNav | 无等价物 | **不可行** | `book_info` 无分类字段，App 按 `TabNav.caseId` 分组；分类维度缺失 |
| GetTipsStyleConfig | 无等价物 | **不可行** | `ext_annotation_markers` 无独立表副本 |

**横切缺口**：① 会员档——独立表无 `status IN (1,10)`（`book_info` 仅 `is_enable`+`hot_book`），ADR-0044 两层门（访问门 by 书状态 + 内容门 by 会员档）无等价物，强切丢会员书门控，须先给 `book_info` 补会员档列（触及 ADR-0058/0066 边界）；② 24h 桶键——现有 `chapterContentKeySuffix(chapterId,tier)` 分桶，新端点改用独立表 id（同为 11 位，键空间不冲突）；③ App 本地一次重拉——`ChapterContentManager.initContentCache`/`readyChapters` 按 `signatureId` 判重，换新 id 后旧行成孤儿、`getIsDownload` 判重失效，**每个已下载章节重拉一次**（非功能破坏，旧 GreenDAO 行不删不迁）；④ wire 字段名——App 读 `text`/`note`/`fangList`/`sectionvideo`/`signature`/`signatureId`/`header`/`section`，独立表列为 `section_text`/`section_note`/`fang_ji`/`bencao_*`，新端点须 wire 适配层（字段映射 + md5 派生 + `fang_ji`→`fangList` 展开）。

**结论**：方向成立但**非 8 端点全可一刀切**——4 内容端点可直接映射，GetBookChapter/GetBookIdFang 有条件（书 id 桥），GetNav/GetTipsStyleConfig 缺等价物；若强切须先给 `book_info` 补分类+会员档两列（schema 变更，超出本决策边界）。旧链路退役与新建端点上线**绑定**：先建新端点→验证 wire→再退役旧链路，避免 App 读到半套新旧混合。因 GetTipsStyleConfig 无独立表等价物，`getAppStyleConfig` 可能仍需读 `ext_annotation_markers`（旧表），**「旧链路整体退役」不成立**，至少此函数存活。

**withEmpty 退役（裁决②）**：`withEmpty`（`reads.ts:297-304`）现仅 `getAppAllTerms`（`:875`，GetAllMingCi）在用，语义=「读不到确定有码的任何情况都 fail-closed 返空数组」，受「始终 200+数组」信封约束（`GetAllMingCi.ts:20`，约定优先级覆盖 fast-fail，与 `AGENTS.md:100` 实际不冲突）。用户 2026-11-08 裁决 `withEmpty` 随旧链路退役，不需另做保留；若 `getAppAllTerms` 因旧链路未整体退役而存活，则改走 `withRethrow`（与其余 7 个进桶函数一致），失败抛 500 而非静默空数组——与「始终 200+数组」约定冲突，须同步核对 GetAllMingCi 是否接受 500（现状 `max-age=300` 从未生效，`app-cache.ts:7-8` 强制 `private, no-store`）。

**方案 X + `getAppStyleConfig` 抽取（范围之外，待用户另行下令）**：code-review 指出 `src/server/tcm/reads.ts`（928 行）宜归位 `src/server/app/book/reads.ts`（`check-server-layout.ts:34` 白名单已含 `app`，`app/book/` 为子目录无需改），并把 `getAppStyleConfig`（`:903-928`）+ `AppStyleItem`（`:121`）抽到 `src/server/tcm/marker-styles.ts`，消除 `catalog/chapters.ts:15` 与 `markerPopover.ts:18` 两处反向依赖（ADR-0066:117 二者均在零耦合作用域内）。共 **25 文件**（13 import + 12 注释），零行为变化、零 wire 对齐、零缓存/权限/迁移影响。若用户最终选「新建端点读独立表」，则 `reads.ts` 的移动对象随旧链路退役而变化，本方案或不再需要，见上。

## 仓库内无数据

- **远程生产库**：按 2026-10-12 约定，D1 结论以本地快照实测为准、不主动连远程。若目标实例为远程，实施前先 `unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY` 再用「核准命令」的 6 段 `SELECT` 取数；`ext_permissions ≠ 69`、`ext_permission_nodes ≠ 113`、`ext_role_permissions ≠ 59` 或快照 token ≠ 151 时，本决策的影响行数不成立，**不可以**直接套用 0191，须重新评估。
- **App 客户端缓存**：Android App 源码不在本仓库，无线上与本地缓存条数、TTL 的数据。本决策不改端点与响应形状，故不产生客户端陈旧窗口；该结论只在端点不改的前提下成立。

## 实施前置条件

1. 0191 内含 `ext_user_permissions` 全量重算，把 9 行 / 151 码改为 9 行 / 137 码，消除幽灵码。
2. 0191 内按 Q5=A 重建 9 条 code 叶与隐藏页 `page_content_api`；只删不建会让 9 枚复用码在权限树里消失。
3. 12 个共用文案键先迁到 `shared` 并改完 14 行引用，再删 206 键/语言；改后由用户手动触发门禁时跑 `yarn i18n:check`。
4. 代码与迁移同一次 `manage deploy` 上线；部署前确认 `.scratch/backups/legacy-dashboards-rbac.json` 的 39 行备份可读。
5. 若目标实例为远程，先按「仓库内无数据」取数复核 6 个基线数字，不等则暂停实施。

## 核准命令

```bash
PERSIST="$(pwd)/.microfeed/instances/ctwh-881019-xyz/local-state"
CFG="$(pwd)/.microfeed/instances/ctwh-881019-xyz/wrangler.jsonc"
npx wrangler d1 execute FEED_DB --local --persist-to "$PERSIST" --config "$CFG" --json \
  --command "SELECT COUNT(*) FROM ext_permissions; SELECT COUNT(*) FROM ext_permission_nodes; SELECT COUNT(*) FROM ext_role_permissions; SELECT COUNT(*), SUM(json_array_length(codes)) FROM ext_user_permissions; SELECT COUNT(*) FROM ext_permission_nodes WHERE code LIKE 'content:book:%' OR code LIKE 'content:category:%' OR code LIKE 'content:volume:%' OR code LIKE 'content:fang:%' OR code LIKE 'content:term:%' OR code LIKE 'content:yao:%'; SELECT COUNT(*) FROM ext_permission_nodes WHERE code IN ('page_books','page_volumes','page_categories','page_fangs','page_yao','page_term')"

# 6 个基线期望值：69 / 113 / 59 / 9,151 / 16 / 6
# 17 项依赖与 12 个共用文案键的完整清单（实施期逐项取数）
git grep -n "extCategory\|extBook\|extVolume\|extFang\|extTcmEntries\|extBookStatus" -- src/ ':!src/pages/[adminPath]/ajax'
git grep -n 't("\(categories\|volumes\)\.' -- src/components/admin ':!src/components/admin/categories' ':!src/components/admin/volumes'
```

## 考虑过的选项

- **按字面「数据库表到 UI 全部删」**：不选。6 个模块没有专属表；删 `items` / `channels` 会丢 9,506 行并断 17 项存活依赖，其中 App 8 端点 8/8 仍读 `tcm/reads.ts`。
- **连 16 枚权限码一起删**：不选。9 枚被 `book_info` / `ming_ci` / `zhong_yao` 三个独立模块与 `api-permissions.ts:50,55` 的内容读取 API 复用。
- **把 App 8 端点改接独立模块**：**已选（方向）**，用户 2026-11-08 裁定「新建端点读独立模块表（`book_info` 等），与旧完全解耦」。本 ADR 对该方向完成逐端点量化核准（见「App 8 端点改读独立模块表」）：4 内容端点可直接映射、GetBookChapter/GetBookIdFang 有条件、GetNav/GetTipsStyleConfig 缺等价物；8 份 wire 对齐核准（601 味药合并规则、315/315 方剂签名、429 名单、24h 缓存键与 tier 分桶）归实施期，属另一任务。
- **改 `SNAPSHOT_TABLES`**：不适用。本决策不删任何表，分类器键比对无变化；ADR-0068 的「删表后条目仍须保留」是针对删表情形的先例。
- **追溯改写 7 份历史 ADR**：不选（Q3=A）。历史决策原文保留，退役沿革只记在本 ADR。
- **全文收紧 `CONTEXT.md` 约 20 处实现细节**：不选（Q8=A）。只处理 9 个与这 6 页直接相关的词条，避免把术语表变成全仓重写。

## 后果

- 管理员失去 6 个旧看板入口，侧栏「内容」分组少 6 项；`items` 9,506 行与 `channels` 13 行数据不变，仍由 App 8 端点与 4 个 `/api/v1/content/*` 端点读取。
- 权限码 69 → 62、角色授权 59 → 49、权限节点 113 → 101（推算）、权限快照 151 → 137 个码 token；`tests/worker/rbac.test.ts` 的默认权限计数与 `admin-menu.test.ts` 的菜单顺序断言同步调整。
- 文案定义 436 → 24；`CONTEXT.md` 删 1 个词条、收紧 8 个词条；7 份历史 ADR 与 3 份活文档的边界按「决策 6」处理。
- 0191 与代码同一次部署；App 缓存桶、App 8 端点响应形状、`APP_BOOK_REQUEST_CONTENT_SUFFIXES` 的 8 个内容端点清单均不变。
- 旧表 `items` / `channels` / `ext_category` 的 TCM 结构化写方随 6 看板删除而消失；App 8 端点读到的旧表数据成为冻结快照（后果见「旧表不再维护的后果与维护责任」表 1–7），后续更新靠导入脚本（`import-yao.mjs`/`import-term.mjs`/`sync-yao-from-golden.mts`）手动执行。维护责任由用户裁决选路①（接受冻结快照，不保留最小写入口）；同次裁决另定 App 8 端点走新建端点读独立模块表、旧链路（`tcm/reads.ts` 与 `withEmpty`）随新端点上线退役——该方向可行性量化见「App 8 端点改读独立模块表」。

## 范围之外

本轮只交付方案：本 ADR 与 `CONTEXT.md` 的 9 个词条。**未写任何 `src/` / `tests/` / `migrations/` 文件，未跑门禁，未起 dev server，未连远程 D1，未提交**。代码、0191 迁移、工单、备份导出、部署与清桶由用户另行下令；测试只写不跑，门禁只在用户手动触发时运行。**App 8 端点改读独立模块表（可行性量化见正文）、`withEmpty` 退役（裁决②）、方案 X + `getAppStyleConfig` 抽取（25 文件）与旧表维护责任裁决均在范围之外**，待用户另行下令。
