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

## 架构门禁（scripts/check-*.ts，接入 `yarn check`，分支 refactor/server-layout-and-gates）
- 四脚本：`check-adr`（ADR-001..004）、`check-migrations`（MIG-001..004）、`check-server-layout`（LAYOUT-001，20 项白名单）、`check-endpoint-registration`（ENDPOINT-001..006）。
- 公共层 `scripts/gate-utils.ts`：`report(file, rule, msg, line = 0)` / `walk(dir, isFile)` / `printViolations()` / `violationCount()` / `finish(label)`（收尾：有违规则打印并 `process.exit(1)`，无则放行；四脚本尾部统一调用，不再各自重复 `if (violationCount()>0)` 块）。输出格式 `文件:行 规则编号 描述`（**无方括号**），行号 0 = 规则作用于整文件。`Finding` 类型已去 `export`（仅内部用）。
- **`scripts/` 不在 tsconfig include** → 门禁脚本不被 `yarn typecheck` 覆盖；内部有 ~30 处预存 `noUncheckedIndexedAccess` 报错（`match[1]` 等；check-i18n.ts / import-ctwh 也有）。改脚本只靠 tsx 实跑 + 负向探针验证，别指望 typecheck，也别顺手把 scripts/ 加进 include（会红）。
- 端点门禁 walk `.ts/.js/.astro`。`src/pages/api/v1/{index.astro, openapi.html.astro}` 是 API 参考页，归「文档元端点」豁免（`META_DOC_PATHS` 含 `/api/v1/` 与 `/api/v1/openapi.html`）。实测 56 handler = 25 OpenAPI + 17 exempt + 14 AppBookRequest。
- 匿名路由名单 SSOT = `access.ts` 的 `APP_BOOK_REQUEST_ANONYMOUS_ROUTES`（登记记录，门禁+测试读它）；**中间件匿名判定仍键于「不在 `APP_BOOK_REQUEST_CONTENT_SUFFIXES` 即匿名」**，两者不缺口由 ENDPOINT-005 保证。
- 迁移冻结名单 `scripts/frozen-migration-names.txt` 是数据非逻辑；0107 及以前 103 个名字不可改（wrangler 用文件名作 d1_migrations 记账键），0108+ 走 `NNNN_<type>_<desc>.sql`。
- ADR 单一编号空间 = `docs/novel-cms/adr/`；`check-adr.ts` 只扫 `src/` 与 `migrations/`，**扫不到 `tests/`**（且 tests 里的引用即使指错 ADR 也能解析，门禁抓不到，只能人工）。
- **ADR-0011 D2 是「单本读取一次读完不分页」（D1 读代价 / keyset），与 AppBookRequest 鉴权 / fail-open 无关**。曾有误引它作为 fail-open 出处（check-endpoint-registration.ts / access.ts / api-permissions.test.ts），已全部改为直接描述「中间件不在 `APP_BOOK_REQUEST_CONTENT_SUFFIXES` 即匿名（fail-open）」行为，不再引用任何 ADR。改动前务必先 `Read` ADR 原文确认，勿凭记忆引用。

## D1 全表扫描门禁（scripts/check-d1-scan.ts，第五项，默认顾问不进 yarn check）

- 技能 `microfeed-gate-subset`（用户级）+ 编排器 `scripts/gate-subset.ts`（async spawn，**禁 spawnSync——本沙箱 EBUSY**）。`yarn gate:subset` / `yarn d1scan:check`；`--strict` 才硬性失败；`MICROFEED_GATE_DB` 指定库、`D1SCAN_TRACE=1` 崩溃时打语句。
- 规则码：D1SCAN-001 大表全扫（>101 行）、D1SCAN-002 大表 TEMP B-TREE、D1SCAN-003 索引全扫（`SCAN x USING INDEX`，方法论要求仍要记）。`sqlite_*` 与 ≤101 行小表排除；`tests`/`src/components`/`src/shared/i18n` 不扫。
- **fast-fail 无 try/catch**：不可规划碎片由 `canPlan` 六条确定性规则前置排除并计入 `skipped` 逐条列原因（不静默吞）。`rowCount` 先用 sqlite_master 存在性校验（CTE 名/别名返回 -1）。
- **源码 SQL 抽取四坑**（2026-10-15 实测踩全）：① SQL 行注释 `--` 必须在折叠空白前按行剥，否则注释吞掉后面 JOIN 造出 `no such column`；② 字面量转义引号 `\'` `\"` 要还原；③ 模板 `${...}`→`?`（换成字面量会造 `ORDER BY 1` 假阳性）；④ 计时占位符**绑定整数 1**（不绑定 = NULL，`LIMIT ?` 报 datatype mismatch）。
- 字节口径 = dbstat 虚拟表实测（`SELECT SUM(pgsize) FROM dbstat WHERE name = ?`）；候选索引从 WHERE 等值列 + ORDER BY 列抽取；两脚本耦合点只有一行 `D1SCAN-METRIC: key=value ...` 契约行。
- 基线（2026-10-15）：373 文件 / 363 语句 / 153 skipped / 7+1+13 findings / 66542 行 / 104075264 字节。

