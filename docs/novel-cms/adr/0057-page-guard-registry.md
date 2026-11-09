# ADR-0057: 后台页面守卫登记表 `ADMIN_PAGE_GUARDS`

- 状态：Accepted（2026-11-02 实施：新增 `src/shared/AdminPageGuards.ts`；`tests/unit/admin-page-guards.test.ts` 增「admin page guard catalog」分组）
- 日期：2026-11-02
- 关联：ADR-0038（自持权限树）、ADR-0041 / 0042（侧栏改读权限树、入口门码与路径）、ADR-0052（权限判定保持自研）、ADR-0053（权限快照）、ADR-0054（移除 `auth_user.role`）、`CONTEXT.md`（入口门码 / 侧栏数据源 / 权限判定）

## 背景

后台「某页要什么权限码」这件事，此前只能靠**打开那个页面文件**才知道：46 个后台 `.astro` 各自 inline 调用 `requirePagePermission(Astro.locals, PERMISSION_CODES.X, adminLanguage)`，码写在页面里，没有一处汇总。随之而来的三处分散：

| 分散点 | 规模（2026-11-02 实测） |
| --- | --- |
| 后台页面各自 inline 门码 | 46 个 `.astro`（36 个单行调用 + 10 个多行调用） |
| handler 分散 `requireRbac(…, PERMISSION_CODES.X, …)` | 6 个 `src/server/admin/*-handlers.ts` 调用，共 32 处（`rbac-handlers.ts` 一文件 17 处） |
| 权限码镜像 | 4 处（`src/shared/Constants.ts` / `src/server/rbac/seed.ts` / 迁移 SQL / `src/shared/RbacPermissionDocs.ts`） |

用户的实际痛点是「要找好多个文件才知道相关的内容、容易漏改」。页面守卫码这一环，既没有「一处查全」的入口，也没有「改了一页忘了别处」的提示——虽然 `tests/unit/admin-page-guards.test.ts` 已经把「页面守卫码 ⇔ 菜单行 `permission_code`」对齐了，但那份对齐靠**回放迁移 + 解析页面文件**，不是一份人能直接读的清单。

## 决策

1. **新增只读目录 `src/shared/AdminPageGuards.ts`**：`ADMIN_PAGE_GUARDS: Readonly<Record<string, PermissionCode>>`，键 = 相对 `[adminPath]` 的路由路径（无前导斜杠，与权限树页面节点 `path`、菜单行 `path` 的形状一致），值 = 该页守卫用的权限码，46 页全登记。
2. **运行时权威不动。** 各页面仍自己调 `requirePagePermission`，目录只是「人能读、测试能核对」的投影，不是执行入口。这与仓库已有的 `src/server/admin/pc-interfaces.ts`（端点 → 码的只读目录，运行时权威在路由文件）同构。
3. **测试双向锁。** `admin-page-guards.test.ts` 的「admin page guard catalog」分组断言三件事：目录覆盖每个守卫页（无漏记）、无孤儿条目（无多余）、目录大小 = 守卫页数。改页面守卫码而忘同步目录、或新增页面忘登记，都会直接红。目录因此不是「又一处会静默漂移的副本」，而是被测试钉住的清单。
4. **页面 → 表 的映射作为本 ADR 附录**（下节），不进运行时、不建新代码文件。它是「看一页就知道它动哪张表」的参考；若日后需要机器校验，再补一份 `AdminPageTables.ts`（同样只读 + 测试锁），本 ADR 不预先建它。

## 页面 → 表（每个后台表单的相关表）

按 `ADMIN_PAGE_GUARDS` 的 46 个键逐页列出。「相关表」取该页主实体及其直接读写的主表；一个页面跨多表时全部列出。**46 页全部至少读写一张表**（含 `settings` 承载的配置、`api_keys` 等）——没有「不碰表」的后台页。

另有 7 个后台页**不设门码、不在目录**：`index`（首页）、`login`、`login/set_password`、`account`、`forbidden`、`api/oauth`、`api/oauth/consent`——它们要么公开，要么只校验登录态（如 `account` 只验会话、`api/oauth` 是 302）。`forbidden` 的 `.astro` 只在注释里提到 `requirePagePermission`，不是调用。

