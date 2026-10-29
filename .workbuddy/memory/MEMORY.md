# microfeed 长期记忆（细节见每日日志 `.workbuddy/memory/2026-*.md` 与技能）

> 只留跨会话结构事实与坑；基线数字、过程记录都在日志里。

## 硬约束
- **禁自动 git 提交**（沙箱搬走 `.git/refs`）；提交前门禁 = `git diff --check` + `yarn typecheck`（非裸 tsc，须带 `CODEBUDDY_SAFE_DELETE_ENABLED=0`）+ 定向测试。不提交 `main`，走 `<type>/<short-kebab-case>` 分支，中文 `type(scope): 描述`。
- 改 i18n 跑 `yarn i18n:check`。注释**禁「拆」「落」「死」「栈」「契约」「偏」等字、禁「要…而不是…」句式**（评审当硬违规；新写注释连标点一起扫）。
- OpenAPI：`OpenApiDocument.ts` 唯一事实来源，生成文件不手改。后台列表分页走 `normalizeAdminItemListLimit(webSettings.itemsPerPage)` + `itemsPerPage` prop。

## 菜单+权限（SSOT：`.scratch/microfeed-rbac/new-feature-menu-permission-checklist.md`）
① `ext_permissions.id` 用 `permissionId()` 推导；② 菜单行靠 `ext_menu.permission_code` 直列 gate（`ext_menu_permissions` 已退役、`src/` 零读）；③ 新权限码三镜像 = `Constants.ts` + `rbac/seed.ts` + migration，且在 `ext_permission_nodes` 加 `kind='code'` 节点挂到 page 下（ADR-0038 自持树，三层：group→page→code，根层只放 group）；跑 page-guards + endpoint-guards + `rbac.test.ts`。

## 上游分叉 & 认证
origin=andylxy/microfeed 活跃，合并后跑四门禁。本地特有：`auth_user` 多 `username`、默认角色 `readonly`。新逻辑放 `ext_*`/新文件，上游文件只做插行级改动。登录=邮箱或用户名；用户名 3–32 位 `[a-zA-Z0-9_.]` 存小写。RBAC：401→428→`*`→legacy admin→code∈perms→403；多角色并集；`CODE_LOCKED_ROLES={super_admin, readonly}`。

## 中医迁移（ctwh，分支 feature/tcm-note-admin-fields）
SSOT：`.scratch/tcm-import/spec.md`；技能 `tcm-golden-verify`、`novel-book-ops`。
- 方案 E：书→channels、条目→items + `tcm_kind`/`tcm_parent_id`；源 int64 不入库，关联用 11 位确定性 id。
- 两套书模型（判别 `items WHERE book_id=? AND tcm_kind IS NOT NULL`）：小说卷=`_microfeed.volume` 标签；TCM 卷=`tcm_kind='chapter'` 实体靠 `tcm_parent_id`，`patchChapter` 不持久化 volume 须直接 SQL。
- 坑：① 方剂 `book_id`=真实书、过滤按 `_microfeed.sourceBookId`，repour 后跑 `import-yao.mjs --apply` + `backfill-tcm-volume.mjs`；② 方剂 `yaoId` off-by-one（源 bug）+1 补偿；③ 排序真键=`_microfeed.no`；④ 条文 unlisted(4) 显示「已发布」，禁改 status=1。
- App 契约：Gson 无 @SerializedName；`signatureId`=篇章 11 位 id；App 端点不进 OpenAPI；wire 信封 `{code:200,data,msg}`。golden 工具 `golden/{capture,compare}.mts`（compare 对 known-adaptation 不逐字段比对，「零差异」≠ 正确）。

## 架构门禁（scripts/check-*.ts）
- 四脚本：check-adr / check-migrations / check-server-layout（21 项白名单）/ check-endpoint-registration；公共层 `scripts/gate-utils.ts`。**`scripts/` 不在 tsconfig include**，门禁脚本不被 typecheck 覆盖（预存一批 `noUncheckedIndexedAccess` 报错），改脚本只靠 tsx 实跑 + 负向探针。
- 端点分类实测：56 handler = 25 OpenAPI + 17 exempt + 14 AppBookRequest；匿名名单 SSOT = `access.ts` 的 `APP_BOOK_REQUEST_ANONYMOUS_ROUTES`；中间件匿名判定键于「不在 `APP_BOOK_REQUEST_CONTENT_SUFFIXES` 即匿名（fail-open）」——**描述该行为禁引 ADR**。
- 迁移冻结名单 `scripts/frozen-migration-names.txt`：0107 及以前 103 个名字不可改（wrangler 以文件名记账）；0108+ 走 `NNNN_<type>_<desc>.sql`。ADR 单一编号空间 = `docs/novel-cms/adr/`，check-adr 扫不到 `tests/`。

