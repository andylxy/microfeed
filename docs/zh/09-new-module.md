---
title: 09 新建模块
description: 在 microfeed 里新建功能模块时的查重流程（先查重、再扩展、最后才新建）、层分布、10 步清单、坑与最小文件集合，含新页面要不要加权限码的判定。
---

# 09 新建一个功能模块

> **用途**：新增一个功能域（如新的资源类型、新管理页、新 API 面）时的**查重流程**、目录/文件规划与注意事项，含**新页面要不要新权限码**的完整判定。
> **触发词**：新建模块、新功能、新资源、怎么开始、目录和文件规划、注意事项、新增后台页面、新页面、加页面、要不要加权限码、页面权限、两把锁、页面守卫、requirePagePermission、AdminPageGuards、权限码生成器怎么用、查重、有没有类似的、复用还是新建。
> **加载时机**：要新增一个横跨多层的功能模块、新增一个后台页面、**或改动既有功能前先判断该复用还是新建**时读取本册。**加码之后生成器本身的用法见 14 册。**

## 0. 先查重，再扩展，最后才新建

**这一步在做任何规划之前完成。跳过它直接写代码，是最贵的错——重复实现会让数据模型分叉，两套逻辑各自演化，日后合并的成本远高于当初扩展。**

### 0.1 查重：四层都看，并给出证据

不能只看一层就下结论。四层逐一过：

| 层 | 查什么 | 怎么查 |
| --- | --- | --- |
| **数据模型** | 是否已有能承载它的表/列；`ext1`~`ext10` 常备槽位够不够 | 读 `migrations/` 里相关表的建表与后续 `ALTER`；`docs/zh/08-db-schema.md` 有表清单 |
| **服务端** | 是否已有同职责的模块；是否有现成的 schema / 常量 / 工具函数 | 看 `src/server/` 目录名与 `src/shared/` 的导出；先 `grep` 关键名词再读文件 |
| **后台 UI** | 是否已有同类页面、可复用的组件 | 看 `src/components/admin/`、`src/pages/[adminPath]/` 的目录结构 |
| **权限面** | 是否有语义可覆盖的权限码 | `ADMIN_PAGE_GUARDS` 的路由→码映射、`PERMISSION_CODES`（判定见 §3） |

**结论必须点名具体文件与位置**（如「`src/server/annotations/store.ts` 已有同类写入逻辑」），不能只说「查过了没有」。查不到也要写明**查过哪些路径**。

### 0.2 优先扩展：四条全部满足才允许

找到接近的实现后，先判断能不能**在不改变既有行为**的前提下扩展它。四条同时满足才算「可扩展」：

1. **老调用点行为不变**——新增的是可选参数 / 可选字段 / 新分支，老路径的输出完全一致。
2. **既有测试不改**——如果必须改动既有断言，说明语义变了，那不是扩展，是重写。
3. **不新增特例分支**——为兼容而写的 `if (isXxx)`、`if (mode === "new")` 就是「扩展失败」的信号；出现它说明两个场景本质不同，该分开。
4. **权限与数据兼容**——不破坏既有权限码语义（不改已有码的含义）；不加必填列（D1 加列必须可空或带默认，否则既有行无法满足约束）。

### 0.3 确实不能附加时才新建

要说清**是哪条约束挡住了**，例如「既有 `items` 表的一条记录必须属于一个书卷，而新需求的对象不属于任何书卷，加可空外键会让既有查询多一次判空分叉」——这种理由成立。「新写一份更快」不是理由。

新建时按 §2 的 10 步清单走，不要跳过 §3 的权限判定。

**与「不绕行」同源**：AGENTS.md 行为管理里的「不绕依赖 / 不手写 parser / 不简化设计」三条，本质都是同一个判断——**别绕开既有实现另起一套**。要绕的时候先回到 0.2 逐条核对。

## 1. 模块在哪几层出现（以 webhooks 为实例）

| 层 | 位置 | webhooks 实例 |
| --- | --- | --- |
| 数据库 | `migrations/NNNN_*.sql` | `migrations/0017_webhooks.sql` |
| 服务端逻辑（仅 Worker） | `src/server/<module>/` | `src/server/webhooks/`：`crypto.ts` `delivery.ts` `emission.ts` `events.ts` `explorer.ts` `store.ts` `validation.ts` |
| 后台 UI 组件 | `src/components/admin/<module>/` | `AdminWebhookSidebar.tsx` `WebhookDeliveriesApp.tsx` `WebhookEndpointsApp.tsx` `WebhookEventExplorerApp.tsx` `WebhookOverviewApp.tsx` |
| 后台路由 | `src/pages/[adminPath]/<module>/` | `deliveries/` `endpoints/` `events/` `index.astro` |
| 公共 API 契约 | `src/shared/ApiSchemas.ts` + `src/shared/OpenApiDocument.ts` | `apiWebhookEventSchema` 等；`webhooks:` 段注册 `receiveMicrofeedWebhook` |
| API 附加参考 | `src/shared/WebhookExamples.ts` / `WebhookQuickstarts.ts` | 事件示例、代码示例 |
| 文档 | `docs/<module>/` | `docs/webhooks/`：`endpoints.md` `index.md` `operations.md` `testing.md` |
| 架构决策（可选） | `docs/adr/NNNN-kebab.md` | 如 ADR 记录 |
| 测试 | `tests/unit/` `tests/worker/` | 契约 + 运行时测试 |

