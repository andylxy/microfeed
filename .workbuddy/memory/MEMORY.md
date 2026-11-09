# microfeed 长期记忆

> 只留跨会话仍成立的规则与陷阱；过程细节（实施轮次、数字底稿、工单）在 `.workbuddy/memory/2026-*.md` 与 `.scratch/`。写新条目先并入既有节。

## 硬约束
- 普通任务不跑 `yarn test/typecheck/check`、`scripts/check-*`、构建、dev server；**测试只写不跑**，门禁只在用户手动触发 `.microfeed-gate-subset` 时按其范围执行，不自行扩大。不起 dev server 做端到端实测；代价数字用只读探针。
- 提交前 `git diff --check` 无输出；不提交 `main`、不自动建分支/提交/push；分支 `<type>/<short-kebab-case>`；中文单行 `type(scope): 描述`；改 i18n 须 `yarn i18n:check`。
- 注释禁「要…而不是…」「不是…而是…」与黑话「落地/钉死/对齐」；中文注释、术语保留英文。fast-fail：不捕获错误、不做 fallback；禁 mock/伪造/workaround；禁程序化改代码（heredoc/python/sed）；不长命令 inline；临时文件放 `.agent-tmp/` 用完删。
- 不写断言 `docs/` / README 散文的单测，文档校验走 `yarn docs:check`。OpenAPI 唯一真源 `OpenApiDocument.ts`，生成文件不手改；后台分页 `normalizeAdminItemListLimit(webSettings.itemsPerPage)`。
- 上游 origin=andylxy/microfeed 活跃：新逻辑放 `ext_*`/新文件，上游文件只做插行级改动；方案明确授权的前台页面改写属例外。
- 参考页面/链接必须读全（含子组件、布局、样式、数据来源）；不绕行既有依赖、禁造轮子；禁 ASCII Art（用 mermaid）。新增功能先查重再扩展最后新建（09 册 §0）；**加页面 ≠ 加权限码**（AGENTS.md）。

## RBAC 与权限快照
- 登录=邮箱或用户名（3–32 位 `[a-zA-Z0-9_.]` 存小写），多角色并集；401→428→`*`→code∈perms→403；`CODE_LOCKED_ROLES={super_admin, readonly}`；legacy admin 旁路已删。
- **权限码三镜像** = `Constants.ts` + `rbac/seed.ts` + migration，并在 `ext_permission_nodes` 加 `kind='code'` 叶子挂 page 下（ADR-0038）。`ext_permissions.id` = `p_` + code 冒号换下划线。侧栏/菜单码由 `ext_permission_nodes` 驱动：`page_<x>` 去前缀即 `ADMIN_MENU_CODES.<X>`；`audience` 是 PC/App 分区唯一依据。
- `requireAudienceGuard`：desktop→`system:role:manage`、app→`system:app-capability:manage`，端缺席 400；`replaceRolePermissions` 删除须带端作用域。
- **板子租约必须放行 `*`**：`LEFT JOIN … WHERE p.code='*' OR n.audience=?`；写死 `JOIN kind='code'` 会裁掉 `*`，防线是 `rbac.test.ts` 的 `superAdmin.permissions === ['*']`。角色 CRUD 只在 `RoleManagerDialog`；super_admin/readonly 改码与删除前后端都禁（base-ui Dialog 走 Portal，`renderToStaticMarkup` 渲不出）。
- 快照 `ext_user_permissions`（`codes`/`is_member`/`admin_login_allowed`）唯一入口 `rbac/snapshot.ts`；**改真源的 9 个写入点须同批 `db.batch` 重算**（replaceRolePermissions / replaceUserRoles / setRbacRoleAdminLogin / setRbacRoleMember / 后台建号 / bootstrap / password-setup / seedRbac / 删账号），漏一处权限永久陈旧；`permission-snapshot.test.ts` 扫语法树报漏调。
- **`banned` 不可物化**（点查 `auth_user LEFT JOIN ext_user_security`）；三处登录闸门同判据（admin-signin / credential-login / middleware）；零角色账号无快照行 → 拒进后台。
- `is_member` 是产品策略不是权限码；0162 回填须 `FILTER (WHERE p.code IS NOT NULL)`；0045 是已删覆盖层、0162 才是快照。`SNAPSHOT_TABLES.durable/ephemeral` 必须登记新表（`ext_captcha_nonce` 属 ephemeral）。迁移重放测试先剥 `--` 行注释；`adminUrl()` 按整串末尾补斜杠，查询串拼在外面。