## D1 扫描门禁（scripts/check-d1-scan.ts，默认顾问）
- 技能 `microfeed-gate-subset` + 编排器 `scripts/gate-subset.ts`（async spawn，禁 spawnSync——沙箱 EBUSY）。规则码：001 大表全扫 / 002 TEMP B-TREE / 003 索引全扫。基线数字见每日日志。
- 源码 SQL 抽取四坑：① 行注释 `--` 须在折叠空白前按行剥；② 字面量转义引号要还原；③ 模板 `${...}`→`?`；④ 计时占位符绑定整数 1。
- 两条库事实：`sqlite_stat1` 不存在（勿补 ANALYZE）；本地 `items.status` distinct=1（删索引前必须远程复核分布）。
- typeahead 已用派生 FTS5 表 `ext_admin_typeahead` 根治（不进迁移）；**快照还原时 `buildRestoreSql()` 须在 schemaSql 与 dataSql 之间执行 `DROP_ADMIN_TYPEAHEAD_INDEX_SQL`**。`// d1scan:ignore` 靠行号匹配，块注释会被压成一行致豁免失效，SQL 常量附近只用 `//` 注释。A/B 测量必须两个库各开独立连接。

## 本机环境
- `yarn` 用 `./node_modules/.bin/yarn`，前置 `export PATH="/c/Users/zhs/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:$PATH"`（shim 缺 coreutils）。
- **`CODEBUDDY_SAFE_DELETE_ENABLED=0`**：dev server 与 `yarn typecheck`（astro check 删 deps_astro）都会因 >50 文件批量删被闸杀。
- 跑 vitest 先 `cd /D/git/AiCode/microfeed`（大写盘符，小写必挂）+ `unset NODE_OPTIONS *_PROXY`。**两套 config 不能混**：`tests/unit` 用默认 `vitest.config.ts`（加 `--pool=vmForks` 会让 `.vue`/SFC 类用例报 `Cannot use import statement outside a module`）；`tests/worker`（workerd/D1）用 `--config vitest.worker.config.ts`，**在沙箱里能跑**。默认 config 全量 `tests/unit`：1647 过 / 7 红（全在 cli+manage-cli，原因 `ENOTEMPTY` + 超时；**串行 `--no-file-parallelism` 复跑这两个目录 400/400 全绿**，故属并发抖动）；`tests/worker`：623 过 / 11 红（items/content 的 TCM 支线）。这两批是当前基线，别当自己的回归——看到 cli/manage-cli 红灯先串行复跑再判。
- **本地库手工补列必须同步补 wrangler 记账**：`d1_migrations` 插同名行，否则 `manage dev` 每次启动的 `applyLocalMigrations` 重放该迁移报 `duplicate column name`，dev server 起不来、页面 500。实例库在 `.microfeed/instances/<name>/local-state/v3/d1/miniflare-D1DatabaseObject/*.sqlite`。
- `yarn manage <cmd>` 对 cloudflare 实例默认走**远程生产库**，本地操作必须显式 `--local`。远程 D1 直查前 `unset *_PROXY`。

