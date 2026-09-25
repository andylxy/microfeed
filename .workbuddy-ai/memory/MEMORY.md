# microfeed 项目长期记忆

## 硬约束（门禁/提交/环境）
- 禁自动 git 提交；门禁 `git diff --check` 干净 + `yarn typecheck` + `yarn test`；不直接提交 `main`，用 `<type>/<kebab>` 分支。
- ⛔ `tsc --noEmit` 不是门禁，`yarn typecheck` 才是（`= yarn types && astro check && tsc --noEmit`；`manage deploy` 内部调它，只跑 tsc 会 3 分钟后失败）。
- i18n 改完跑 `yarn i18n:check`；i18n 只改显示绝不改逻辑（状态码/响应头/格式/控制流逐项核对 diff）；改 i18n 文案时旧英文断言需更新为 i18n 键。提交信息中文 `type(scope): 中文描述`。
- 每次 `git commit` 后必 `git rev-parse HEAD` 复核（必吃分支引用，从 reflog 重写）；走 `git-safe-commit` 技能。
- `yarn` 用 `./node_modules/.bin/yarn`（corepack 坏）；PATH 不全前置 `export PATH=...PortableGit.../usr/bin:.../bin:$PATH`。
- safe-delete 闸：每轮删 >50 即拒（打死 astro check/vite/pnpm）；对策改名代删（技能 `sandbox-safe-delete-guard`）。
- `manage deploy`：`CODEBUDDY_SAFE_DELETE_ENABLED=0 ./node_modules/.bin/yarn manage deploy --instance ctwh-881019-xyz --yes`；日志 `> .microfeed/deploy.log 2>&1`（别用 `| tail`）。runChecks: types→typecheck→test:deploy→build→迁移→上传。

## 上游归属判据（权威，2026-09-24）
- fork 自 microfeed/microfeed（origin=andylxy/microfeed）。`git merge-base main HEAD`==main ⇒ main 即 fork 点（`b510bb2` 2026-09-11）。
- 逐文件 `git cat-file -e main:<path>`（存在=上游，否则自研）；判目录 `git ls-tree main <dir>`。⛔ 别用功能分支 `git log --diff-filter=A`（拓扑误导）。交叉验证用 GitHub API 直查 microfeed/microfeed。
- 自研：`api-permissions.ts`、`credential-bearer.ts`、整个 `src/server/rbac/`、迁移 0035 起 `ext_*`；上游：`src/server/api/{access,api-keys,handlers,reference}.ts` + `src/shared/OAuth.ts`（API key + OAuth scope `content:read/write` + `integrationSuffix` 白名单 + `decideApiRequest`）。`Constants.ts` 上游有，`PERMISSION_CODES` 是插入级改动。
- 减分叉：优先官方插件；新逻辑放 `ext_*`/新文件；上游文件只做插入级；合并前先提交干净。

## 细粒度 RBAC（经 ADR-0008/0009 收敛）
- 不动 `auth_user`/`auth_session`/`createMicrofeedAuth`；新表全 `ext_`、序号≥0028；super_admin 通配 `*` 不可授予/删/改名。
- API 认证剩两条：① credential-bearer（`Bearer mflc_…`，`ext_login_credentials`，唯一在用）② 上游 legacy bearer（保留不动）。signed-call（X-Access-Key + api_keys + ext_api_key_owners + ApiCredentialsApp）ADR-0008 已删（表 `ext_api_key_owners`/`api_keys.secret_hash` 废弃不删）。
- API 授权码统一 `content:*:*`：`DOMAIN_RULES`（`api-permissions.ts` 自研）按路径前缀映射；`requiredApiPermission` fallback=`null`（未匹配路径不要求自研码，page/site/media 交还上游 scope 模型）。`api:*` 8 码已删。
- 决策链 guard.ts：401 未登录→banned→设备吊销→428 改密→`*` ALLOW→legacy admin→code∈perms→403；防重放 version→replay→permission。共享类型放 `src/shared/Rbac.ts`（浏览器禁导 `@/server/`）。用户 CRUD 走 Better Auth admin()，角色 CRUD 走 rbac-handlers.ts。