| 页面（相对 `[adminPath]`） | 守卫码 | 相关表 |
| --- | --- | --- |
| `aliases` | `content:alias:read` | `ext_tcm_aliases` |
| `announcements` | `system:announcement:read` | `ext_app_announcement` |
| `annotation-markers` | `content:annotation-markers:manage` | `ext_annotation_markers` |
| `api` | `system:api:manage` | `api_keys` + `settings` |
| `api/auth` | `system:api:manage` | `api_keys` + `settings` |
| `api/explorer` | `system:api:manage` | `api_keys` + `settings` |
| `api/settings` | `system:api:manage` | `settings` |
| `app-about` | `system:app-about:read` | `ext_app_about_info` |
| `app-versions` | `system:app-version:read` | `ext_app_version` + `ext_app_rollout` |
| `audit` | `content:audit:read` | `ext_content_audit` + `ext_content_review` + `items` |
| `audit/[itemId]` | `content:audit:read` | `ext_content_audit` + `ext_content_review` + `items` |
| `books` | `content:book:read` | `channels` + `items` + `ext_book_stats` + `ext_marker_citations` + `ext_marker_citation_state` |
| `cache` | `system:cache:manage` | `settings`（`category='app_cache_control'`） |
| `categories` | `content:category:read` | `ext_category` + `channels` |
| `channels/primary` | `content:channel:manage` | `channels` |
| `cloud-usage` | `system:cloud-usage:read` | `ext_cloud_usage_token` |
| `devices` | `system:device:read` | `ext_user_devices` |
| `fangs` | `content:fang:read` | `items`（`tcm_kind='fang'`）+ `channels` + `ext_category` |
| `items/[itemId]` | `content:chapter:read` | `items` |
| `items/list` | `content:chapter:read` | `items` |
| `items/new` | `content:chapter:read` | `items` |
| `login-logs` | `system:login-log:read` | `ext_app_login_log` |
| `login-methods` | `system:app-login-methods:read` | `settings`（`category='app_login_methods'`） |
| `pages` | `content:page:manage` | `pages` + `page_paths` |
| `pages/[pageId]` | `content:page:manage` | `pages` + `page_paths` |
| `pages/new` | `content:page:manage` | `pages` + `page_paths` |
| `rbac` | `system:role:manage` | `ext_roles` + `ext_permissions` + `ext_role_permissions` + `ext_user_roles` + `ext_permission_nodes` + `ext_user_permissions` + `ext_rbac_audit` |
| `rbac/audit` | `system:role:manage` | `ext_rbac_audit` |
| `review` | `content:review:manage` | `items` + `ext_content_review` |
| `review/[itemId]` | `content:review:manage` | `items` + `ext_content_review` |
| `settings` | `content:settings:manage` | `settings` |
| `settings/code-editor` | `content:settings:manage` | `settings`（`category='customCode'`） |
| `settings/themes` | `content:settings:manage` | `themes` + `theme_drafts` + `theme_state` |
| `settings/themes/drafts/[draftId]` | `content:settings:manage` | `theme_drafts` |
| `site-files` | `content:site_file:manage` | `site_files` |
| `site-files/[siteFileId]` | `content:site_file:manage` | `site_files` |
| `site-files/new` | `content:site_file:manage` | `site_files` |
| `term` | `content:term:read` | `items`（`tcm_kind='term'`）+ `channels` |
| `users` | `system:user:manage` | `auth_user` + `auth_account` + `auth_session` + `ext_user_roles` + `ext_user_permissions` + `ext_login_credentials` + `ext_user_devices` |
| `volumes` | `content:volume:read` | `items` + `channels` + `ext_category` |
| `webhooks` | `system:webhook:manage` | `webhook_endpoints` |
| `webhooks/deliveries` | `system:webhook:manage` | `webhook_deliveries` |
| `webhooks/endpoints` | `system:webhook:manage` | `webhook_endpoints` |
| `webhooks/events` | `system:webhook:manage` | `webhook_endpoints` + `webhook_deliveries` + `webhook_daily_usage` |
| `yao` | `content:yao:read` | `items`（`tcm_kind='yao'`）+ `channels` |

## 表 → 字段（守卫链相关表）

