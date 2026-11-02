---
title: 09 新建模块
description: 在 microfeed 里新建一个功能模块的层分布、8 步清单、坑与最小文件集合（以 webhooks 为实例）。
---

# 09 新建一个功能模块

> **用途**：新增一个功能域（如新的资源类型、新管理页、新 API 面）时的目录/文件规划与注意事项。
> **触发词**：新建模块、新功能、新资源、怎么开始、目录和文件规划、注意事项。
> **加载时机**：要新增一个横跨多层的功能模块时读取本册。

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

## 2. 新建模块的 9 步清单（按序执行）

1. **建分支**：`git checkout -b feature/<module-kebab>`（type 取 `feature`/`fix`/`refactor`…；绝不在 `main` 上改）。
2. **迁移**：新增 `migrations/NNNN_<module>.sql`（下一个号，以 `migrations/` 现有最大编号为准，不写死具体数字）。建表用 `CREATE TABLE IF NOT EXISTS`，主键 `VARCHAR/TEXT PRIMARY KEY`，带 `created_at`/`updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`；**预留 `ext1`~`ext10` 常备槽位**（按分册 08：新建表建表即预留；修改表缺则 `ALTER TABLE ADD COLUMN` 补齐；已存在则跳过）；索引用 `CREATE INDEX IF NOT EXISTS <table>_<col> ON <table>(...)`；业务约束用 `CREATE TRIGGER IF NOT EXISTS` + `RAISE(ABORT, 'code')`；软删除用可空 `deleted_at`。**不要**改/删旧迁移。
3. **服务端**：在 `src/server/<module>/` 写 Worker 侧逻辑（D1/R2/bindings/运行时）。只 import `src/shared/`。
4. **查询设计（必查 · 全表扫描检测）**：写任何 D1 查询前，先确认所走索引，把**预计扫描行数与读取字节数**写清楚，避免全表扫描；出现全表扫描必须给出**量化修复方案**（当前扫描行数、当前读取字节数、修复后预计读取字节数、所走或需新增的索引定义）。规范见分册 08「D1 额度与全表扫描治理」。
5. **API 契约**：在 `src/shared/ApiSchemas.ts` 用 Zod 定义可复用请求/响应 schema（`.meta({id, description, example})`）；在 `src/shared/OpenApiDocument.ts` 用 `createDocument` 登记每个公共操作（方法、路径、operationId、params、requestBody、responses、security）。**handler 与 OpenAPI 操作必须同步更新**。
6. **后台 UI**：优先 `src/components/ui/` 的 shadcn/ui 组件，在 `src/components/admin/<module>/` 组合；用 `cn` 合并类名；保留 Base UI 无障碍行为。
7. **路由**：在 `src/pages/[adminPath]/<module>/` 与 `src/pages/api/v1/<module>/` 加**薄**路由，只做协调，不写业务。
8. **文档**：在 `docs/<module>/` 补 md/mdx（需被 `docs/src/content.config.ts` 的 glob 收录才能在文档站显示）；架构性的补 `docs/adr/NNNN-*.md`。
9. **测试与门禁**：为新端点加契约测试 + 运行时测试（**只写不跑**）。`yarn lint:openapi`、`yarn typecheck`、`yarn test`、`git diff --check`、`yarn docs:check`、`yarn check` 的执行时机归 AGENTS.md「最高指令：门禁仅在手动触发时运行」。

## 3. 必须注意的坑（注意事项）

- **导入边界**：`src/server/` 禁 import `src/client/`；`src/client/` 禁 import `src/server/`；`manage-cli/` 只 import `src/shared/`。放错层 = 编译或架构违规。
- **OpenAPI 是生成物**：`openapi.json/yaml`、`llms.txt/llms-full.txt`、Scalar 输入**绝不手改**，必须由 `OPENAPI_DOCUMENT` 生成。加端点后重新生成产物；`yarn lint:openapi` 的执行时机归 AGENTS.md「最高指令」。
- **Bearer 是唯一 API Key 鉴权**：UI/OpenAPI/Scalar/LLM 文档只呈现 Bearer；仅兼容的鉴权留在运行时代码，不暴露给新集成。
- **文档不被测试断言**：不要写断言 `docs/` 或 README 里散文/标题/链接/命令片段/侧边栏标签的单元测试；文档保持可手工编辑。
- **迁移不可回退**：只追加新迁移，不改历史 `NNNN` 文件。
- **不要加“复述实现”的测试**：聚焦有意义行为、回归、公共契约。
- **服务器收尾**：改完停掉自己启动的 dev server，确认无端口占用（`curl` 得 `000`）。
- **不相关改动**：不要 `stash/reset/discard/stage` 掉与任务无关的改动；必要时用独立 worktree。

## 4. 新增文件/改动最小集合速查

```
migrations/0025_<module>.sql                          # 建表/索引/触发器
src/server/<module>/<...>.ts                          # Worker 侧逻辑
src/shared/ApiSchemas.ts                              # Zod 契约（+ 导入）
src/shared/OpenApiDocument.ts                         # OpenAPI 操作（+ 导入）
src/components/admin/<module>/<...>.tsx               # 后台 UI
src/pages/[adminPath]/<module>/<...>.astro            # 后台路由
src/pages/api/v1/<module>/<...>.ts                    # 公共 API 路由（薄）
docs/<module>/<...>.md                                # 文档
docs/src/content.config.ts                            # （如需）新增 glob 收录
```