## 内容读 API（ADR-0006，2026-09-24 上线）
- 4 端点 `/api/v1/content/{categories,categories/{id}/books,books/{id}/chapters,chapters/{id}/}`，走 login-credential + `content:category:read`/`content:book:read`/`content:chapter:read`。迁移 0056 加 `items.book_id` 列+索引+回填；handler `src/server/api/content-read.ts`（自研），逻辑抽 `src/shared/content-catalog.ts`。
- 命名已统一：`content:article:*` 重命名 `content:chapter:*`（提交 6778b8d + 迁移 0057；路径 chapters / 码 chapter / 上游端点 items 三处仅剩上游 items 不同名）。
- 鉴权三态：legacy key→404 · 无凭证→401 · 凭证→200（middleware legacy 分支 `pathname.startsWith(${API_BASE_PATH}content/)`→404，防 legacy 凭证打 v1 路径绕 RBAC）。

## novel-cms 运维
- 主题存 D1：改 `themes/feed-zh/*` → `manage theme install` → `manage theme activate <uuid>`；仅路由/服务端改动才 deploy，先 deploy 再切主题。
- 远程 D1：`node node_modules/wrangler/bin/wrangler.js d1 execute ctwh-881019-xyz-db --remote --config .microfeed/instances/ctwh-881019-xyz/wrangler.jsonc --command "…"`（**必须内联字面量，不能用 `?` 占位符——wrangler CLI 不支持，报 SQLITE_ERROR 7500="Wrong number of parameter bindings"**）。
- item 正文存 `data.description`(HTML)；id 11 位；取整本书章节走 `getBookChapters(db,bookId,baseUrl)`。⚠️ `getBookChapters` 注释曾谎称"D1 拒绝嵌套 json_extract"——实测两种形式都成功，真实限制仅 JSON 路径无法走索引。分类 slug 多中文名（本草/内经类/伤寒）。

## OpenAPI 与 i18n
- `OpenApiDocument.ts` 唯一事实来源；改英文原文必须同步 `OpenApiTranslations.ts`（否则 `openapi.test.ts` 红三条）。键是精确英文原文（取 `JSON.stringify(OPENAPI_DOCUMENT.info.description)`）。

## 其他
- 菜单/RBAC 样板参 XiHan BasicApp（`D:\git\AiCode\XiHan.BasicApp`，菜单=数据表行+PermissionId 外键，Seeder 按 MenuCode 幂等落库）。
- 账号：登录标识邮箱或用户名（官方 username 插件，`auth_user` 多 username/displayUsername，迁移 0039）；密码策略取 `shared/AdminCredentials.ts` 常量（MIN=6/MAX=128 + 大小写混合||含数字），改只改常量+跑 `AdminCredentials.test.ts`。
## 新增/删除 `ext_menu` 菜单行必须同步的 5 处（2026-09-25 实测）
- 加一行菜单 = 改迁移后，还要同步：`ADMIN_MENU_CODES`（Constants.ts）、`ext_menu_permissions`（0052 建的映射表）、
  `src/shared/i18n/{en,zh-CN}.ts` 的 `menu.item.<code>` + `pageTitle`/`pageDocumentTitle`、以及**两个测试的期望数组**。
- ⚠️ 两处测试互不相同：`tests/unit/admin-page-guards.test.ts`（**891287c 起改为读 migrations 目录下全部文件**，
  不再只读 0041；且它对每行**无条件** `readFileSync(<path>/index.astro)`，所以**删页面文件而迁移里还留着 INSERT 会直接 ENOENT 抛错**
  ——删页必须同时让测试不再看到那行，或改测试识别后续迁移的 DELETE）
  与 `tests/worker/admin-menu.test.ts:267`（写死完整菜单顺序，0061/0062 后 expected 21 vs received 23 红；
  只删 rbac_permissions 也仍是 22 vs 21，因为期望数组连 `rbac_audit` 都没有，必须手动补）。
- ⛔ 删行与删码必须**原子**：`admin-menu.test.ts:71` 要求每个 ADMIN_MENU_CODES 都有 ext_menu 行（删 DB 行留常量=红，
  反之=红）；`:92-118` 要求每行绑的码在 `ext_permissions` 存在（删码留行=红）。
- 判据：`admin-page-guards.test.ts` 的红说明"页守卫用了没菜单绑的码"，`admin-menu.test.ts` 的红说明"菜单变了但测试没跟"。

- ⚠️ 两个并存记忆目录：`.workbuddy-ai/memory/`（本文件）与 `.workbuddy/memory/`（git 跟踪）都写，整理前先问用户勿合并/删任一方。
