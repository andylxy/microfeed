---
title: 名词模块
description: 独立于条目频道的「名词」表（ADR-0060），后台 CRUD 面，与既有 items-名词机制并行共存。
---

`ming_ci` 是一个**独立**的「名词」表（迁移 0177，ADR-0060），字段镜像参考项目
`vol.api.sqlsugar` 的 `BeiMingCi` 实体。它与 microfeed 既有的名词机制（`items` 行 +
`tcm_kind='term'`）**完全解耦**：两套名词模型并行共存，互不迁移、互不读写。

## 与既有名词机制的区别

| 概念 | 载体 | 说明 |
| --- | --- | --- |
| `items`-名词 | `items` 行（`tcm_kind='term'`） | 既有内容链路，App 端点（`GetAllMingCi`/`getAppAllTerms`）仍读它；来源书经 `items.book_id` 挂 `channels` |
| `MingCi`（名词） | `ming_ci` 行 | 本模块的独立模型，字段镜像参考 `BeiMingCi`；来源书引用 `book_info.id` |

不要混用两者：`ming_ci` 不参与公开站、不挂章节、不依赖
`items`/`channels`/`tcm_kind`/`ext_*`。App 读取阶段 1 仍走 items（ADR-0060 决策 2 并行共存）。

## 表结构

`ming_ci`（13 个领域字段 + 常备列，snake_case）：

| 列 | 类型 | 参考字段 | 说明 |
| --- | --- | --- | --- |
| `id` | `VARCHAR(11)` PK | — | 11 位短 id（种子 = 真 `tcmId('mingci', MingCiNo)` 隔离进程预计算，17 真值见「数据导入」） |
| `ming_ci_no` | `INTEGER NOT NULL` | `MingCiNo` | 名词ID（种子 0–16，唯一；显示/排序，非主键） |
| `ming_ci_name` | `VARCHAR(255) NOT NULL` | `MingCiName` | 名词名称（必填） |
| `ming_ci_bei_ming` | `VARCHAR(255)` | `MingCiBeiMing` | 名词别名 |
| `ming_ci_text` | `TEXT NOT NULL` | `MingCiText` | 名词内容（必填；含 `$m{}/$n{}/$x{}/$a{}` 标记，**原样存储不解析**） |
| `ming_ci_list` | `TEXT NOT NULL DEFAULT '[]'` | `MingCiList` | 别名列表（JSON 数组字符串，镜像 App 形状 `mingCiList: string[]`） |
| `source_book_id` | `VARCHAR(11)` | `SoureBook` | 名词来源书 → `book_info.id`（逻辑引用，无硬外键） |
| `ming_ci_type` | `VARCHAR(255) NOT NULL` | `MingCiType` | 归纳分类（必填；取值=分组 `key`，**服务端严格校验命中 `mingci_groups.key`，未命中 400 fail-closed**，镜像 ADR-0059 `case_division`） |
| `show_image` | `VARCHAR(255)` | `ShowImage` | 显示图片 |
| `remark` | `TEXT` | `Remark` | 备注 |
| `is_enable` | `INTEGER NOT NULL DEFAULT 1` | `IsEnable` | 启用（无状态枚举，参考实体只有此字段） |
| `signature_id` | `VARCHAR(64)` | `SignatureId` | 签名Id（列位保留，App 签名链路保真，admin 不编辑） |
| `signature` | `VARCHAR(64)` | `Signature` | 签名内容（列位保留，同上） |

常备列：`created_at` / `updated_at` / `deleted_at`（软删）+ `ext1`~`ext10`。

索引：`ming_ci_name` / `ming_ci_type` / `ming_ci_source` / `ming_ci_no_unique`（迁移 0177）。

读代价（09 册步 4）：看板 `loadMingCiBoard` 走 `SELECT * FROM ming_ci
ORDER BY ming_ci_no ASC, id ASC`，是有意为之的**整表读**——看板本就要列出全部行
（含已软删行，供两步删除的第二段物删）。`ORDER BY ming_ci_no` 由 `ming_ci_no_unique`
索引驱动，免 filesort。本表是**后台录入的用户内容**，行数以人工录入速度增长
（种子 17 行，非抓取），量级可控；若日后单表行数显著增长，应改分页
（`normalizeAdminItemListLimit(webSettings.itemsPerPage)`）而非全量返回。

## 默认数据（种子迁移）

ming-ci 的「出厂默认数据」全部通过**迁移 seed 固化**，部署到其他位置（任何执行过这些迁移的 D1 环境）自动 apply，无需手动录入，且与 book-info 模块范式一致：

