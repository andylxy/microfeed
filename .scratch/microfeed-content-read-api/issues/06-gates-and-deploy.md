# 06: 门禁、回归验证与部署

**What to build:** 四个端点上线，且线上可验证：持登录凭证能逐级取到 标签 → 书 → 卷章 → 正文；
legacy bearer 与无权限凭证被拒；未发布内容不可见。

**Blocked by:** 05

**Status:** ready-for-agent

## Acceptance criteria

- [ ] `yarn typecheck` 通过（= `yarn types && astro check && tsc --noEmit`）
- [ ] `yarn test` 通过（单元 + worker 两套）
- [ ] `yarn i18n:check` 通过（若新增了界面文案）
- [ ] 迁移在远程 D1 应用成功（`0056`）
- [ ] `manage deploy --instance ctwh-881019-xyz --yes` 成功，日志出现
      `Deployed and verified https://feed.881019.xyz`（**不加** `env -u` 前缀）
- [ ] **线上逐级验证**（用真实登录凭证 `Bearer mflc_…`）：
  - [ ] `GET /api/v1/content/categories/` → 200，含 4 个分类（东方玄幻 / 本草 / 内经类 / 伤寒）
  - [ ] `GET /api/v1/content/categories/OteD-aXHV_d/books/` → 200（本草 1 本）
  - [ ] `GET /api/v1/content/categories/eastern-fantasy/books/` → 200（slug 亦可，4 本）
  - [ ] `GET /api/v1/content/books/{真实bookId}/chapters/` → 200，卷章结构正确、`truncated: false`
  - [ ] `GET /api/v1/content/chapters/{真实chapterId}/` → 200，`contentHtml` 与 DB 一致
- [ ] **线上负向验证**：
  - [ ] 无凭证 → 401
  - [ ] legacy 路径 `GET /api/content/categories/` → **404**（未登记 legacy）
  - [ ] 不存在的 id → 404
  - [ ] `ext_api_access_log` 新增记录的 `permission_code` 为 `content:*:*`

## 备注

- 部署后按惯例复核 git 引用（本环境提交会吃引用，见 `git-safe-commit`）。
- 不自动提交：按项目约定，提交需用户明确指示。
