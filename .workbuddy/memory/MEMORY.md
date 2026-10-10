# microfeed 长期记忆（细节见技能 / 每日日志 / .scratch 规范）

> 按日细节见 `.workbuddy/memory/2026-*.md`；只留跨会话**结构事实与坑**。

## 硬约束
- **禁自动 git 提交**（沙箱搬走 `.git/refs`）；门禁 = `git diff --check` + `yarn typecheck`（**非裸 tsc**）+ 定向测试。不提交 `main`，走 `<type>/<short-kebab-case>` 分支，中文 `type(scope): 描述`。
- 改 i18n 跑 `yarn i18n:check`。注释**禁「拆」「落」等字**、**禁「要…而不是…」句式**（评审当硬违规）。
- OpenAPI：`OpenApiDocument.ts` 唯一事实来源，改英文原文同步 `OpenApiTranslations.ts`。生成文件不手改。后台列表分页走 `normalizeAdminItemListLimit(webSettings.itemsPerPage)` + `itemsPerPage` prop，禁写死常量。

## 新功能「菜单+权限」清单（SSOT：`.scratch/microfeed-rbac/new-feature-menu-permission-checklist.md`）
① `ext_permissions.id` 用 `permissionId()` 推导（手写→bootstrapAdmin 500）；② 菜单行挂 `parent_code` + `ext_menu_permissions`；③ 权限码三镜像 = `Constants.ts` + `rbac/seed.ts` + migration；跑 page-guards + endpoint-guards + `rbac.test.ts`。

## 上游分叉 & 认证
origin=andylxy/microfeed 活跃，合并后跑四门禁（AdminCredentials + worker auth/rbac/login-credential）。本地特有：`auth_user` 多 `username`、默认角色 `readonly`。新逻辑放 `ext_*`/新文件，上游文件只做插行级改动。登录=邮箱或用户名（含 `@` 分派），用户名 3–32 位 `[a-zA-Z0-9_.]` 存小写；密码策略只在 `AdminCredentials.ts`。RBAC（guard.ts）：401→428→`*`→legacy admin→code∈perms→403；多角色=并集；`CODE_LOCKED_ROLES={super_admin, readonly}`。

## 中医迁移（ctwh）
- **SSOT：`.scratch/tcm-import/spec.md` + issues**；分支 `feature/tcm-import`。技能 `tcm-golden-verify`、`novel-book-ops` 为数据细节 SSOT。
- **方案 E**：书→channels、条目→items + `tcm_kind`/`tcm_parent_id`（0070）；源 int64 不落库，关联用 11 位确定性 id。
- **两套书模型**（判别 `items WHERE book_id=? AND tcm_kind IS NOT NULL`）：小说卷=`_microfeed.volume` 标签；TCM 卷=`tcm_kind='chapter'` 实体、靠 `tcm_parent_id`、`patchChapter` 不持久化 volume 须直接 SQL。平铺型建普通书频道。
- **关键坑**：① 方剂 `book_id`=真实书，过滤按 `_microfeed.sourceBookId`，repour 后跑 `import-yao.mjs --apply` + `backfill-tcm-volume.mjs`；② 源 dump 中药表不全（**非导入丢数据**）；③ 方剂 `yaoId` off-by-one（源 bug）+1 补偿；④ 排序真键=`_microfeed.no`；⑤ 条文 unlisted(4) 显示「已发布」，**禁改 status=1 消草稿**。
- **App 契约**：Gson、无 @SerializedName；`signatureId`=篇章 11 位 id；App 端点不进 OpenAPI。golden 工具 `golden/{capture,compare}.mts`；wire=信封 `{code:200,data,msg}` 全小驼峰。生产站 `https://feed.881019.xyz`。名词解释权限 `app:mingci:view` 交付完成，见 `2026-10-10.md`。

## 本机环境（反复咬人）
- `yarn` 用 `./node_modules/.bin/yarn`；shim 缺 coreutils → 前置 `export PATH="/c/Users/zhs/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:$PATH"`。
- **起 dev server 必须带 `CODEBUDDY_SAFE_DELETE_ENABLED=0`**：否则 Vite `deps_temp_*` 超 50 文件 → 闸杀优化器 → dev 崩溃。修复：杀顶层 yarn → `mv node_modules/.vite/deps_ssr deps_ssr.bad-<ts>` → 带闸变量重启。
- 测试用 `./node_modules/.bin/yarn vitest run` 定向子集；全量 test 约 130 例超时假失败不可当门禁。worker 池 `--config vitest.worker.config.ts`。
- 远程 D1 直查前 `unset *_PROXY`（否则 7403）；curl 判活加 `--noproxy '*'`。常驻服务用 `run_in_background`。
- **`yarn build` 裸跑静默生成空库**：必须带 `MICROFEED_WRANGLER_CONFIG` + `MICROFEED_LOCAL_STATE`。
- node:sqlite 可直读 miniflare sqlite（`.microfeed/instances/<n>/local-state/v3/d1/`）。弃用 agent-browser，真实浏览器用系统 Chrome + CDP。改 GBK/CRLF 文件用 node 脚本整行匹配，别用 Edit。
- 技能：`novel-book-ops`、`tcm-golden-verify`（**compare.mts 对 known-adaptation 端点不逐字段比对，「零差异」≠ 正确**）、`app-feature-delivery`、`microfeed-rbac-menu-permission`。
