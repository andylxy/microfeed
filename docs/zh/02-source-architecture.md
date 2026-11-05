---
title: 02 源码架构
description: microfeed 的源码分层与导入边界：src/server、src/client、src/shared、manage-cli、路由与 public 资产。
---

# 02 源码架构
> **用途**：判断代码该放哪一层、哪些文件能 import 哪些，避免跨层依赖。
> **触发词**：代码放哪、导入边界、新增目录、新增文件放哪、跨层依赖、架构分层。
> **加载时机**：新增/移动文件、出现编译或架构违规、或规划新模块位置时读取本册。

- 所有 Astro 与 Worker 应用代码都放在 `src/` 下。
- **仅 Worker 的代码**（用到 bindings、D1、R2 或请求运行时状态）放在 `src/server/`。Server 模块可 import `src/shared/`，但**绝不** import `src/client/` 或浏览器组件。
- **仅浏览器的辅助代码**放在 `src/client/`。React 客户端组件可 import `src/client/` 与 `src/shared/`，但**绝不** import `src/server/`。
- **运行时中立**的常量、类型、路径、工具放在 `src/shared/`。
- 仓库部署工具放在 `manage-cli/`。它可 import `src/shared/` 里的运行时中立模块，但**不能** import 仅 Worker 或仅浏览器的模块。
- Astro 路由与中间件协调 server 模块与 UI 组件。保持路由文件**薄**，不要引入独立的 Worker 入口。
- 稳定的、未处理的公开资源放在 `public/`；不要把它们移进源码包或未经显式迁移就改公开 URL。
- **测试代码放 `tests/`**：`tests/unit/` 放契约、Zod、store 的 `node:sqlite` 端口级单测，`tests/worker/` 放运行时/集成测试。跨模块共用的测试基建放 `tests/unit/support/`（共享 D1 端口替身 `sqlite-statement.ts`、迁移读取 `migrations.ts`）；各模块的建表 DDL 与 `implements XxxDb` 包装类留在各自的测试文件里，只在需要数据库的用例中按模块镜像。
