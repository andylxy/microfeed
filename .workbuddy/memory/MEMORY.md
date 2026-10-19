# microfeed 长期记忆（细节见每日日志 `.workbuddy/memory/2026-*.md` 与技能）

> 只留跨会话结构事实与坑；基线数字、过程记录都在日志里。

## 硬约束
- **禁自动 git 提交**（沙箱搬走 `.git/refs`）；提交前门禁 = `git diff --check` + `yarn typecheck`（非裸 tsc，须带 `CODEBUDDY_SAFE_DELETE_ENABLED=0`）+ 定向测试。不提交 `main`，走 `<type>/<short-kebab-case>` 分支，中文 `type(scope): 描述`。
- 改 i18n 跑 `yarn i18n:check`。注释**禁「拆」「落」「死」「栈」「契约」「偏」等字、禁「要…而不是…」句式**（评审当硬违规；新写注释连标点一起扫）。
- OpenAPI：`OpenApiDocument.ts` 唯一事实来源，生成文件不手改。后台列表分页走 `normalizeAdminItemListLimit(webSettings.itemsPerPage)` + `itemsPerPage` prop。

## 菜单+权限（SSOT：`.scratch/microfeed-rbac/new-feature-menu-permission-checklist.md`）
① `ext_permissions.id` 用 `permissionId()` 推导；② 菜单行挂 `parent_code` + `ext_menu_permissions`；③ 权限码三镜像 = `Constants.ts` + `rbac/seed.ts` + migration；跑 page-guards + endpoint-guards + `rbac.test.ts`。

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
- 跑 vitest 先 `cd /D/git/AiCode/microfeed`（大写盘符，小写必挂）+ `unset NODE_OPTIONS *_PROXY`。全量 test 约 130 例超时假失败，不可当门禁。
- `yarn manage <cmd>` 对 cloudflare 实例默认走**远程生产库**，本地操作必须显式 `--local`。远程 D1 直查前 `unset *_PROXY`。

## 管理后台菜单（三级注入 + 顶层手风琴，2026-10-19）
- `src/client/menu-open-state.ts` 是展开态唯一 store（模块级 + `useSyncExternalStore` + 按账号 localStorage）；`AdminSidebar` 的 `withPageSections` + `SUB_SECTION_BUILDERS` 注册表注入第三级（settings 走 hash、api/webhooks 走子页 URL），新增域只加一行。**`transition:persist` 岛屿不更新 props**，侧栏不能加 persist；`useSyncExternalStore` 第三参须同 getSnapshot（renderToStaticMarkup 否则崩）；`bindMenuAccount` 渲染前同步执行（同账号只读一次存储，测试换账号键）。
- 设置页四项能力：`settings-section-state.ts`（当前分区 store，不持久化）+ `settings-section-nav.ts`（滚动观察 + document 捕获点击：平滑滚动 + replaceState + 卸载清理）；**replaceState 不触发 hashchange，跨岛同步只能走 store**。搜索框在正文顶部（复用 `filterAdminSettingsSections`，只切 `display:none`；有查询时回车跳首个命中）。`AdminSettingsScroll.ts` 的 `activeAnchorSectionId`（阈值判定、滚到底取最后一个**可见**分区、跳过 height=0）与 `observeScrollAndResize`（rAF 节流观察器）设置页与账户页共用。
- `menu.icon.*` 动态键门禁：check-i18n.ts 按 `MENU_ICON_NAMES` 枚举，新图标名必须同批补双语标签。
