---
title: 11 功能新增与修改
description: 在 microfeed 里新增或修改一个功能的端到端处理流程：范围、分支、迁移、契约、UI、测试、门禁、提交。
---

# 11 功能新增与修改

> **用途**：对既有功能做修改，或新增一个功能时，按本册流程处理。
> **触发词**：功能修改、改功能、加功能、改逻辑、需求变更、改接口、新端点、改行为。
> **加载时机**：命中上述触发词、要改动仓库行为时读取本册；只读问题/解释不需要。

## 处理流程（按序执行）

1. **定位范围**：先确认改动跨哪几层——数据库（`migrations/`）、服务端（`src/server/`）、API 契约（`src/shared/`）、后台 UI（`src/components/admin/`）、路由（`src/pages/`）、文档（`docs/`）、测试（`tests/`）。能少动就少动。**涉及数据库时**：先**显示相关数据表字段**（读 `migrations/` 建表 SQL 或查 D1 schema，含 `ext1`~`ext10` 扩展槽位）、**说明各字段用途**，并**列出会受影响的**相关 **API 接口**（按分册 05 契约、08 数据库）。
2. **建分支**：`git checkout -b <type>/<short-kebab-case>`（`feature` / `fix` / `refactor`…）。**绝不在 `main` 上改**。
3. **数据库变更（如需）**：新增 `migrations/NNNN_<name>.sql`（下一个号），只追加、不改历史。建表/索引/触发器按分册 08 规范（**确保 `ext1`~`ext10` 存在**：新表建表即预留；**表已存在（含仅修改既有表）但缺 ext 时，本迁移必须 `ALTER TABLE ADD COLUMN` 一并补齐**；已存在则跳过——一次完成，后续扩展直接写 ext 槽位，不再每次改表）。
4. **服务端逻辑**：`src/server/<模块>/` 写 Worker 侧逻辑，只 import `src/shared/`。
5. **查询设计（必查 · 全表扫描检测）**：写任何 D1 查询前，先确认所走索引，把**预计扫描行数与读取字节数**写清楚，避免全表扫描；出现全表扫描必须给出**量化修复方案**（当前扫描行数、当前读取字节数、修复后预计读取字节数、所走或需新增的索引定义）。规范见分册 08「D1 额度与全表扫描治理」。
6. **API 契约**：在 `src/shared/ApiSchemas.ts` 用 Zod 定义 schema；在 `src/shared/OpenApiDocument.ts` 登记每个公共操作。**handler 与 OpenAPI 操作必须同步**；`openapi.json/yaml`、`llms*.txt`、Scalar **绝不手改**（由 `OPENAPI_DOCUMENT` 生成）。按分册 05。
7. **后台 UI**：优先 `src/components/ui/` 的 shadcn/ui，在 `src/components/admin/<模块>/` 组合；用 `cn` 合并类名；保留 Base UI 无障碍行为。按分册 07。
8. **路由**：`src/pages/[adminPath]/`、`src/pages/api/v1/` 加**薄**路由，只协调不写业务。
9. **文档**：改 `docs/<模块>/` 对应文档；架构性决策补 `docs/adr/NNNN-*.md`；需进文档站则在 `docs/src/content.config.ts` 加 glob。文档不被测试断言（按分册 10）。
10. **测试**：为新/改端点加**契约测试 + 运行时测试**；不要加复述实现的测试。按分册 01、05。
11. **门禁与提交**：只提交本次范围文件，用简洁祈使句标题；GitHub 鉴权可用时开 draft PR。`yarn lint:openapi`、`yarn typecheck`、`yarn test`、`git diff --check`、`yarn docs:check`、`yarn check` 的执行时机归 AGENTS.md「最高指令：门禁仅在手动触发时运行」。

## 注意事项（坑）

- **导入边界**：`src/server/` 禁 import `src/client/`；`src/client/` 禁 import `src/server/`；`manage-cli/` 只 import `src/shared/`。
- **Bearer 是唯一 API Key 鉴权**：UI/OpenAPI/Scalar/LLM 文档只呈现 Bearer；仅兼容鉴权留运行时代码，不暴露给新集成。
- **迁移只追加**：不改历史 `NNNN` 文件；新需求用新迁移。
- **服务器收尾**：改完停掉自己启动的 dev server，确认无端口占用（`curl` 得 `000`）。
- **保留无关改动**：不要 `stash` / `reset` / `discard` / `stage` 掉与任务无关的改动；必要时用独立 worktree。
