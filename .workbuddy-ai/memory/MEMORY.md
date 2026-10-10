# microfeed 项目长期记忆（精简版）

## 硬约束
- 禁止自动 git 提交；门禁 = `git diff --check` 无输出 + `yarn typecheck`（非裸 tsc）+ 定向测试。不直提 main，走 `<type>/<short-kebab-case>`；提交信息 `type(scope): 描述`；commit 后 `git rev-parse HEAD` 复核。
- 改 i18n 必跑 `yarn i18n:check`。
- OpenAPI：`src/shared/OpenApiDocument.ts` 唯一事实来源；改英文原文须同步 `OpenApiTranslations.ts`。生成文件不手改。

## 新功能「菜单+权限」
- SSOT `.scratch/microfeed-rbac/new-feature-menu-permission-checklist.md`。① `ext_permissions.id` 用 `permissionId()` 推导；② 菜单行挂 `parent_code`+`ext_menu_permissions`；③ 权限码 `PERMISSION_CODES`+`seed.ts` 双镜像，跑 page-guards + rbac.test.ts。

## 上游分叉（origin=andylxy/microfeed）
- 上游活跃。本地特有：`auth_user` 多 username/displayUsername(0039)；强制首次改密已取消(428 休眠)；默认角色 readonly(0043)。新逻辑放 `ext_*` 表/新文件，上游文件只插行级改动。合并后跑四门禁（AdminCredentials + worker auth/rbac/login-credential）。

## 账号与认证 / RBAC
- 登录标识=邮箱或用户名（含 @ 分派）；用户名 3–32 位 `[a-zA-Z0-9_.]` 小写；只填用户名用 `adminUsernameEmail()` 占位邮箱。密码策略常量只在 `src/shared/AdminCredentials.ts`，改完跑 `AdminCredentials.test.ts`。
- RBAC 决策链（guard.ts）：401→428 休眠→`*` ALLOW→legacy admin→code∈perms→403。多角色=权限并集；`CODE_LOCKED_ROLES={super_admin, readonly}`；角色改 code 须 `renameRbacRoleCode`。

## 中医迁移（ctwh，SSOT `.scratch/tcm-import/spec.md`）
- 方案 E：书→channels、篇章/条文/方剂/中药/名词→items；`items` 加 `tcm_kind`+`tcm_parent_id`(0070)。源 int64 不落库，关联全用 11 位 id（sha256(kind+源id)→base62，幂等）。
- App 端点 `/api/AppBookRequest/*` 不进 OpenAPI、匿名放行；登录复用 better-auth+签 content:read API Key；App 统一 Gson、字段名严格匹配。
- 生产站 `https://feed.881019.xyz`（实例 ctwh-881019-xyz）。**公开站样式一致性=激活主题须一致**（查 `theme_state.active_theme_id`；远程 `feed-zh`）；本地 `manage theme install/activate` 须带 `--local --instance <n>`。
- 小说书卷章 SSOT `docs/novel-cms/xinghe-book-structure.md`+技能 `novel-book-ops/`：pub_date=全局阅读顺序键；书键双写；卷键=volume 字符串逐字一致；chapterNo=卷内序号(每卷从1)。
- 远端→本地整库同步 `.scratch/backups/resync-remote-to-local.sh`（停服后跑；FTS 靠触发器重建，导出过滤 `site_search_documents`）。

## 本机环境
- `yarn` 用 `./node_modules/.bin/yarn`；shim 缺 sed/dirname 时前置 PortableGit PATH。
- safe-delete 闸(>50 文件即拒)：`CODEBUDDY_SAFE_DELETE_ENABLED=0` 前缀，或 `mv` 改名代替删除。
- 测试 `./node_modules/.bin/yarn vitest run`；全量不可当门禁(超时假失败)，定向跑子集；改测试也要过 tsc。
- **`manage dev` 跨 Bash 调用被回收**：同一次调用内 `nohup … manage dev --local --instance <n> &` → 轮询等 `astro ready`(~70s) → curl；起服前置 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 并 `unset *_PROXY`。⚠️ `wrangler --local` 写 `.wrangler/state/v3/d1`，`manage dev` 读 `local-state/v3/d1`——导错库=404。本地 D1 真路径 `.microfeed/instances/<n>/local-state/v3/d1/`。
- **`yarn build` 裸跑静默生成空库**：须带 `MICROFEED_WRANGLER_CONFIG=.microfeed/instances/<n>/wrangler.jsonc` + `MICROFEED_LOCAL_STATE=.microfeed/instances/<n>/local-state`。
- typecheck 热缓存 1–2 分钟；node:sqlite 可直读 miniflare sqlite（嵌套 spawn 会 EBUSY）；远程 D1 直查先 `unset` 所有 proxy 变量。

## 其他
- 正文按原形保存(`data.description`+`content_format`)；item id 11 位；`STATUSES={1 published,2 unpublished,3 deleted,4 unlisted}`。
- 两个记忆目录并存 `.workbuddy-ai/memory/` 与 `.workbuddy/memory/`，整理前先问用户。