## 架构门禁
- 四脚本 check-adr / check-migrations / check-server-layout / check-endpoint-registration，公共层 `gate-utils.ts`；**新增 `src/server/<feature>/` 必须加 `WHITELIST`**（`catalog` 已登记）。`scripts/` 不在 tsconfig include，只靠 tsx 实跑 + 负向探针。
- `check-front-site-decoupling.ts`（ADR-0066，`DECOUPLE-001`～`006`）**手动触发、不并入 `yarn check` 与 `gate-subset`**。判定顺序：先按原始行剔 `front-decoupling:ignore-*` 区段 → 再剥注释；禁用词边界排除连字符；`DECOUPLE-003` 按函数体判定，`FROM ${` 动态表名拒收，301 只认重定向语义。
- 端点 56 handler = 25 OpenAPI + 17 exempt + 14 AppBookRequest；匿名名单 SSOT = `access.ts` 的 `APP_BOOK_REQUEST_ANONYMOUS_ROUTES`；ajax 后台端点走 `requireRbac`。
- 迁移命名 `NNNN_<type>_<desc>.sql`；冻结名单只到 0107，MIG-004 只 `data`/`cleanup` 要 `-- rollback:`。ADR 状态只有 `Accepted`(+括注) / `Proposed`。D1 扫描顾问模式（`gate-subset.ts` 用 async spawn，禁 spawnSync）；SQL 抽取四坑 = 行注释在折叠空白前剥、转义引号还原、`${...}`→`?`、计时占位符绑整数 1；库里无 `sqlite_stat1`。
- typeahead 用派生 FTS5 `ext_admin_typeahead`（不进迁移）；`buildRestoreSql()` 须在 schemaSql 与 dataSql 之间执行 `DROP_ADMIN_TYPEAHEAD_INDEX_SQL`；`// d1scan:ignore` 靠行号匹配。

## 独立模块范式（book-info / ming-ci / zhong_yao / book_chapter / fang_yao / yao_alia）
- 都不碰 items/channels，并行共存、互不迁移。层：`shared/<X>.ts`（Zod 真源）→ `server/<mod>/{types,store,handlers}`（types 只暴露 `prepare`；store 纯读写；handlers 校验 + `randomShortUUID()`）→ `pages/[adminPath]/ajax/<mod>/`（requireRbac）→ `<mod>/index.astro` + `components/admin/<mod>/*App.tsx`。
- 横切必补：`Constants.ts`、`rbac/seed.ts`、`AdminPageGuards.ts`、`StringUtils.ts`、`i18n/{zh-CN,en}.ts`（**双语键数相等**）、`check-server-layout` 白名单、`SNAPSHOT_TABLES`；`menu.item.*` 与 `ADMIN_MENU_CODES` 一一对应。
- 两步删除：软删 `deleted_at` → 物删只对已软删（409 `purgeNeedsDelete`），独立 `/purge`；排序 `MAX+1` + UNIQUE 兜底。**D1 100KB 护栏**：单条 SQL 约 100KB 上限，种子拆批 INSERT，`INSERT OR IGNORE` 只播不覆盖。
- **前台零耦合**（ADR-0066，已实施 12/12）：前台 SQL 不得出现 `items`/`channels`/`ext_category`/`ext_book_stats`/`ext_book_status`；可见性只看 `deleted_at`，书级另加 `book_info.hot_book = 0`（0173，0 公开/1 隐藏/2 会员）。旧地址一律失效，不补 `legacy_item_id`、不建重定向表、不写 301。条目页 `/zhongyao/<id>`、`/fang-yao/<id>`、`/ming-ci/<id>`；分类地址段是 `book_groups.key`。
- 前台正文与链接：`bencao_yao_name` 非空才拼 `section_note`；`book_chapter_body` 全序键只有 `receipt_no`；`ext_annotation_markers.link_type` 是前台唯一允许读的 `ext_*`（`f`=方剂、`u`=中药、`g`=名词只上色、`$a`=按语）；`listTermsByBook` 已删、`getTermEntry` 保留。`ensureMarkerCitations` 留在 `markerPopover.ts` 末尾 `front-decoupling:ignore-start/end` 区段（后台仍导入），前台不调用。
- 两处已知例外：`src/middleware.ts:485` 每非 App 请求仍 `loadFeed`；`robots.txt` 经 `publicSiteFileResponse → loadPublishedFeed`。站点文件收口：sitemap→`catalog/sitemap`、`rss`/`json`/`llms*` 八文件删除、`[...path]` 下线、`404` 接住后台 404 分支（`AdminShell`，注入缺失时抛 `adminContextUninitialized`）。
- 各模块细节（book-info `case_division`、ming-ci `$m{}/$n{}/$x{}/$a{}`、zhong_yao ADR-0061、book_chapter 两表、fang_yao ADR-0065）与量化底稿 `.scratch/catalog-audit/`、工单 `.scratch/front-site-catalog-switch/issues/` 见每日日志；0189 是唯一 `data` 迁移（4 键复制进 `settings.webGlobalSettings`，缺键不写）。

