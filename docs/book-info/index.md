---
title: 书本信息模块
description: 独立于作品频道的「书本信息」表（ADR-0058），后台 CRUD 面，与既有书机制并行共存。
---

`book_info` 是一个**独立**的「书本信息」表（迁移 0171，ADR-0058），字段镜像参考项目
`vol.api.sqlsugar` 的 `BookInfo` 实体。它与 microfeed 既有的作品模型（`channels` 行 +
`items` 章节）**完全解耦**：两张书模型并行共存，互不迁移、互不读写。

## 与既有书模型的区别

| 概念 | 载体 | 说明 |
| --- | --- | --- |
| `Book`（书） | `channels` 行 | 既有 novel-cms 主书模型，章节经 `_microfeed.bookId` 反查 |
| `BookInfo`（书本信息） | `book_info` 行 | 本模块的独立模型，字段镜像参考实体 |

不要混用两者：`book_info` 不参与公开站、不挂章节、不依赖
`ext_book_stats` / `ext_book_status` / `ext_category`。

## 表结构

`book_info`（13 个领域字段 + 常备列，snake_case）：

| 列 | 类型 | 参考字段 | 说明 |
| --- | --- | --- | --- |
| `id` | `VARCHAR(11)` PK | — | 11 位短 id |
| `book_name` | `VARCHAR(255) NOT NULL` | `BookName` | 书名 |
| `chapter` | `INTEGER` | `Chapter` | 总卷章数 |
| `author` | `VARCHAR(255)` | `Author` | 作者 |
| `cheng_shu` | `VARCHAR(255)` | `ChengShu` | 成书时间 |
| `case_division` | `VARCHAR(255) NOT NULL` | `Case` | 书籍分类（必填不可空；归属取值=分组 `key`，服务端不强制命中清单，游离值按原值回落；`case` 为 SQL 保留字 → `case_division`） |
| `case_tag` | `TEXT NOT NULL DEFAULT ''` | `CaseTag` | 内容标签（迁移 0173 起为文本） |
| `book_no` | `TEXT NOT NULL DEFAULT ''` | `BookNo` | 书本编号（迁移 0173 起为文本） |
| `image_url` | `VARCHAR(255)` | `ImageUrl` | 封面 |
| `hot_book` | `INTEGER NOT NULL DEFAULT 0` | `HotBook` | 状态（迁移 0173 起 NOT NULL，取值 = 状态清单 `value`，见「状态清单」） |
| `parent_id` | `VARCHAR(11)` | `ParentId` | 父级（逻辑自引用，无外键） |
| `org_id` | `INTEGER` | `OrgId` | 书籍性质（列位保留，无组织模块） |
| `is_enable` | `INTEGER NOT NULL DEFAULT 1` | `IsEnable` | 启用 |
| `comment` | `VARCHAR(255)` | `Comment` | 备注 |

常备列：`created_at` / `updated_at` / `deleted_at`（软删）+ `ext1`~`ext10`。

索引：`book_info_book_name` / `book_info_parent_id` / `book_info_is_enable` / `book_info_case_division`。

读代价（09 册步 4）：看板 `loadBookInfoBoard` 走 `SELECT * FROM book_info
ORDER BY book_name ASC, id ASC`，是有意为之的**整表读**——看板本就要列出全部行
（含已软删行，供两步删除的第二段物删）。迁移 0173 起 `book_no` 是文本列，排序键
改 `book_name`，`ORDER BY book_name` 由 `book_info_book_name` 索引驱动，免 filesort；
读侧仍触及每行（每行 13 个短列 +
常备列，单行远小于 4KB 页）。本表是**后台录入的用户内容**，行数以人工录入速度
增长（非导入/抓取），量级可控；若日后单表行数显著增长，应改分页
（`normalizeAdminItemListLimit(webSettings.itemsPerPage)`）而非全量返回。