## 2. 新建模块的 10 步清单（按序执行）

**前提**：先走完 §0 的三步并得出「确实要新建」的结论。下面每一步都在那个前提下执行。

1. **建分支**：`git checkout -b feature/<module-kebab>`（type 取 `feature`/`fix`/`refactor`…；绝不在 `main` 上改）。
2. **迁移**：新增 `migrations/NNNN_<module>.sql`（下一个号，以 `migrations/` 现有最大编号为准，不写死具体数字）。建表用 `CREATE TABLE IF NOT EXISTS`，主键 `VARCHAR/TEXT PRIMARY KEY`，带 `created_at`/`updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`；**预留 `ext1`~`ext10` 常备槽位**（按分册 08：新建表建表即预留；修改表缺则 `ALTER TABLE ADD COLUMN` 补齐；已存在则跳过）；索引用 `CREATE INDEX IF NOT EXISTS <table>_<col> ON <table>(...)`；业务约束用 `CREATE TRIGGER IF NOT EXISTS` + `RAISE(ABORT, 'code')`；软删除用可空 `deleted_at`。**不要**改/删旧迁移。
3. **服务端**：在 `src/server/<module>/` 写 Worker 侧逻辑（D1/R2/bindings/运行时）。只 import `src/shared/`。
4. **查询设计（必查 · 全表扫描检测）**：写任何 D1 查询前，先确认所走索引，把**预计扫描行数与读取字节数**写清楚，避免全表扫描；出现全表扫描必须给出**量化修复方案**（当前扫描行数、当前读取字节数、修复后预计读取字节数、所走或需新增的索引定义）。规范见分册 08「D1 额度与全表扫描治理」。
5. **API 契约**：在 `src/shared/ApiSchemas.ts` 用 Zod 定义可复用请求/响应 schema（`.meta({id, description, example})`）；在 `src/shared/OpenApiDocument.ts` 用 `createDocument` 登记每个公共操作（方法、路径、operationId、params、requestBody、responses、security）。**handler 与 OpenAPI 操作必须同步更新**。
6. **后台 UI**：优先 `src/components/ui/` 的 shadcn/ui 组件，在 `src/components/admin/<module>/` 组合；用 `cn` 合并类名；保留 Base UI 无障碍行为。
7. **路由**：在 `src/pages/[adminPath]/<module>/` 与 `src/pages/api/v1/<module>/` 加**薄**路由，只做协调，不写业务。
8. **权限（先判，再动手）**：**新模块不等于要新权限码**。判定表与判定口径见 §3，加码四步见 §3.3。无论加不加码，页面 `requirePagePermission` 之后都要在 `src/shared/AdminPageGuards.ts` 登记「路由 → 码」，否则测试红。
9. **文档**：在 `docs/<module>/` 补 md/mdx（需被 `docs/src/content.config.ts` 的 glob 收录才能在文档站显示）；架构性的补 `docs/adr/NNNN-*.md`。
10. **测试与门禁**：为新端点加契约测试 + 运行时测试（**只写不跑**）。`yarn lint:openapi`、`yarn typecheck`、`yarn test`、`git diff --check`、`yarn docs:check`、`yarn check` 的执行时机归 AGENTS.md「最高指令：门禁仅在手动触发时运行」。

## 3. 新页面要不要新权限码

「加了页面就要加码」是最常见的误判。实际数据：`ADMIN_PAGE_GUARDS` 里 **35 个页面条目只用到 20 个权限码**，其中 8 个码被多个页面共用——`items/new`、`items/[itemId]`、`items/list` 全用 `CONTENT_CHAPTER_READ`；`settings`、`settings/code-editor`、`settings/themes`、`settings/themes/drafts/[draftId]` 全用 `CONTENT_SETTINGS_MANAGE`。**详情页与新建页复用所属列表页的码**，这是既有惯例，不是疏漏。

### 3.1 先判：要不要加

| 情形 | 新码 | 必做 |
| --- | --- | --- |
| 同资源的另一视图、详情页、新建页 | **不加**，复用列表页的码 | `AdminPageGuards.ts` 登记「路由 → 码」，否则测试红 |
| 公开页 / 只校验登录态（首页、`login`、`account`、`forbidden`、`api/oauth` 等 7 个） | 不加 | 不入 `ADMIN_PAGE_GUARDS` |
| 资源缺增删改码（页有了、缺权限划分） | **加** | 走 3.3 四步 |
| 整块新功能，需要单独授予某类角色 | **加** | 走 3.3 四步 |

判定口径一句话：**这块内容是否需要「与现有资源不同的一批人」能看 / 能改，且会被单独授予角色**。只是同一批人的另一个入口 → 复用。

三问逐条问完再决定（任一条为否就复用）：