## 格式保真（ADR-0062 D7）与中医迁移
- 导入不 trim / 不 strip / 不归一换行 / 不折叠空白（前导缩进、句号后空格、真实换行、字面 CR 都是内容）。正文走参数化脚本、不进迁移 SQL；自检须字节级逐行 LENGTH + LF/CR/前导缩进/行尾空格与源对齐，fail-fast；「行尾空格」口径 = `col != RTRIM(col)`，落库后按自然键与源逐行 `===` 对账。
- ctwh SSOT `.scratch/tcm-import/spec.md`；方案 E 书→channels、条目→items + `tcm_kind`/`tcm_parent_id`；排序真键 `_microfeed.no`；App 信封 `{code:200,data,msg}`，golden「零差异」≠ 正确。其余迁移坑见每日日志。

## 本地 D1 与同步
- 真库 `.microfeed/instances/<name>/local-state/v3/d1/miniflare-D1DatabaseObject/*.sqlite`（`manage dev` 用）；裸 `wrangler d1 --local` 走 `.wrangler/state/`。操作实例库**必须同时带 `--persist-to` 与 instance 的 `--config`**（根 `wrangler.jsonc` 无 `database_id`，只带 `--persist-to` 会另建空壳库）。多 sqlite 并存按 `d1_migrations` 记录数取最大者；WAL 未 checkpoint 他连接看不到。
- 真库基线 `items=9506` / `migCount=180` / `MAX(name)=0182_seed_book_chapter_rows.sql`；错库 `items=18` / `migCount≈176`。`yarn manage <cmd>` 默认走**远程生产库**，本地须 `--local`；`snapshotSql` 跳过生成列（hidden=0）。
- 远程同步（`docs/agents/d1-sync.md`）：counts 查不出「行数相同内容不同」；`sync-tables.mjs` 对**远程独有主键**生成 DELETE（推 channels 会删远程数据），只支持单表。`ENV_BOUND` 5 张覆盖即毁生产密钥；`items` 整表重推 ≈ 3 个日写额度。永久例外 = 远程主频道 `_WgpmyEc5Ze` 的 `data.link` 与 `auth_account` 口令。用量 GraphQL `accounts` 过滤器要 `accountTag`。

## 后台 UI 范式
- 双栏列表页：`AdminTreeNavLayout`（零业务）+ `AdminGroupTree`（受控，分组与计数由调用方算好）。`subgroups?` 递归下钻；多层键须加前缀；`emptyTreeText` 走递归 `hasVisibleLeaves`；`AdminTreeLeaf.description` 是叶子主行外的补充信息。卷章页三层树（ADR-0063）：`source_book_id → book_info.id → case_division`。
- 间距：卡片 `rounded-[14px] border bg-card p-5 text-card-foreground shadow-xs`；标题 `<h2 class="text-lg font-semibold">`；字段网格 `grid grid-cols-1 gap-4 md:grid-cols-2`；分组间 `mt-5`。5 个后台 App 的 `formToPayload()` 统一签名 `Record<string, unknown>`。
- `menu-open-state.ts` 是展开态唯一 store；`transition:persist` 岛屿不更新 props；设置页 replaceState 不触发 hashchange，跨岛同步走 store。单测 D1 假实现「每文件自带一份」是全仓约定，收口票 `.scratch/sqlite-test-double/`。

## 本机环境
- `yarn` 用 `./node_modules/.bin/yarn`，前置 `export PATH="/c/Users/zhs/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:$PATH"`；`CODEBUDDY_SAFE_DELETE_ENABLED=0` 否则 dev server / typecheck 被 >50 文件批量删闸杀。
- vitest 须 `cd /D/git/AiCode/microfeed`（大写盘符）+ `unset NODE_OPTIONS *_PROXY`；unit 用默认 config、worker 用 `--config vitest.worker.config.ts`；cli/manage-cli 族测试建临时目录易超时，`--no-file-parallelism` 串行可解。单元环境建不了 better-auth 实例，这类断言放 `tests/worker/`；判断「是不是我引入的红」用 worktree 对照。
- 断言 AppError 用 `rejects.toMatchObject({status, i18nKey})` 或 `toBeInstanceOf(AppError)`；`toSatisfy` 非 vitest 内置。**TS 6.0 跨文件 `in` 收窄陷阱**：跨 import 的返回 union 上 `"bodies" in x` 收窄成 `{bodies: unknown}`，须用显式类型谓词守卫。
- AGENTS.md 常驻体积基线（2026-11-04）：19853 B / 164 行 / ~5.8K tokens。docs/zh 分册：HEAD 里 12 册已入库、01–11 未跟踪，旧版描述模型大半不存在；写这一域前先查 `sqlite_master` 与 `src/`。
