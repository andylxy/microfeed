# 03: 删除 8 个 api:* 权限码与菜单绑定（ADR-0009）

**What to build:** 权限目录里不再出现 `api:*` 这类死码；「API」菜单的可见范围**与改动前完全一致**
（仍只有超级管理员可见），且不留死引用。**零新建权限码。**

**Blocked by:** 02（必须先切完授权码，此时已无代码引用 `api:*`）

**Status:** done (2026-09-24) — 迁移 0055 已建；远程 D1 核验随票据 04 部署后确认

## 要改的数据与常量

- [x] 新增迁移：删除 `ext_permissions` 中 8 行 `api:*`
      （`api:content:read/write`、`api:media:read/write`、`api:page:read/write`、`api:site:read/write`）
- [x] 新增迁移：删除 `ext_menu_permissions` 中 `menu_code='api'` 的 8 行 `api:*` 绑定，
      **保留** `system:api:manage` 那一行
- [x] `src/server/rbac/seed.ts`：移除 8 个 `api:*` 码定义
- [x] `src/shared/Constants.ts` 的 `PERMISSION_CODES`：移除 8 个 `API_*` 常量
      （**上游文件**：仅删我们加的行，不动上游原有常量）

## 为什么菜单可见范围不变（实施依据）

「API」菜单**本来就绑了 `system:api:manage`**（除 8 个 `api:*` 之外），且**没有任何角色持有
`system:*` 码**（只有 `super_admin` 的 `*` 通配）⇒ 删掉 8 行 `api:*` 后菜单仍由 `system:api:manage`
把关，可见范围不变，且不留死引用。

## Acceptance criteria

- [x] `yarn typecheck` + `yarn test` 通过
- [x] `tests/unit/admin-endpoint-guards.test.ts` 通过（它强制 `PERMISSION_CODES` 与 `rbac/seed.ts` 相等）
- [x] 迁移后在远程 D1 上核验：`SELECT code FROM ext_permissions WHERE code LIKE 'api:%'` 返回 0 行
- [x] 迁移后在远程 D1 上核验：`ext_menu_permissions` 中 `menu_code='api'` 只剩 `system:api:manage` 一行
- [x] 「API」菜单可见范围不变（仍只有 `super_admin` 可见）
- [x] 全局搜索确认 `api:content:` / `api:page:` / `api:site:` / `api:media:` 无残留引用
