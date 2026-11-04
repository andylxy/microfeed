---
title: 药材别名模块
description: 独立于既有别名派生链路的「药材别名」表（ADR-0064），后台按正名分组 CRUD，与旧别名模型并行共存。
---

`yao_alia` 是一个**独立**的「药材别名」表（迁移 0183，ADR-0064），字段镜像参考项目
`ctwh/YaoAlia.sql` 的 `YaoAlia` 实体。它与 microfeed 既有的别名链路**完全解耦**：
两套别名模型并行共存，互不读写、互不迁移。

## 与既有别名链路的区别

| 概念 | 载体 | 说明 |
| --- | --- | --- |
| 派生别名（旧） | `items` 口袋字段 `aliases` / `yaoNames` / `bieMing` | `getDerivedYaoAliases` 三源合并，随时间与导入内容变化 |
| 覆盖/隐藏指令（旧） | `ext_tcm_aliases` 行（迁移 0075/0076） | `manual` / `hidden` 三态叠加，`bieming` UNIQUE |
| App 别名端点（旧） | `GetAliaZhongYao` + 24h 缓存 | 派生 + 覆盖后的只读出口，`/admin/aliases/` 是其镜像看板 |
| `YaoAlia`（本模块） | `yao_alia` 行 | 47 行实体别名（别名 → 正名），后台直接维护 |

不要混用两者：`yao_alia` 不参与公开站、不进 `api/v1`、不挂 App 端点、不清公共缓存、
不依赖 `items` / `channels` / `settings` / `ext_tcm_aliases`。反向也成立——旧链路
不知道 `yao_alia` 存在，改本表不会影响 `GetAliaZhongYao` 的输出。两套并存是准入
条件而非过渡态：同名别名可以指向不同正名，属预期双源。

## 表结构

`yao_alia`（6 个领域字段 + 常备列，snake_case）：

| 列 | 类型 | 源字段 | 说明 |
| --- | --- | --- | --- |
| `id` | `VARCHAR(11)` PK | — | 种子确定性 `ya` + 源 Id 8 位（`ya00000001`…`ya00000047`）；新建走 `randomShortUUID()` |
| `yao_alia_no` | `INTEGER NOT NULL` | `yaoAliasNo` | 序号（1–47 原样；新建走 `MAX+1`，UNIQUE 冲突 fail-fast） |
| `yao_alia_bie_ming` | `VARCHAR(255) NOT NULL` | `YaoBieMing` | 别名（必填，**UNIQUE**；软删行仍占用该键） |
| `yao_alia_name` | `VARCHAR(255) NOT NULL` | `YaoName` | 正名（必填，非唯一；左栏按它只读派生分组） |
| `is_enable` | `INTEGER NOT NULL DEFAULT 1` | `IsEnable` | 启用（源 47/47 全 1；无状态枚举，不建 settings 状态清单） |
| `signature_id` / `signature` | `VARCHAR(64)` | `SignatureId` / `Signature` | 列位保留（源全 NULL），admin 不编辑、不做外键 |

常备列：`created_at` / `updated_at` / `deleted_at`（软删）+ `ext1`~`ext10`。
源 32 列中 20 列恒 NULL（`YaoText`、`Extend01`–`12`、`OtherMark`、`ParentId`、
`ExtJson`、`OrgId`、审计列等）不建——丢弃无信息损失。

索引：`yao_alia_no_unique`（UNIQUE）/ `yao_alia_bie_ming_unique`（UNIQUE）/
`yao_alia_name`（分组派生用不到 SQL，但保留窄范围点查能力）。

读代价（09 册步 4）：看板 `loadYaoAliaBoard` 走 `SELECT * FROM yao_alia
ORDER BY yao_alia_no ASC, id ASC`，是有意为之的**整表读**——看板本就要列出全部行
（含已软删行，供两步删除的第二段物删）。排序由 `yao_alia_no_unique` 索引全序驱动，
免表扫、免外排。表仅 47 行种子 + 后台录入增长，量级可控；若日后显著增长应改分页。

## 后台端点

模块只给后台用，无公共 api/v1、无 App 端点（ADR-0064 决策 8）。5 条 ajax 端点，
全部用专属码 `content:yao-alia:*`（不复用 `content:alias:*`）：