业务约束：`parent_id = id` 被迁移 0171 的两条触发器
（`book_info_no_self_parent_ins` / `_upd`）拦截（`RAISE 'book_info_self_parent'`），
handler 层也会先拦成干净 400。

## 后台端点

模块只给后台用，无公共 api/v1（ADR-0058 决策 5）。10 条 ajax 端点（全部复用
`content:book:*`，不加新权限码）：

| 方法 | 路径 | 门码 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/admin/ajax/book-info` | `content:book:read` | 整表看板（分组清单 + 状态清单 + 全部书，含已软删行） |
| `POST` | `/admin/ajax/book-info` | `content:book:create` | 新建 |
| `PUT` | `/admin/ajax/book-info/[bookInfoId]` | `content:book:update` | 编辑 |
| `DELETE` | `/admin/ajax/book-info/[bookInfoId]` | `content:book:delete` | 软删（写 `deleted_at`） |
| `DELETE` | `/admin/ajax/book-info/[bookInfoId]/purge` | `content:book:delete` | 物删（仅已软删行） |
| `GET` | `/admin/ajax/book-info/groups` | `content:book:read` | 读分组清单 |
| `PUT` | `/admin/ajax/book-info/groups` | `content:book:update` | 整表覆盖写分组清单 |
| `POST` | `/admin/ajax/book-info/reassign` | `content:book:update` | 改派：把一组书整批挪到另一组 |
| `GET` | `/admin/ajax/book-info/statuses` | `content:book:read` | 读状态清单 |
| `PUT` | `/admin/ajax/book-info/statuses` | `content:book:update` | 整表覆盖写状态清单 |

页面：`/admin/book-info`（守卫 `content:book:read`，侧栏「内容」分组下）。

## 删除语义

- **软删**（`DELETE /…/[bookInfoId]`）：只写 `deleted_at`，行保留。已软删的行在看板
  上以「已软删」筹码单列。
- **物删**（`DELETE /…/[bookInfoId]/purge`）：只删**已经软删**的行，不可恢复；
  未软删按 `purgeNeedsDelete`（409）拒，不存在按 `notFound`（404）报。
- 本模块暂未提供恢复；已软删行只能物删。
- `parent_id` 是逻辑自引用（无外键），物删**不级联**子行——孤儿归属超出模块范围，
  由使用方自行保证层级完整性。

## 分组树（ADR-0059）

后台 `/admin/book-info` 是左右双栏：左栏 `AdminGroupTree` 按**分组**导航，右栏是选中那本
书的编辑表单。分组是「书本信息」自己的轻量归类，不碰 channels/items/ext_category。

- **分组清单存 `settings` 表一行**（`category='book_groups'`，`data` 为 JSON
  `{groups:[{key,label,sort}]}`），独立管理、整表覆盖写——与 users 页的注册来源
  （`signup_sources`）同构。运行时不依赖 `ext_category`（ADR-0059 决策 3）。
- **归属 = 书自身 `case_division`**：`case_division` 存的是分组 `key`（稳定 slug），
  本就 NOT NULL + 必填，故分组归属**不新增列、不迁移**（ADR-0059 决策 2）。
- **默认分组 = `ext_category` 三行的一次性冻结快照**（伤寒金匮/本草/内经，迁移 0172
  写进 `settings.book_groups`）。运行时不读 `ext_category`，删除 `ext_category` 也不影响
  分组（ADR-0058 红线不破）。
- **顶层节点「书籍分类」**：左栏树顶部渲染一个总览根行（`AdminGroupTree` 的 `root`
  prop，label = 字段名「书籍分类」，badge = 全部存活书数），不参与分组过滤。
- **删组先改派**：`case_division` NOT NULL，删分组前必须把该组书整批改派到另一组
  （`POST …/reassign`，`UPDATE book_info SET case_division=… WHERE case_division=…`，
  走 `book_info_case_division` 索引）。
- **末组不可删**：清单不允许清空——`case_division` 必填，删掉最后一个分组无处改派
  （fail-closed，服务端 `PUT groups` 对空清单返 400 `errors.bookInfo.lastGroup`）。
- **权限全复用 `content:book:*`**，不加新码（ADR-0059 决策 6）。
- 分组形状/清单 schema 的真源在 `src/shared/BookInfo.ts`（客户端分组
  弹层要本地预检，不能 import `@/server/*`，与 `SignupSource.ts` 同理）；服务端
  `src/server/book-info/groups.ts` re-export 并负责 IO（读一行 settings、整表覆盖写、
  缺行回落空数组、坏数据 fail-closed）。

## 状态清单（迁移 0173/0174）

迁移 0173 把 `hot_book` 从可空整数改成 **NOT NULL 状态列**（`DEFAULT 0`），取值 =
状态清单 `value`（公开=0/隐藏=1/会员=2，迁移 0174 播种默认三项）。编辑表单里
「状态」是下拉（项目 `AdminSelect`，非原生 select），「父级」是「分组 → 书」两层
`AdminSelect` 联动（先选父级所在分组，再从该组存活书里选一本，候选排除自身防自引用）。

- **状态清单存 `settings` 表一行**（`category='book_info_statuses'`，`data` 为 JSON
  `{statuses:[{value,label,sort}]}`），独立管理、整表覆盖写——与分组（`book_groups`）
  同构。后台「管理状态」弹层可增删改名排序。
- **`value` 是 `hot_book` 存的整数**（0–2147483647，清单内唯一），`label` 是下拉显示名，
  `sort` 是下拉内顺序。新建时状态下拉默认取清单里 `sort` 最小的状态（`hot_book`
  NOT NULL，须有值）。
- **末状态不可删**：`hot_book` NOT NULL，删光状态无值可写（fail-closed，服务端
  `PUT statuses` 对空清单返 400 `errors.bookInfo.lastStatus`，客户端先拦一道）。
- **书的状态取值须在清单内**：create/update 的 `hot_book` 由 handler 按当前清单校验，
  不在清单内返 400 `errors.bookInfo.invalidStatus`（空清单 → 任何取值都拒，fail-closed）。
- 看板 `GET /ajax/book-info` 一次带齐 `{groups, statuses, books}`；另有
  `GET/PUT /ajax/book-info/statuses` 单独读写清单。
- 迁移 0173 是 SQLite **改列型 12 步表重建**（建新表 → 复制 → 删旧 → 重命名 → 重建
  索引/触发器）：`case_tag`/`book_no` INTEGER→TEXT、`hot_book` 可空→NOT NULL DEFAULT 0
  （历史 NULL 行回填成 0）；排序键从 `book_no` 换 `book_name`，故补
  `book_info_book_name` 索引、不再重建旧 `book_info_book_no` 索引；
  `book_info_no_self_parent_*` 两条触发器随旧表 DROP 一并消失，重建。

## 代码位置

- 类型/端口：`src/shared/BookInfo.ts`（看板形状 + 分组/状态 schema
  真源）、`src/server/book-info/types.ts`（DB 行 + 端口）
- 纯读写：`src/server/book-info/store.ts`（书 CRUD）、`src/server/book-info/groups.ts`
  （分组 IO）、`src/server/book-info/statuses.ts`（状态 IO，均 re-export shared schema）
- 校验 + handler：`src/server/book-info/handlers.ts`
- 后台 UI：`src/components/admin/book-info/BookInfoApp.tsx`（双栏 + 分组树 + 分组/状态
  管理弹层；左栏宽屏 sticky 冻结）
- 页面与端点：`src/pages/[adminPath]/book-info/`、`src/pages/[adminPath]/ajax/book-info/`
- 迁移：`0171_seed_book_info.sql`（表）、`0172_seed_book_info_groups.sql`（默认分组快照 +
  `book_info_case_division` 索引）、`0173_schema_book_info_text_columns.sql`（文本列 +
  状态 NOT NULL + 排序键改 book_name）、`0174_seed_book_info_statuses.sql`（默认状态三项）