| 问题 | 为否时 |
| --- | --- |
| 是否需要**与现有资源不同的一批人**能看 / 能改？ | 复用现有码 |
| 现有码里有没有一个**语义正好覆盖**它的？ | 复用那个码 |
| 它会被**单独授予某类角色**吗（运营有、编辑没有之类）？ | 复用现有码 |

**新增模块同理，不是「必然加码」。** 模块只扩展现有权限面（再加一个内容视图），沿用现有码；只有在它引入**新的授权边界**时才加码。

### 3.2 两把锁：守卫码 ≠ 侧栏节点

最容易混的一处。两者都能让页面「出问题」，但症状完全不同：

| | 管什么 | 在哪 |
| --- | --- | --- |
| **守卫码** | 能不能**打开**这个页面（403 / 跳 forbidden） | 页面里的 `requirePagePermission(locals, code, language)` + `src/shared/AdminPageGuards.ts` |
| **节点行** | 侧栏**显示在哪**、角色编辑器怎么分组 | `ext_permission_nodes` 的 `kind='page'` 行 |

- 只加守卫码不补节点行 → 直链能打开，但侧栏里找不到入口。
- 只补节点行不加守卫码 → 侧栏看得见，点进去 403。

两种都是真实事故形态，别默认「加一个就等于加了另一个」。

**新增页面必做的那一步不是加码，是登记**：页面调用 `requirePagePermission` 之后，必须在 `src/shared/AdminPageGuards.ts` 加一行「路由 → 码」。`tests/unit/admin-page-guards.test.ts` 的「covers every guarded page」会逐行核对页面文件与目录，漏了当场红。用旧码也一样要登记。

### 3.3 确实要加码时（四步）

1. **人**：`src/shared/Constants.ts` 的 `PERMISSION_CODES` 加一行。
2. **机器**：`yarn rbac:gen` —— 重铺 `seed.ts` 标记区（**区内只放条目、不写注释**，说明写在区外的 `CATALOG_NOTES` 或 `RbacPermissionDocs.ts`），并新建 `NNNN_data_seed_<slug>_permission.sql`（只写 `ext_permissions`，**不写节点行**，迁移头部有节点模板）。
3. **人**：把标记区里那条 `name: ""` 填成中文短名，**再跑一次**（缺短名时第一次会跳过生成迁移）。
4. **人**：补 `src/shared/RbacPermissionDocs.ts` 的长说明。

`yarn rbac:check` 只读比对，报「seed 不同步 / 码无迁移 / 短名为空 / 缺长说明」，已进 `yarn check` 链。`rbac:gen` 缺短名时**退出码仍为 0**，别拿它判状态。生成器的完整用法（什么时候跑、刻意不做什么、两个坑）见 14 册「权限码生成器」；表结构与不变量见 14 册。

## 4. 必须注意的坑（注意事项）

- **导入边界**：`src/server/` 禁 import `src/client/`；`src/client/` 禁 import `src/server/`；`manage-cli/` 只 import `src/shared/`。放错层 = 编译或架构违规。
- **OpenAPI 是生成物**：`openapi.json/yaml`、`llms.txt/llms-full.txt`、Scalar 输入**绝不手改**，必须由 `OPENAPI_DOCUMENT` 生成。加端点后重新生成产物；`yarn lint:openapi` 的执行时机归 AGENTS.md「最高指令」。
- **Bearer 是唯一 API Key 鉴权**：UI/OpenAPI/Scalar/LLM 文档只呈现 Bearer；仅兼容的鉴权留在运行时代码，不暴露给新集成。
- **文档不被测试断言**：不要写断言 `docs/` 或 README 里散文/标题/链接/命令片段/侧边栏标签的单元测试；文档保持可手工编辑。
- **迁移不可回退**：只追加新迁移，不改历史 `NNNN` 文件。
- **不要加“复述实现”的测试**：聚焦有意义行为、回归、公共契约。
- **服务器收尾**：改完停掉自己启动的 dev server，确认无端口占用（`curl` 得 `000`）。
- **不相关改动**：不要 `stash/reset/discard/stage` 掉与任务无关的改动；必要时用独立 worktree。

## 5. 新增文件/改动最小集合速查

```
migrations/0025_<module>.sql                          # 建表/索引/触发器
src/server/<module>/<...>.ts                          # Worker 侧逻辑
src/shared/ApiSchemas.ts                              # Zod 契约（+ 导入）
src/shared/OpenApiDocument.ts                         # OpenAPI 操作（+ 导入）
src/components/admin/<module>/<...>.tsx               # 后台 UI
src/pages/[adminPath]/<module>/<...>.astro            # 后台路由（含 requirePagePermission）
src/shared/AdminPageGuards.ts                         # 路由 → 守卫码（新增页面必登，测试锁）
src/shared/Constants.ts                               # 仅当需要新码时改 PERMISSION_CODES
src/pages/api/v1/<module>/<...>.ts                    # 公共 API 路由（薄）
docs/<module>/<...>.md                                # 文档
docs/src/content.config.ts                            # （如需）新增 glob 收录
```
