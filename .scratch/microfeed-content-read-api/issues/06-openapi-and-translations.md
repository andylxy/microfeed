# 06: OpenAPI 登记 + 中英文翻译表同步

**What to build:** 四个新端点进入 OpenAPI 文档。改 `OpenApiDocument.ts` 必须同步
`OpenApiTranslations.ts`，否则 `tests/unit/openapi.test.ts` 会红三条
（缺条目 / 死条目 / 序列化仍英文）——而 `yarn lint:openapi` 查不出这类缺漏。

**Blocked by:** 02, 03, 04

**Status:** done (2026-09-24)

- [ ] `src/shared/OpenApiDocument.ts` 登记四个端点：`/content/categories/`、
      `/content/categories/{categoryId}/books/`、`/content/books/{bookId}/chapters/`、
      `/content/chapters/{chapterId}/`
- [ ] 每个操作的摘要/描述、参数、响应字段按决策 2 的白名单形状写
- [ ] **同步 `src/shared/OpenApiTranslations.ts`**：每个新增英文原文都要有对应中文条目
      （键是**精确英文原文**，含 U+2014、ASCII 撇号；取精确文本用
      `node --import tsx` 打印 `JSON.stringify(...)`）
- [ ] 标注这些端点需要 login-credential 鉴权
- [ ] `yarn test` 通过（`tests/unit/openapi.test.ts` 不红）
- [ ] `yarn lint:openapi` 通过
- [ ] `yarn i18n:check` 通过