## RBAC 权限管理单页（ADR-0039 + 0131 修订，桌面/App 按 `audience` 分区，2026-10-20）
- `ext_permission_nodes.audience` 是分区唯一依据；`ext_permissions` 不加列，码的归属由它那条 `kind='code'` 叶子推导（`audienceOf()`）。三镜像 = 0130/0131 SQL ≡ `seed.ts` ≡ `Constants.ts`。
- **0131 起单页口径**：`/admin/rbac/` 一页 = 顶部角色条 + 合成分类层（PC 端管理/App 端管理，不入库）+ 树上勾选即点即存（复用 role-permissions 端点）+ 每层手风琴；`rbac/desktop`、`rbac/app`、`RBAC_APP`、`rbac_app` 菜单行已退役；App 分类可见性由服务端判定（持 `system:app-capability:manage` 才传 appBoard 与 appInterfaces，与 App 端四端点守卫一致，不留可见性破窗——旧口径「持任一 `app:` 码或本码」已于 2026-10-21 收紧）。接口清单融进树形：码结点下挂只读叶子，App 18 行推导自 `app-interfaces.ts`，PC 端 = `pc-interfaces.ts` 静态目录 + `pc-interfaces.test.ts` 防漂移（两跳导入扫描；**动态段 `[x]` 是目录**）。
- **角色 CRUD 只在「管理角色」弹窗**（`RoleManagerDialog`，照用户管理页两栏：左列表 + 右详情）；角色条 chips 只做选择。`super_admin`/`readonly` 的改码与删除前后端都禁。**base-ui Dialog 走 Portal，`renderToStaticMarkup` 渲不出来**，静态测试只能测导出的 `RoleManagerPanels`。
- **App 码一门一用途（0131）**：`app:mobile:access` 退役 → nav/style/chapter/content/fang/zhongyao 六新码 + GetAllMingCi 归 `app:mingci:view`；`DOMAIN_RULES` 逐端点列举无兜底（fail-closed）；search-permission 外门 = `readAnyOf` 任一双码门（`requiredApiPermission` 返回 `string|readonly string[]|null`）；授权等价映射 = 旧码持有者获 7 新码。App 板 11 码 / 树 15 行，desktop 78 行。
- **板子租约必须放行 `*`**：grants 裁剪写成 `LEFT JOIN ext_permission_nodes n ... WHERE p.code = '*' OR n.audience = ?`。只写 `JOIN ... kind='code'` 会把 super_admin 的 `*` 一起裁掉（`*` 没有节点叶子），板子上变成空权限——唯一防线是 `rbac.test.ts` 的 `superAdmin.permissions === ['*']`。
- 端点分派：`requireAudienceGuard(locals, audience, request, db)`，desktop→`system:role:manage`、app→`system:app-capability:manage`；作用于权限树 list/save/export（端走 `?audience=`，保存走请求体）+ 角色授权 `role-permissions`（端走请求体）。**端缺席一律 400**。角色 CRUD 仍只认 desktop 码。
- `replaceRolePermissions` 的删除按端作用域（子查询 `n.audience = ?`），无作用域会清掉 editor/readonly 的 2 条 app 码。
- 迁移重放测试（page-guards / endpoint-guards）**先剥 `--` 行注释**再匹配，否则 rollback 块会被当真语句执行；SQL 目录抽取器认 `DELETE ... code IN (...)` / `LIKE 'p%'` / `= 'x'` 三种形态（2026-10-21 补了单数等号，0135 退役删除用的就是它）。`hasGuard` 正则必须含 `requireAudienceGuard(`。
- `manage-cli/lib/snapshot.ts` 的 `SNAPSHOT_TABLES.durable` 必须含 `ext_permission_nodes`（0128 建表，漏登记会让快照直接拒绝创建）。
- **`adminUrl()` 会按整串末尾补斜杠**：查询串写进参数会得到 `…?audience=desktop/`（斜杠混进值里）→ 服务端判不出端回 400。查询串一律拼在 `adminUrl()` **之外**；`ADMIN_URLS.ajaxRbacPermissionTree/Export` 曾踩此坑，`StringUtils.test.ts` 有回归钉子。

## 管理后台菜单（三级注入 + 顶层手风琴，2026-10-19）
- `src/client/menu-open-state.ts` 是展开态唯一 store（模块级 + `useSyncExternalStore` + 按账号 localStorage）；`AdminSidebar` 的 `withPageSections` + `SUB_SECTION_BUILDERS` 注册表注入第三级（settings 走 hash、api/webhooks 走子页 URL），新增域只加一行。**`transition:persist` 岛屿不更新 props**，侧栏不能加 persist；`useSyncExternalStore` 第三参须同 getSnapshot（renderToStaticMarkup 否则崩）；`bindMenuAccount` 渲染前同步执行（同账号只读一次存储，测试换账号键）。
- 设置页四项能力：`settings-section-state.ts`（当前分区 store，不持久化）+ `settings-section-nav.ts`（滚动观察 + document 捕获点击：平滑滚动 + replaceState + 卸载清理）；**replaceState 不触发 hashchange，跨岛同步只能走 store**。搜索框在正文顶部（复用 `filterAdminSettingsSections`，只切 `display:none`；有查询时回车跳首个命中）。`AdminSettingsScroll.ts` 的 `activeAnchorSectionId`（阈值判定、滚到底取最后一个**可见**分区、跳过 height=0）与 `observeScrollAndResize`（rAF 节流观察器）设置页与账户页共用。
- `menu.icon.*` 动态键门禁：check-i18n.ts 按 `MENU_ICON_NAMES` 枚举，新图标名必须同批补双语标签。