守卫链 = 账号闸门（`guard.ts` 第 1–5 步）→ 权限判定（第 6–8 步）→ 侧栏可见性。下面按层列出涉及的 12 张表，字段取与判定相关的部分；完整字段见 `docs/zh/12-user-system-schema.md` 对应章节。

### 账号闸门层

#### `auth_user`（Better Auth 核心表）
| 字段 | 说明 |
| --- | --- |
| `id` | 账号唯一 ID（主键） |
| `email` / `username` | 登录标识（邮箱或用户名） |
| `banned` | 1 = 封禁，守卫第 2 步 401 |
| `banReason` / `banExpires` | 封禁原因 / 到期时刻（读路径不做「过期即解封」比较） |
| `signup_source` | 注册来源 `email`/`qq`/`admin`（建号后不可改） |
| `role` | **已废止**（0163 清空，ADR-0054），不参与任何判定 |

#### `auth_session`（Better Auth 会话）
| 字段 | 说明 |
| --- | --- |
| `id` | 会话 ID |
| `userId` | 归属账号 |
| `expiresAt` | 过期时刻 |

#### `ext_user_security`
| 字段 | 说明 |
| --- | --- |
| `user_id` | 账号（主键） |
| `must_change_password` | 1 = 待改密，守卫第 5 步 428（现休眠，无写入点） |

#### `ext_user_devices`
| 字段 | 说明 |
| --- | --- |
| `user_id` + `device_id` | 复合主键 |
| `status` | `active` / `revoked`；`revoked` 走守卫第 3 步 401 |
| `last_seen_at` | 最近活跃（5 分钟写节流，不解除吊销） |
| `created_at` | 登记时刻 |

### RBAC 授权层（真源 + 物化）

#### `ext_roles`
| 字段 | 说明 |
| --- | --- |
| `id` | 主键，形如 `r_<code>` |
| `code` | 角色码（UNIQUE） |
| `name` | 角色名 |
| `allow_admin_login` | 1 = 允许进后台（守卫第 4 步） |
| `is_member` | 1 = 会员档（App 内容分档，后台不读） |
| `created_at` / `updated_at` | |

#### `ext_permissions`
| 字段 | 说明 |
| --- | --- |
| `id` | 主键 `p_<code>`（`permissionId(code)` 推导） |
| `code` | 权限码 `module:resource:action`（UNIQUE） |
| `name` | 中文名 |

#### `ext_role_permissions`
| 字段 | 说明 |
| --- | --- |
| `role_id` | FK→`ext_roles`（CASCADE） |
| `permission_id` | FK→`ext_permissions`（CASCADE） |

#### `ext_user_roles`
| 字段 | 说明 |
| --- | --- |
| `user_id` | FK→`auth_user`（CASCADE） |
| `role_id` | FK→`ext_roles`（CASCADE） |

#### `ext_user_permissions`（权限快照，ADR-0053）
| 字段 | 说明 |
| --- | --- |
| `user_id` | 主键，FK→`auth_user` |
| `codes` | JSON 数组 = 多角色权限并集 |
| `is_member` | 会员并集 |
| `admin_login_allowed` | 后台准入并集 |
| `updated_at` | 重算时刻 |

### 菜单 / 权限树 / 审计层

#### `ext_permission_nodes`（权限树，ADR-0038 / 0039 / 0041 / 0042）
| 字段 | 说明 |
| --- | --- |
| `id` | 主键 `pn_*` |
| `code` | 节点码（UNIQUE） |
| `kind` | `group` / `page` / `code` |
| `parent_code` | 父节点码 |
| `permission_code` | 关联权限码 |
| `audience` | `desktop` / `app` |
| `path` | 页面入口路径 |
| `entry_code` | 页面节点绑定的门码——侧栏可见性判据，与页面守卫同一把锁 |
| `name_zh` / `name_en` | 展示名 |
| `icon` / `i18n_key` | 图标 / 文案键 |
| `is_visible` | 1 = 进侧栏 |
| `sort` | 排序 |
| `source` | 来源标记 |
| `created_at_ms` | 创建时刻 |

#### `ext_menu`（已下线，0168 删除）

