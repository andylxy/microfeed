---
title: 05 API 契约与文档
description: microfeed 的 API 契约规范：Zod schema、OpenAPI 文档、Bearer 鉴权、生成物、契约与运行时测试。
---

# 05 API 契约与文档
> **用途**：新增或修改公共 API 端点时，保证外部契约与运行时一致。
> **触发词**：API、接口、OpenAPI、契约、schema、鉴权、Bearer、端点、生成 openapi/llms。
> **加载时机**：改动 `src/pages/api/**`、`src/shared/ApiSchemas.ts`、`src/shared/OpenApiDocument.ts`，或新增端点时读取本册。

- **不要**添加断言散文、标题、链接、命令片段、侧边栏标签或 `docs/` 与 `README.md` 里确切文件内容的单元测试。文档必须保持可手工编辑，无需配套改测试。用 `yarn docs:check` 与 `git diff --check` 校验文档，并在其实现边界测试可执行行为、schema、生成器、公共契约，而不是渲染出的散文。
- 把 `src/shared/ApiSchemas.ts` 与 `src/shared/OpenApiDocument.ts` 当作**外部 API 契约的唯一真相来源**。用 Zod 定义可复用的请求/响应 schema，然后在 OpenAPI 文档里登记每一个公共 API 操作，包含方法、路径、参数、请求体、响应状态、响应 schema、鉴权、兼容行为。
- 更新 API handler 要**同时**更新它的 OpenAPI 操作。尽可能在运行时校验里复用同样的 Zod schema；保持路由文件薄；当向后兼容需要保留既有字段或鉴权方式时显式保留。
- 在 UI、OpenAPI、Scalar、LLM 文档里，把 **Bearer 鉴权**作为唯一的 API Key 鉴权方式呈现。把仅兼容用的鉴权行为留在运行时代码与聚焦测试里，不要作为新集成的可选项暴露。
- **绝不手改** OpenAPI JSON、OpenAPI YAML、Scalar 输入、`llms.txt`、`llms-full.txt` 作为独立契约。它们必须由 `OPENAPI_DOCUMENT` 生成；完整的 LLM 参考必须靠内嵌那份完整生成的契约来保持自包含。
- 为每个改动或新增的端点加**契约测试与运行时测试**（**只写不跑**）。`yarn lint:openapi` 与 `yarn check` 的执行时机归 AGENTS.md「最高指令：门禁仅在手动触发时运行」。
