# 07: 门禁、回归验证与部署

**What to build:** 改动上线，且线上可验证——四个端点在真实凭证下可用，
草稿与下架书的内容读不到，legacy key 走不通。

**Blocked by:** 05, 06

**Status:** done (2026-09-24)

- [ ] `yarn typecheck` 通过（= `yarn types && astro check && tsc --noEmit`；`astro check` 覆盖测试）
- [ ] `yarn test` 通过（单元 + worker 全绿）
- [ ] `yarn i18n:check` 通过
- [ ] 迁移在远程 D1 应用成功（`0056` 之后的下一号）
- [ ] `CODEBUDDY_SAFE_DELETE_ENABLED=0 ./node_modules/.bin/yarn manage deploy --instance ctwh-881019-xyz --yes`
      成功，日志出现 `Deployed and verified https://feed.881019.xyz`
      （**不加** `env -u` 前缀——该前缀会致部署静默早退）
- [ ] 线上验证：`GET /api/v1/content/categories/` + 凭证 → 200，字段为白名单四项
- [ ] 线上验证：`GET /api/v1/content/categories/OteD-aXHV_d/books/` → 200（该分类 1 本书）
- [ ] 线上验证：`GET /api/v1/content/books/{id}/chapters/` → 200，两级结构正确
- [ ] 线上验证：`GET /api/v1/content/chapters/{id}/` → 200，`contentHtml` 与库里一致
- [ ] 线上验证：**无凭证** → 401；**legacy key** → 404
- [ ] 线上验证：草稿章节 → 404
- [ ] `ext_api_access_log` 新增记录的 `permission_code` 为 `content:category:read` 等自研码