| 字段 | 说明 |
| --- | --- |
| `id` / `code` / `parent_code` / `path` / `i18n_key` / `icon` / `permission_code` / `sort` / `is_visible` / `name_zh` / `name_en` | 0041 建表，0127 权限树自持后侧栏不再读它；**0168 已 `DROP TABLE`**，见本 ADR 后果节 |

原表结构（供读旧迁移时对照）：`id` 主键、`code` UNIQUE、`parent_code`、`path`、`i18n_key`、`icon`、`permission_code`、`sort`、`is_visible`、`created_at_ms`，0125 增 `name_zh` / `name_en`。

下线时的状态：`src/` 下**零条 SQL 语句**读写这张表（只有注释提及）；最后一个读者是迁移 `0133` 的一次性回填（`SET path = (SELECT m.path FROM ext_menu m …)`），它按 `code = 'page_' || m.code` 把 25 个配对页的 `path` / `entry_code` 抄进节点表，此后节点表自持。删除前本地快照 36 行（6 个分组 + 29 个可见页面行 + 1 个不可见行），与 `ext_permission_nodes` 的桌面页面行零漂移。快照清单里仍保留 `durable` 条目（见后果节）。

#### `ext_rbac_audit`
| 字段 | 说明 |
| --- | --- |
| `id` | 主键 |
| `actor_user_id` | 操作者账号 |
| `actor_label` | 操作者展示名（冗余，账号删除后仍可读） |
| `action` | 动作 |
| `target` | 目标（角色码 / 账号） |
| `detail` / `before_detail` | 变更后 / 变更前 |
| `created_at_ms` | 操作时刻 |

## 范围之外

- **不改任何页面守卫码。** 目录里的值是从 46 个页面现有调用抄来的，改的是「在哪查」，不是「判什么」；判定链 `rbacAllows` / `permissionsInclude` 一行不动。
- **不把目录变成执行入口。** 页面仍自己调 `requirePagePermission`，不从目录读码。把权威搬进目录要改 46 个页面，且把一个静态常量变成一层间接——收益（少一处重复）抵不过改动面。
- **页面 → 表 映射不进代码。** 本轮只写进本 ADR；要机器校验时再补 `AdminPageTables.ts`（只读 + 测试锁），触发条件：该映射出现第一次真实漂移（页面改表而 ADR 没跟上）。
- **方向 2（权限码单一镜像）、方向 3（菜单模块收敛）、方向 4（快照重算收敛）不做**，见会话记录：2/3 属中大型重构，留待真实需求；4 已有 `permission-snapshot.test.ts` 语法树锁住 9 个写点，动了风险高于收益。

  方向 2 暂缓的依据不是「加码不常发生」——实测有 29 个迁移写过 `ext_permissions`，0119–0154 期间 5 个迁移各加 1 个码；依据是**四条边都已被测试钉住**，漏改会立刻红而不会静默漂移：常量 ↔ SQL 由 `tests/unit/admin-endpoint-guards.test.ts`「keeps PERMISSION_CODES equal to the SQL permission catalog」比对，SQL ↔ 库 ↔ 种子由 `tests/worker/rbac.test.ts`「keeps the SQL seed in sync with the code catalog」比对，种子 ↔ 说明由 `tests/unit/shared/rbac-permission-docs.test.ts` 双向比对。方向 2 解决的是**工效**（加一码要动 4 个文件），不是正确性。

  重评触发条件（任一成立即重新评估，不设频次阈值——加码是持续行为，频次阈值会恒真而失去意义）：出现一次真实漏改并造成 403 或侧栏缺项；权限码超过 80（现 65）；出现第 5 处镜像，或某处镜像无法被测试覆盖。

## 后果