## 本地 D1 → 远程 D1 同步（标准分册 `docs/agents/d1-sync.md`，8 节）
- 工具：`.scratch/backups/reconcile-local-remote.mjs`（默认 counts、`--deep`，退出码 0 一致 / 1 有差异 / 2 前置失败；**counts 模式也跑 2 次 `theme_state → themes` 引用检查**，故 1 不等于只有行数差异）、`sync-tables.mjs`（`--dry-run`，每次运行按 1,000 行一页读整表快照；只支持单表名，**不支持 `--skip/--replace`**）、`.scratch/d1-sync-20261026/push-known-rows.mjs`（`--skip=N --replace`，目标行写死在脚本内 `PLAN` 常量，按单列主键绑定，只适用 `items`）。
- `sync-tables.mjs:292` 对**远程独有主键**生成 `DELETE`：推 `channels` 会删掉远程的 `tcmfang0001`（`status=3`，本地无此行），三选一表态时必须一并说明。
- 台账差 2 的成因（2026-10-27 查明）：本地 `d1_migrations` 150 行、`migrations/` 目录 148 个文件，多出的 2 条是历史重编号残留（id=118 `0122_data_map_app_read_codes_to_operations_menu.sql`、id=144 `0146_schema_app_request_quota.sql`），反方向为 0。
- 读量口径：参与核对 74 张表合计 **54,290 行**（全库 76 张 54,441 − `d1_migrations` 150 − `_cf_METADATA` 1，派生 28,821 与 items 9,506 已含在内，别重复相加）；deep 当前 32 张集合实测 **10,349 行 / 152 次**（13,208 / 157 是移出 5 张豁免表前的旧口径）。
- `items` 整表重推 = 9,506 × 31.82 ≈ 302,481 行写 = 3.02 个日写额度 ⇒ 任何整表重推都不做；`ENV_BOUND` 5 张（`ext_cloud_usage_token`、`webhook_endpoints`、`microfeed_installation`、`api_keys`、`ext_login_credentials`）覆盖即毁生产密钥与身份。
- **`rows_written` 把索引条目一并计费**（2026-10-27 实测）：`channels` 12 条语句（6 删 6 插）= **60 行写**，不是「每行 3 行写」算的 18；`UPDATE channels SET data=json_set(...)` 报 **3 行**（`channels_genre_mirror_after_update` 又重算 `genre`）。写量预估一律以首批回报外推。实测口径：counts 44,219 读 / items dry-run 54,506 / deep 54,545；全轮账户级读 147,197（2.94%）、写 67（0.067%）。
- **「行数相同、内容不同」counts 查不出**，只有 dry-run 与 deep 能报：`channels` 13=13 而远程拿 `tcmfang0001` 顶了本地 `_WgpmyEc5Ze`；`auth_account` 4=4 而管理员口令与 `updatedAt` 格式（本地 epoch 整数 / 远程 ISO 串）都不同。行数全 OK 不等于同步完成。
- 2026-10-27 终态：远程主频道行 = `_WgpmyEc5Ze`，`data.link` 已改写为 `https://feed.881019.xyz`（`title` 仍「肘后斋」，本地仍指内网 192.168.2.158）⇒ 该行永久不等，deep 报 MISMATCH 属已知例外；`tcmfang0001` 已删；`auth_account` 口令未换，同样记为已知例外。deep 退出码 1 时先看真不一致项是否只有这两条。
- 用量查询 GraphQL 的 `accounts` 过滤器现要 `accountTag: "<id>"`（`account_id_in` 报 `filter: accountTag: not a string`），数据集用 `d1AnalyticsAdaptiveGroups` 按 `dimensions.databaseId` 分组；旧探针 `d1-sync-20261026/probe-usage-graphql.mjs` 已失效，用 `d1-sync-20261027/probe-usage-today.mjs`。