| 迁移 | 种子内容 | 幂等 |
|---|---|---|
| `0177_seed_ming_ci.sql` | 建表 `ming_ci` + 索引（`ming_ci_no_unique` 等）+ 权限页面节点 `page_ming_ci` | `CREATE TABLE/INDEX IF NOT EXISTS`、`INSERT OR IGNORE` |
| `0178_seed_ming_ci_groups.sql` | `settings.mingci_groups` 4 个默认分组：医理 `yili` / 药理 `yaoli` / 易理 `zhouyi` / 通用 `tongyong`（对 `ctwh/BeiMingCi.sql` 的一次性冻结快照，运行时不依赖源表） | `INSERT OR IGNORE`（category 主键） |
| `0179_seed_ming_ci_rows.sql` | 17 行默认名词（来自 `ctwh/BeiMingCi.sql` 冻结快照，id 为真 `tcmId` 隔离进程预计算的确定性 11 位短 id） | `INSERT OR IGNORE`（id 主键） |

要点：
- **幂等可重放**：全部 `IF NOT EXISTS` / `OR IGNORE`，重复 apply 或部署到新位置安全，已存在行不覆盖。
- **默认数据 vs 用户数据分离**：种子行 `ming_ci_no` 占 0–16；用户新建走 `MAX(no)+1` 事务（`ming_ci_no_unique` 冲突 fail-fast），不会与种子撞号。
- **分组默认值在迁移里，不在代码硬编码**：`shared/MingCi.ts` 只定义分组 schema 形状（`mingCiGroupSchema`），4 个分组的实际值只写在 `0178`；改分组请走后台「管理分组」或 `PUT /groups`，不要手改迁移。
- **源数据来源**：`ctwh/` 下 `BeiMingCi.sql` 等是开发期源数据，不随部署；种子值已冻结进迁移，后续源表与种子各自独立演化（ADR-0060 决策 4）。
- **部署验证**：目标位置执行 `wrangler d1 migrations apply`（或对应部署流水线）后，`ming_ci` 表与 `settings.mingci_groups` 即自带上述默认数据；可用 `SELECT COUNT(*) FROM ming_ci;`（应为 17）与 `SELECT data FROM settings WHERE category='mingci_groups';` 核对。
- **D1 单语句 100KB 上限**：Cloudflare D1 单条 SQL 语句约 100KB 上限。`0179` 当前 17 行同一条 INSERT 约 15KB，远未触顶；若日后向默认数据增行，**勿把上千行塞进一条多值 INSERT**，改成分批（每批若干行一条 INSERT），保证单条语句 < 100KB；单条名词的 `ming_ci_text` 也别超 100KB。超出会被 D1 拒收、迁移失败。详见 `0179` 迁移头注释。

## 名词内容字段（Markdown）

`ming_ci_text` 在编辑态用 `AdminMarkdownEditor`（自带 `$m{}/$n{}/$x{}/$a{}` 标注工具栏，与 tcm 正文编辑器同款），**只读详情态也走 `MarkdownPreview` + `remark-breaks` 渲染**，与编辑预览所见一致。内容以 Markdown 源码原样存库，不做预处理；`whitespace-pre-wrap` 的旧裸文本展示已弃用。

## 后台端点

模块只给后台用，无公共 api/v1（ADR-0060 决策 7）。7 条 ajax 端点（全部复用
`content:term:*`，不加新权限码）：