- 「某页要什么码」从「翻 46 个页面文件」降为「读一张表」；新增页面时忘记登记，catalog 测试直接报路径。
- 目录是**投影**而非真源，所以它必须与页面同批改。测试保证「不一致就红」，代价是每次改守卫码要动两处（页面 + 目录）——这是刻意的：第二处正是「让人能查」的那一处。
- 不引入任何运行时依赖：`AdminPageGuards.ts` 只 import `Constants.ts` 的 `PERMISSION_CODES` 与 `PermissionCode` 类型，没有 D1、没有 `cloudflare:workers`，可在 shared 层被任意端引用。
- **页面 → 表 附录会漂移。** 它是文档，不受测试保护；页面改了主表而没更新 ADR 时不会报错。这是本轮明确接受的取舍——把它写进 ADR 是为了「先有」，不是为了「永不漂移」。
- **「表 → 字段」是节选副本。** 它取 `docs/zh/12-user-system-schema.md` §2 / §5.1 的判定相关字段，12 分册为单源；两者不一致时以 12 分册为准。
- 与 `pc-interfaces.ts` 形成一对：端点 → 码（PC 接口目录）与页面 → 码（页面目录），两者都是「只读目录 + 测试防漂移 + 运行时权威在别处」的同一形态。

### `ext_menu` 已下线（0168）

这张表在 0168 之前**已无运行时读者**（`src/` 零条 SQL 触及，最后一个读者是 0133 的一次性回填），只被 4 处测试当比对基准读。`migrations/0168_cleanup_drop_ext_menu.sql` 物理删除，含完整 `-- rollback:` 块——它从 `ext_permission_nodes` 的桌面页面行反推重建 `ext_menu` 的页面行与分组行，所以回滚是本迁移的产物还原，不是另造结构。

四处同步改动（实际做的事，与最初的评估有出入）：

| 处 | 改动 |
| --- | --- |
| `migrations/0168_cleanup_drop_ext_menu.sql` | `DROP TABLE IF EXISTS "ext_menu";`，`type = cleanup`，带反推式回滚块 |
| `manage-cli/lib/snapshot.ts` | **保留** `durable` 里的 `"ext_menu"` 条目，加注释说明理由（见下） |
| `tests/worker/admin-menu.test.ts` | 三条 seed 用例改读 `ext_permission_nodes`；「菜单行镜像为页面节点」那条删掉——被镜像的一方已不存在，前提由 0133 固化 |
| `tests/unit/admin-page-guards.test.ts` | 重放器改成推 `ext_permission_nodes`，并按 0133 的真实语义回放 `ext_menu`（在 0168 的 `DROP` 之前菜单行仍然活着） |

**`snapshot.ts` 为什么保留条目**：最初计划是「跟着删」，但 `assertClassifiedTables` 是**拒绝未登记表**的，且 0041→0168 之间的任何一张中间版本快照里 `ext_menu` 都还在。删掉条目会让那些快照恢复时报「未登记的表」，而不是让新快照顺利过。清单要覆盖的是**所有可能出现的表**，不是「当前 schema 的表」。这与已删的 `api_keys_hashed`、`ext_menu_permissions` 保留条目的处理一致。

**`ext_permission_nodes` 的重放器为什么还要认 `ext_menu`**：0133 的 `entry_code` 值来自菜单行的 `permission_code`（`books` → `content:book:read`），不是从页面名推导出来的。测试按迁移顺序回放到 0133 时，菜单行还没被 0168 删，所以必须在内存里也回放一遍 `ext_menu`，读到 `DROP TABLE ext_menu` 时再清空。只按 `page_<code>` 命名推测会让 `page_books` 绑 `content:book:read` 之外的码，或让 `page_media` 误绑一个码。

**收益**：删掉一张 36 行、零读者的表，及其在快照/恢复链路上的一段历史包袱。不减少任何每次请求的成本（它本来就不在热路径上）。副作用是「读旧迁移时要对照的表少了一张」，所以本 ADR 保留了它的原结构。

## 被否决的替代方案

| 方案 | 否决理由 |
| --- | --- |
| 页面从目录取码（目录变权威） | 要改 46 个页面文件；把「读一个静态常量」变成一层间接；收益只是消掉「页面里的码」这一处重复，而测试本来就能发现不一致 |
| 从页面文件自动生成目录 | 每次改页要跑生成器，且仓库对「生成文件不手改」有约定，生成链本身是一笔新债；手写 + 测试锁更简单 |
| 不做，维持现状 | 用户痛点原样保留：查一页的门码仍要打开页面文件，新增页忘登记也无人提醒 |
| 把页面 → 表 映射也做成测试锁定的代码文件 | 本轮 Q2 选 ADR；映射的稳定性远低于守卫码（数据模型改得比权限码勤），先写成文档、等出现真实漂移再固化，避免过早加锁 |
