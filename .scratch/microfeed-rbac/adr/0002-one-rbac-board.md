# 角色与授权是一个页面，`system:permission:manage` 合并回 `system:role:manage`

## 背景

功能审计的 B27 记录了一个真实错配：`ext_menu.permission_code` 一行只绑一个码，
`rbac` 菜单行绑 `system:role:manage`，而保存角色授权的
`POST /ajax/rbac/role-permissions` 要求 `system:permission:manage`。只持有后者的
账号没有任何导航入口，能改的东西却正是它。

当时的落地方式（迁移 0061）是"新增一行菜单 + 新增一个同码守卫的页"：
`/admin/rbac/` 与 `/admin/rbac/permissions/` 两个页面，各自绑一个码。选择它的
理由是不放宽校验，保持"一菜单一码"。

结果是**两个页面渲染出完全相同的界面**：两者都是 `readRbacBoard()` 加
`<RbacApp>`（后来共同抽到 `RbacBoardPage.astro`），差异只有守卫码、`activeNavItem`
和标题文案。`RbacApp` 只接收 `initialBoard`，完全不感知查看者权限，所以它永远
渲染同一套「角色列表 + 新建/重命名/删除角色 + 完整权限树 + 保存」。

更关键的是这并没有造出可用的"半个管理员"：角色 CRUD 四个端点全部要求
`system:role:manage`，保存授权要求 `system:permission:manage`。于是

- 只持 `role:manage` 的账号：能进 `/admin/rbac/`，保存授权 403；
- 只持 `permission:manage` 的账号：能进 `/admin/rbac/permissions/`，角色 CRUD 403。

复制了页面，没有复制能力。

线上实测（2026-09-25）进一步说明这个角色形态从未存在：`system:role:manage` 与
`system:permission:manage` 的 `ext_role_permissions` 行数都是 **0**，系统/账户区
实际只有 `super_admin` 通过 `*` 通配可达。重复页唯一的现实后果，是超级管理员在
侧边栏看到两条入口，点进去是同一屏。

## 决定

**只保留 `/admin/rbac/` 一个页面，删除 `/admin/rbac/permissions/`。**
`system:permission:manage` 合并回 `system:role:manage`——所有 RBAC 端点（读 board、
角色 CRUD、保存授权）统一由 `system:role:manage` 把守。

由迁移 0065 落地：删 `ext_menu` 的 `rbac_permissions` 行、删退休码的
`ext_permissions` 与 `ext_menu_permissions` 行、`users` 的 sort 还原。
代码侧同步删除 `PERMISSION_CODES.SYSTEM_PERMISSION_MANAGE`、
`ADMIN_MENU_CODES.RBAC_PERMISSIONS` 与三个 i18n 键。

## 考虑过的替代

- **保留两页，让 `RbacApp` 按权限裁剪**（无 `role:manage` 隐藏角色 CRUD，无
  `permission:manage` 树只读）：保住了"权限专管员"这个角色形态，也是当初拆两个码
  的本意。放弃了，因为该形态从未被授予过任何角色，而现在要为它维护一个"同一个
  组件的两种受限形态"，成本落在每个后来读这段代码的人身上。若将来真出现这个需求，
  应按此方案重新拆码并做裁剪——那时它有真实使用者。
- **一行菜单绑两个码**：`ext_menu.permission_code` 的设计（迁移 0041 头注释）明确
  是"一行最多一个码；需要多个就造一个组合码"。改它会动摇菜单可见性的判据。
  合并成一个码正是该注释指引的方向。
- **保留两页不动**：把"两个入口、同一屏、各有一半按钮 403"留在生产。不可接受。

## 后果

- **放弃了"只能改授权、不能建删角色"的管理员形态。** 这是本次决定唯一不可逆的
  部分：恢复它需要重新拆码、重新做组件裁剪，并再写一次迁移。
- 超级管理员（持 `*`）的能力不减反增：原来在 `/admin/rbac/` 保存授权会 403，
  现在一页内可完成全部操作。侧边栏「账户」分组少一项。
- 权限树里 `system:role:manage` 只出现一次（挂在 `rbac` 页）。0063/0064 曾让它在
  `rbac` 与 `rbac_audit` 下各出现一次。
- 页面守卫与端点守卫口径一致，不再存在"页守卫只要 `permission:manage` 却 SSR
  返回全量 board"的侧门。
- 顺带删除了死代码：`GET /ajax/rbac`（`getAdminRbacBoard`）与
  `ADMIN_URLS.ajaxRbacBoard` 全仓零调用——board 由页面服务端直读，客户端只 POST。