| 方法 | 路径 | 门码 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/admin/ajax/ming-ci` | `content:term:read` | 整表看板（分组清单 + 来源书列表 + 全部名词，含已软删行） |
| `POST` | `/admin/ajax/ming-ci` | `content:term:manage` | 新建 |
| `PUT` | `/admin/ajax/ming-ci/[mingCiId]` | `content:term:manage` | 编辑（合并式） |
| `DELETE` | `/admin/ajax/ming-ci/[mingCiId]` | `content:term:manage` | 软删（写 `deleted_at`） |
| `DELETE` | `/admin/ajax/ming-ci/[mingCiId]/purge` | `content:term:manage` | 物删（仅已软删行） |
| `GET` | `/admin/ajax/ming-ci/groups` | `content:term:read` | 读分组清单 |
| `PUT` | `/admin/ajax/ming-ci/groups` | `content:term:manage` | 整表覆盖写分组清单 |
| `POST` | `/admin/ajax/ming-ci/reassign` | `content:term:manage` | 改派：把一组名词整批挪到另一组 |

页面：`/admin/ming-ci`（守卫 `content:term:read`，侧栏「内容」分组下）。

## 删除语义

- **软删**（`DELETE /…/[mingCiId]`）：只写 `deleted_at`，行保留。已软删的行在看板
  上以「已软删」筹码单列。
- **物删**（`DELETE /…/[mingCiId]/purge`）：只删**已经软删**的行，不可恢复；
  未软删按 `purgeNeedsDelete`（409）拒，不存在按 `notFound`（404）报。
- 本模块暂未提供恢复；已软删行只能物删。

## 分组清单（迁移 0178）

后台 `/admin/ming-ci` 是左右双栏：左栏 `AdminGroupTree` 按**分组**导航，右栏是选中那个
名词的编辑表单（布局壳用 `AdminTreeNavLayout`，见 `docs/zh/admin-tree-nav-layout.md`）。
分组是「名词」自己的轻量归类，不碰 items/channels/ext_category。

右栏表单卡片间距严格对齐 **`/admin/items/new/`**：卡片容器 `rounded-[14px] border bg-card p-5
text-card-foreground shadow-xs`，**每个顶层字段（含「展示图」`showImage` 输入、「启用」`isEnable`
开关）各包一层 `<div className="mt-5">`**，拿统一 20px 节奏；两列字段用
`mt-5 grid grid-cols-1 gap-4 md:grid-cols-2`，按钮行 `mt-5 flex gap-2`。开关类字段（`AdminSwitch`
内部 `[toggle][label]` 横向并排）也走同样的 `mt-5` 块，不因组件内部布局不同而掉节奏。

- **「名词内容」字段用 `AdminMarkdownEditor`**（Markdown 源码编辑器，含 `$m{}/$n{}/$x{}/$a{}`
  标注工具栏，与 tcm 正文同款）。`onChange` 拿到的是 Markdown 源码，**原样存入 `mingCiText`**，
  数据契约不变（逐字存储、标记不解析；占位/提示走 `mingCi.textMarkdownPlaceholder` /
  `mingCi.textMarkdownHint`）。

- **分组清单存 `settings` 表一行**（`category='mingci_groups'`，`data` 为 JSON
  `{groups:[{key,label,sort}]}`），独立管理、整表覆盖写——与书本信息分组（`book_groups`）
  同构。运行时不依赖任何源表（ADR-0060 决策 4）。
- **归属 = 名词自身 `ming_ci_type`**：`ming_ci_type` 存的是分组 `key`（稳定 slug），
  本就 NOT NULL + 必填，故分组归属**不新增列、不迁移**。
- **默认分组 = `BeiMingCi.sql` 的 `MingCiType` 一次性冻结快照**（医理/药理/易理/通用，
  迁移 0178 写进 `settings.mingci_groups`）。slug：医理→yili、药理→yaoli、
  易理→zhouyi（避免与医理同名 yili）、通用→tongyong。运行时不读源表。
- **顶层节点「名词分类」**：左栏树顶部渲染一个总览根行（`AdminGroupTree` 的 `root`
  prop，label = 字段名「名词分类」，badge = 全部存活名词数），不参与分组过滤。
- **叶子两栏**：每个名词在树里占固定两栏——`label` = `ming_ci_name`（无名称回落
  「未命名名词」），`description` = `ming_ci_bei_ming`（**无别名就不传 `description`，
  第二栏整行留空**）。
- **搜索过滤留在页面**：左栏搜索按 名称/编号/别名/**内容**（`ming_ci_text`）匹配；搜索态只把**有命中的
  分组**传进 `groups`，零命中分组的组头一并隐藏；全部分组都无命中时由 `emptyTreeText`
  （「无匹配名词」）接管整树。非搜索态传全量分组，空分组仍显示并给 `emptyLeafText` 提示。
  徽章 `count` 与该组 `leaves` 同口径（都取过滤后的 `visible`）——搜索态跟随命中数，非搜索态
  `visible` 即全量 `members`，徽章仍是全量口径（顶层 root `count` 恒为全部存活名词数）。
- **删组先改派**：`ming_ci_type` NOT NULL，删分组前必须把该组名词整批改派到另一组
  （`POST …/reassign`，`UPDATE ming_ci SET ming_ci_type=… WHERE ming_ci_type=…`，
  走 `ming_ci_type` 索引）。
- **末组不可删**：清单不允许清空——`ming_ci_type` 必填，删掉最后一个分组无处改派
  （fail-closed，服务端 `PUT groups` 对空清单返 400 `errors.mingCi.lastGroup`）。
- **无状态清单**：参考 `BeiMingCi` 只有 `IsEnable`，无状态枚举，故不建
  `mingci_statuses`、不设状态下拉（对比书本信息 `book_info_statuses`）。
- **权限全复用 `content:term:*`**，不加新码（ADR-0060 决策 6）。
- 分组形状/清单 schema 的真源在 `src/shared/MingCi.ts`（客户端分组弹层要本地预检，
  不能 import `@/server/*`）；服务端 `src/server/ming-ci/groups.ts` re-export 并负责 IO
  （读一行 settings、整表覆盖写、缺行回落空数组、坏数据 fail-closed）。

## 数据导入（迁移 0179）

种子数据来源 `ctwh/BeiMingCi.sql`（17 行），迁移 `0179_seed_ming_ci_rows.sql` 硬编码
`INSERT OR IGNORE` 播种（幂等，`id` 主键）。列映射：

| 源列 | `ming_ci` 列 | 变换 |
| --- | --- | --- |
| `MingCiNo` | `ming_ci_no` | 原值（0–16） |
| `MingCiName` | `ming_ci_name` | `trim()`（清源行「畏\n」尾随换行） |
| `MingCiBeiMing` | `ming_ci_bei_ming` | 原值 |
| `MingCiText` | `ming_ci_text` | 原值（多行 + `$m{}/$a{}` 标记原样） |
| `MingCiList` | `ming_ci_list` | NULL→`'[]'`；否则 `JSON.stringify(split(',').map(trim))` |
| `SoureBook` | `source_book_id` | 查 `book_info.id`：9040000→`XNK0VFX39Xv`、400100→`OsOP62cyp3j`、1001000→`5IGM9t76quT`、20300000→`ghBqURJwurj` |
| `MingCiType` | `ming_ci_type` | 查分组 `key`：医理→yili、药理→yaoli、易理→zhouyi、通用→tongyong |
| `ShowImage` | `show_image` | 原值 |
| `Remark` | `remark` | 原值 |
| `IsEnable` | `is_enable` | 原值（全 1） |
| `SignatureId` | `signature_id` | 原值（int64 < 2^53 精确） |
| `Signature` | `signature` | 原值 |

id 由真 `tcmId('mingci', MingCiNo)`（`scripts/import-ctwh/build.ts:153`）在编写迁移时按
`MingCiNo` 0→16 顺序、**隔离进程**预计算（11 位 base62，带 `idOwner` 碰撞加盐——顺序依赖，
仅「隔离进程首次调用」稳定），17 个全唯一、硬编码。**此前一次「纯 SHA-256 无碰撞加盐」复刻
产物（首 `u7UiA44Otad`、末 `z5GAvKzDZ52`）与真算法不符，作废。** 17 真值（2026-11-04 实测）：
`KXky0UUeJqt`/`vawJmMy1R6i`/`cyDmUmuDwd6`/`Z94SNqBdY3v`/`64OxeWGpLyA`/`eFJUTqNLZ9I`/
`SB8YK29l3lb`/`q2PBuGxblo4`/`wcj0IVVNNmY`/`hew93S5np05`/`B7xDfBL5qeU`/`mOeRPbMyovF`/
`fWye5mGxShN`/`NgyWBPZuFIj`/`wTgDQzVfGlL`/`42ZqG4162Cw`/`PV60LaP3pVS`（`MingCiNo` 0→16），
与 `book_info` 0175 种子 10 个 id 无跨表碰撞。迁移 0179 只读源文件于作者时，运行时不读文件。

## 代码位置

- 类型/端口：`src/shared/MingCi.ts`（看板形状 + 分组 schema 真源）、
  `src/server/ming-ci/types.ts`（DB 行 + 端口）
- 纯读写：`src/server/ming-ci/store.ts`（名词 CRUD）、`src/server/ming-ci/groups.ts`
  （分组 IO，re-export shared schema）
- 校验 + handler：`src/server/ming-ci/handlers.ts`
- 后台 UI：`src/components/admin/ming-ci/MingCiApp.tsx`（`AdminTreeNavLayout` 双栏 +
  `AdminGroupTree` 分组树 + 分组管理弹层；左栏宽屏 sticky 冻结）
- 页面与端点：`src/pages/[adminPath]/ming-ci/`、`src/pages/[adminPath]/ajax/ming-ci/`
- 迁移：`0177_seed_ming_ci.sql`（表 + 索引 + 菜单节点）、
  `0178_seed_ming_ci_groups.sql`（默认分组快照）、`0179_seed_ming_ci_rows.sql`
  （种子 17 行，源 `ctwh/BeiMingCi.sql`）
