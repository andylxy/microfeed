---
title: 本草模块
description: 独立于 items 中药链路的「本草」表（ADR-0061），后台 CRUD 面，172 行默认种子随迁移部署。
---

`zhong_yao` 是一个**独立**的「本草」表（迁移 0180，ADR-0061），字段镜像
`ctwh/ZhongYao.sql` 的 `ZhongYao` 实体。它与 microfeed 既有的中药机制（`items`
行 + `tcm_kind='yao'`）**完全解耦**：两套中药模型并行共存，互不读写、互不迁移。

## 与既有中药机制的区别

| 概念 | 载体 | 说明 |
| --- | --- | --- |
| items-中药（既有） | `items` 行（`tcm_kind='yao'`，172 条） | 挂在 `channels` 之下，序号/别名藏在 `items.data` JSON；App 端点 `GetAllZhongYao`、方剂 `fangYaoList.yaoId` 仍读它 |
| `ZhongYao`（本模块） | `zhong_yao` 行 | 独立表，后台自持 CRUD；不进公开站、不进 App 端点 |

不要混用两者：`zhong_yao` 不参与公开站、不挂章节、不依赖
`items`/`channels`/`tcm_kind`/`ext_*`。改本表不会影响 App 的中药输出。

## 默认数据（种子迁移）

本草的「出厂默认数据」全部通过**迁移 seed 固化**，部署到其他位置（任何执行过该迁移的
D1 环境）自动 apply，无需手动录入，与 book-info / ming-ci 模块范式一致：

| 迁移 | 种子内容 | 幂等 |
| --- | --- | --- |
| `0180_seed_zhong_yao.sql` | 建表 `zhong_yao` + 索引（`zhong_yao_name` / `zhong_yao_no_unique`）+ 权限页面节点 `page_zhong_yao` + **172 行默认本草**（来自 `ctwh/ZhongYao.sql` 冻结快照，id 为真 `tcmId('zhongyao', YaoId)` 隔离进程预计算的确定性 11 位短 id） | `CREATE TABLE/INDEX IF NOT EXISTS`、`INSERT OR IGNORE` |

要点：
- **幂等可重放**：全部 `IF NOT EXISTS` / `OR IGNORE`，重复 apply 或部署到新位置安全，已存在行不覆盖。
- **默认数据 vs 用户数据分离**：种子行 `zhong_yao_no` 占 0–171；用户新建走 `MAX(no)+1`（`zhong_yao_no_unique` 冲突 fail-fast），不会与种子撞号。
- **源数据来源**：`ctwh/ZhongYao.sql` 是开发期源数据，不随部署；172 行种子值已冻结进迁移，后续源表与种子各自独立演化。
- **部署验证**：目标位置执行 `wrangler d1 migrations apply`（或对应部署流水线）后，`zhong_yao` 表即自带上述 172 行默认数据；可用 `SELECT COUNT(*) FROM zhong_yao;`（应为 172）核对。
- **D1 单语句 100KB 上限**：Cloudflare D1 单条 SQL 语句约 100KB 上限。`0180` 的 172 行**拆为 18 批 INSERT**（每批约 10 行），实测单批最大 8712 B（LF）/ 8741 B（`core.autocrlf` 检出为 CRLF），约 8.5KB，远未触顶；全文件 109.5KB 是 18 条语句之和，每批独立计数。若日后向默认数据增行，**勿把上千行塞进一条多值 INSERT**，继续分批并保证单条语句 < 100KB；单条本草的 `zhong_yao_text` 也别超 100KB（单值上限同量级）。超出会被 D1 拒收、迁移失败。详见 `0180` 迁移头注释「D1 导入限制」段。

## 本草内容字段（Markdown）