| 方法 | 路径 | 门码 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/admin/ajax/yao-alia` | `content:yao-alia:read` | 整表看板（`{entries}`，含已软删行） |
| `POST` | `/admin/ajax/yao-alia` | `content:yao-alia:manage` | 新建（201） |
| `PUT` | `/admin/ajax/yao-alia/[yaoAliaId]` | `content:yao-alia:manage` | 编辑（合并式 patch） |
| `DELETE` | `/admin/ajax/yao-alia/[yaoAliaId]` | `content:yao-alia:manage` | 软删（写 `deleted_at`） |
| `DELETE` | `/admin/ajax/yao-alia/[yaoAliaId]/purge` | `content:yao-alia:manage` | 物删（仅已软删行） |

页面：`/admin/yao-alia`（守卫 `content:yao-alia:read`，侧栏「内容」分组下，
节点 `page_yao_alia`，排序键 115）。

`GET` 返回 `cache-control: private, no-store`——看板是后台数据，且本模块没有任何
公开站影子，故不清也不读公共缓存。

## 删除语义

- **软删**（`DELETE /…/[yaoAliaId]`）：只写 `deleted_at`，行保留。已软删行在看板左栏
  「已软删」折叠区单列，树里不再出现。
- **物删**（`DELETE /…/[yaoAliaId]/purge`）：只删**已经软删**的行，不可恢复；
  未软删按 `purgeNeedsDelete`（409）拒，不存在按 `notFound`（404）报。
- 本模块暂未提供恢复；已软删行只能物删。
- **软删 ≠ 释放唯一键**：`yao_alia_bie_ming` 的 UNIQUE 对软删行同样有效，要复用同名
  别名必须先在折叠区物删那一行。不做静默改名、不做合并、不自动恢复。

## 左栏分组树（只读派生）

后台 `/admin/yao-alia` 是左右双栏：左栏 `AdminGroupTree` 按**正名**导航，右栏是选中
那条别名的详情/表单。

- **分组零存储**：分组键就是行自身的 `yao_alia_name`，UI 按它现算分组——零 settings
  读写、零 `groups` / `reassign` 端点、零改派、零「末组禁删」（ADR-0064 决策 3）。
  这与 ming-ci 的 `ming_ci_type` 严格命中 settings 清单不同：那里的分组键是外部配置，
  这里的「分组键」是数据列本身。
- **编辑正名即改分组**：改一条别名的 `yao_alia_name`，提交后左栏分组即时重算（重新
  `load()` 后派生），不需要任何改派动作。
- **组序 = 首次出现序**：`loadYaoAliaBoard` 已按 `yao_alia_no` 排序，派生分组沿用该序，
  与源数据同序；新建行序号追加在末尾。
- **组键前缀 `name:`**：同一棵树的键必须唯一，且不能与叶子 id（11 位短 id）撞。
- **叶子两栏**：`label` = 别名，`description` = `#序号`。正名已是组头，不再在叶子上重复。
- **顶层根行**：`AdminGroupTree` 的 `root` prop，label = 「药材别名」，badge = 存活别名总数。
- **搜索过滤留在页面**：按 别名 / 正名 / 序号 匹配；搜索态只把**有命中的分组**传进
  `groups`，零命中组头一并隐藏；全无命中由 `emptyTreeText`（「无匹配别名」）接管整树。
  非搜索态传全量分组，空分组仍显示并给 `emptyLeafText` 提示。

## 权限与菜单

| 项 | 值 |
| --- | --- |
| 读码 | `content:yao-alia:read`（页面守卫 + `GET` 端点） |
| 写码 | `content:yao-alia:manage`（`POST` / `PUT` / 两个 `DELETE`） |
| 三镜像 | `src/shared/Constants.ts` + `src/server/rbac/seed.ts` + 迁移 0183 |
| 默认授予 | editor / readonly 两码都授（内容编辑工作，与 `content:book-chapter:*` 同口径） |
| 菜单节点 | `page_yao_alia`（`kind='page'`，parent `group_content`，sort 115，icon `tags`）+ 两行 `kind='code'` 叶子（ADR-0038） |
| App 端 | 无。`audience` 全为 `desktop`，不新增 app 能力码、不动 `DOMAIN_RULES` |

不复用 `content:alias:*` 的理由：旧 `/admin/aliases/` 页占用那两个码，且其授权语义是
「App 别名端点覆盖/隐藏」，与本页「维护实体别名」不是一个边界。

## 代码位置

- 类型/schema 真源：`src/shared/YaoAlia.ts`（看板形状 + `yaoAliaCreateSchema` /
  `yaoAliaUpdateSchema`，UI 与 server 共用）
- 类型与端口：`src/server/yao-alia/types.ts`（`YaoAliaDb` 只暴露 `prepare`）
- 纯读写：`src/server/yao-alia/store.ts`（只碰 `yao_alia` 一张表）
- 校验 + handler：`src/server/yao-alia/handlers.ts`（5 个 handler + `YAO_ALIA_ERRORS`）
- 后台 UI：`src/components/admin/yao-alia/YaoAliaApp.tsx`（双栏 + 派生分组树 +
  已软删折叠区 + 两步删除确认卡）
- 页面与端点：`src/pages/[adminPath]/yao-alia/`、`src/pages/[adminPath]/ajax/yao-alia/`
- 测试：`tests/unit/yao-alia-schema.test.ts`、`yao-alia-store.test.ts`、
  `yao-alia-handlers.test.ts`（内存 `node:sqlite`，不经 D1）
- 迁移：`0183_seed_yao_alia.sql`（建表 + 3 索引 + 两权限码 + 页面节点 + 47 行种子）
- 决定：`docs/novel-cms/adr/0064-standalone-yao-alia-module.md`

## 验收数字

只读核对的完整 stdout（命令原文 + 每条结果）在
`.scratch/yao-alia-module/final-verification.txt`，数据源的字节级与文本级审计在
`.scratch/yao-alia-module/probe-output.txt`。两处为准，本页不复述数字，避免三处
维护同一份事实。

自检覆盖七项：文件落位、迁移落库事实（行数/去重数/序号上限/查询计划）、
双语键集合与占位符相等、九处横切登记、新模块对旧别名链路的 import 数为零、
行尾空白、`git diff --check`。任一项 FAIL 即阻断验收。

测试只写不跑，`typecheck` / `test` / `i18n:check` / `endpoints:check` /
`adr:check` / `layout:check` / `rbac:check` 与 D1 扫描由维护者手动触发。
