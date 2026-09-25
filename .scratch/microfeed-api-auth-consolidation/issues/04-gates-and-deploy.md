# 04: 门禁、回归验证与部署

**What to build:** 改动上线，且线上可验证——用 editor 角色的登录凭证调 `GET /api/v1/items/` 从 403 变 200；
后台「API」分区与「登录凭证」面板照常工作；「API 凭证」页面已消失。

**Blocked by:** 03

**Status:** done (2026-09-24) — 部署成功 `Deployed and verified https://feed.881019.xyz`（4m10s，exit 0）；线上验证：editor 凭证 `GET /api/v1/items/{id}/` 由 403 → **200**，无凭证 401，`DELETE` 仍 403，`ext_api_access_log` 记 `content:article:read`

## Acceptance criteria

- [x] `yarn typecheck` 通过（= `yarn types && astro check && tsc --noEmit`；注意 `astro check` 覆盖测试）
- [x] `yarn test` 通过
- [x] `yarn i18n:check` 通过（若删除了界面文案，中英文键仍需一致）
- [x] 迁移在远程 D1 应用成功（`0053` 之后的下一号）
- [x] `manage deploy --instance ctwh-881019-xyz --yes` 成功，日志出现 `Deployed and verified https://feed.881019.xyz`
      （**不加** `env -u` 前缀——该前缀会致部署静默早退）
- [x] 线上验证：用 editor 角色的登录凭证调 `GET /api/v1/items/` 返回 200（改动前为 403）
- [x] 线上验证：`GET /api/v1/pages/`、`/api/v1/site-files/` 等上游端点行为与改动前一致
- [x] 线上验证：后台「API」菜单仍只有超级管理员可见
- [x] `ext_api_access_log` 新增记录中 `permission_code` 为 `content:*:*` 而非 `api:*`

## 备注

- 部署后按惯例复核 git 引用（本环境 git 提交会吃引用，见 `git-safe-commit`）。
- 不自动提交：按项目约定，提交需用户明确指示。
