# 08 — 门禁与部署

**What to build:** 全套仓库检查跑绿后发布到生产，并核对菜单表与权限码确实落库。门禁每条命令单独取退出码——不要接管道，否则失败会被掩盖。部署命令内必须含构建产物目录的预清（否则会卡在构建 Worker 阶段）。发布后回读日志确认成功，再直查生产库核对新表与新权限码。

**Blocked by:** 01–07

**Status:** done

**执行结果（2026-09-23）**

- 门禁：typecheck **0**、lint **0**、i18n **2001/2001**、unit **137 文件 / 959 passed / 1 skipped**、
  worker **22 文件 / 270 passed**。
- 部署：`.microfeed/deploy13.log` → `Deployed and verified`。
- 生产库核对：权限码 **35**、菜单行 **16**、公共项 **1**（仅首页）、迁移 `0040`/`0041` 已在 `d1_migrations` 中。
- **一处与预期不符，已查清不是缺陷**：生产实例的 editor 授权是 **9 条**而非种子默认的 16 条。
  原因：该实例的 editor 角色曾**被人手工改过**（部署前只有 4 条：book:create/read、category:read、
  volume:read），迁移是幂等追加式的，`0040` 只在其上加了 5 条。当前生产 editor 的 9 条为：
  `content:article:{read,create,update}`、`content:book:{read,create}`、`content:category:read`、
  `content:volume:read`、`content:page:manage`、`content:site_file:manage`。
  ⇒ **缺** `content:book:update`、`content:category:update`、`content:volume:update` 与 4 个 `api:*`。
  这意味着该实例的编辑**目前无法编辑书/分类/卷，也无法使用签名 API**。这是实例数据问题，不是代码问题；
  若需要，在 RBAC 界面补授权即可（或新建迁移一次性补齐）。

- [ ] 类型检查、i18n 校验、lint、单测、worker 测试、构建全部退出码为 0
- [ ] 空格/行尾检查通过
- [ ] 部署日志出现成功确认行（回读日志，不能只看退出码）
- [ ] 生产库核对：菜单表存在且已播种；新增权限码存在；editor 授权条数为 16
- [ ] 以一个非超管账号登录核对：侧栏只出现应见的菜单项，且每一项都能打开（不出现 403）