`zhong_yao_text` 在编辑态用 `AdminMarkdownEditor`（Markdown 源码编辑器，含标注工具栏，
与名词/正文编辑器同款），**只读详情态也走 `MarkdownPreview` + `remark-breaks` 渲染**，
与编辑预览所见一致；预览明暗跟随 `<html data-color-mode>`。内容以 Markdown 源码原样存库，
不做预处理：

- 源数据的真实换行（MySQL dump 的 `\r\n`/`\n` 转义序列在导入期已解析为真实换行）
  经 `remark-breaks` 渲染为换行；字面转义序列不会被当作换行。
- `$u{}`（药名）/ `$q{}`（出处）等本草标记是内容本体，**原样保留不解析**；
  工具栏可插入后台维护的标注标记。
- `whitespace-pre-wrap` 的旧裸文本展示已弃用。
- **种子数据兼容性（实测 172 行）**：正文无链接/图片/粗体/行内代码/表格语法
  （0 行），11 行含裸 `[...]` 夹注但没有链接定义（如生姜条的
  `[本经未录生姜，仅于干姜条言生者尤良。]`），无行首列表/标题前缀。故改
  Markdown 渲染不会结构性改写既有种子内容；序号写法是中文顿号 `3、`，
  不会被解析为有序列表。

## 后台端点

模块只给后台用，无公共 api/v1、无 App 端点（ADR-0061 裁决 D3）。3 个文件 / 5 个方法，
复用 `content:yao:*`（不新增权限码）：

| 方法 | 路径 | 门码 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/admin/ajax/zhongyao` | `content:yao:read` | 整表看板（`{entries}`，含已软删行） |
| `POST` | `/admin/ajax/zhongyao` | `content:yao:manage` | 新建 |
| `PUT` | `/admin/ajax/zhongyao/[zhongYaoId]` | `content:yao:manage` | 编辑（合并式 patch） |
| `DELETE` | `/admin/ajax/zhongyao/[zhongYaoId]` | `content:yao:manage` | 软删（写 `deleted_at`） |
| `DELETE` | `/admin/ajax/zhongyao/[zhongYaoId]/purge` | `content:yao:manage` | 物删（仅已软删行） |

页面：`/admin/zhongyao`（守卫 `content:yao:read`，侧栏「内容」分组下，节点
`page_zhong_yao`，排序键 113）。`GET` 返回 `cache-control: private, no-store`。

## 删除语义

- **软删**：只写 `deleted_at`，行保留；已软删行在左栏「已软删」折叠区单列。
- **物删**：只删**已经软删**的行，不可恢复；未软删按 `purgeNeedsDelete`（409）拒。
- 本模块暂未提供恢复；已软删行只能物删。

## 代码位置

- 类型/schema 真源：`src/shared/ZhongYao.ts`（`zhongYaoCreateSchema` /
  `zhongYaoUpdateSchema`，UI 与 server 共用）
- 类型与端口：`src/server/zhong-yao/types.ts`（`ZhongYaoDb` 只暴露 `prepare`）
- 纯读写：`src/server/zhong-yao/store.ts`（只碰 `zhong_yao` 一张表）
- 校验 + handler：`src/server/zhong-yao/handlers.ts`（5 个单 `db` 签名的 handler）
- 后台 UI：`src/components/admin/zhong-yao/ZhongYaoApp.tsx`（`AdminTreeNavLayout`
  两栏容器，`nav` 槽平铺列表 + 搜索，无 `AdminGroupTree`）
- 页面与端点：`src/pages/[adminPath]/zhongyao/`、`src/pages/[adminPath]/ajax/zhongyao/`
- 测试（只写不跑）：`tests/unit/zhong-yao-{store,handlers}.test.ts`
- 迁移：`0180_seed_zhong_yao.sql`
- 决定：`docs/novel-cms/adr/0061-standalone-zhong-yao-module.md`

测试只写不跑，`typecheck` / `test` / `i18n:check` / `adr:check` /
`migrations:check` / `layout:check` / `endpoints:check` 与 D1 扫描由维护者手动触发。