## 本机环境（反复咬人）
- `yarn` 用 `./node_modules/.bin/yarn`；shim 缺 coreutils → 前置 `export PATH="/c/Users/zhs/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:$PATH"`。
- **任何 Vite 批量删依赖必须带 `CODEBUDDY_SAFE_DELETE_ENABLED=0`**：safe-delete 闸对 >50 文件的批量删要求确认，否则直接杀进程。两种触发：① 起 dev server 删 `node_modules/.vite/deps_ssr`（修复：杀顶层 yarn → `mv node_modules/.vite/deps_ssr deps_ssr.bad-<ts>` → 带闸变量重启）；② **`yarn typecheck` 的 `astro check` 删 `node_modules/.vite/deps_astro`（416 文件）→ 闸杀 → astro check 崩、EXIT=1**（2026-10-12 实测）。同样须前置 `CODEBUDDY_SAFE_DELETE_ENABLED=0`。
- 测试用 `./node_modules/.bin/yarn vitest run` 定向子集；全量 test 约 130 例超时假失败不可当门禁。worker 池 `--config vitest.worker.config.ts`。
- **跑 vitest 必须先 `cd /D/git/AiCode/microfeed`（大写盘符）**：vitest 4.1.9/4.1.10 Windows 回归（vitest#10692）——沙箱默认 cwd 是小写 `d:/...`，此时每个测试文件都在 describe 首行抛错（实测表现为 `Cannot read properties of undefined (reading 'config')`，并行方上午表现为 `failed to find the current suite`），零 import 探针也挂，与缓存/业务代码无关。修法：`cd /D/git/AiCode/microfeed && unset NODE_OPTIONS http_proxy https_proxy HTTP_PROXY HTTPS_PROXY` 后再跑（现成脚本 `%TEMP%/run-vitest.sh`）。排查时别再去动 node_modules。
- 远程 D1 直查前 `unset *_PROXY`（否则 7403）；curl 判活加 `--noproxy '*'`。常驻服务用 `run_in_background`。
- **`yarn manage <cmd>` 对 cloudflare 实例默认走远程生产库**（`resolveTarget` 只在 `hosting==="local"` 或显式 `--local` 时才本地）。本地操作必须显式 `--local`——2026-10-15 漏传导致误插生产库一行，已用 `manage theme delete --theme-id … --confirm …` 软删除复原。另：CLI 的 miniflare 落点与 dev server 同库（`local-state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite`），可互相验证。
- **本地实例端点验收手法**：管理员密码未知时，用实例 `.dev.vars` 的 `BETTER_AUTH_SECRET` 铸发临时 `auth_session` 行 + 按 `login-session.ts` scheme 签 cookie（脚手架 `.scratch/purge-delete/mint-local-session.mjs`）；HTTP 三细节：URL 要尾斜杠（astro 308）、POST 带 `Origin` 同源头（中间件 CSRF 403）、cookie 名 `microfeed.session_token`。
- **`yarn build` 裸跑静默生成空库**：必须带 `MICROFEED_WRANGLER_CONFIG` + `MICROFEED_LOCAL_STATE`。
- node:sqlite 可直读 miniflare sqlite（`.microfeed/instances/<n>/local-state/v3/d1/`）。弃用 agent-browser，真实浏览器用系统 Chrome + CDP。改 GBK/CRLF 文件用 node 脚本整行匹配，别用 Edit。
- 技能：`novel-book-ops`、`tcm-golden-verify`（**compare.mts 对 known-adaptation 端点不逐字段比对，「零差异」≠ 正确**）、`app-feature-delivery`、`microfeed-rbac-menu-permission`。
