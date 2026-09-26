# microfeed 项目长期记忆

> 技能：git-safe-commit / sandbox-safe-delete-guard / microfeed-novel-site-ops / microfeed-admin-layout-verify / microfeed-admin-i18n / microfeed-rbac-menu-permission

## 硬约束
- 禁自动 git 提交（须明确指令）；不提交 `main`，用 `<type>/<kebab>`；提交信息 `type(scope): 中文`。
- 门禁：`git diff --check` 干净 + `yarn typecheck` + `yarn test`。⛔ `tsc --noEmit` 不是门禁。
- `yarn` 用 `./node_modules/.bin/yarn`；**vitest 必须经 yarn 跑**（否则 `help.test.ts` 假红 3 例）；i18n 改完跑 `yarn i18n:check`。
- 部署：`CODEBUDDY_SAFE_DELETE_ENABLED=0 yarn manage deploy --instance ctwh-881019-xyz --yes`。
- 改 `AGENTS.md` 后核 `tests/unit/agent-guidance.test.ts`（6 技能名反引号+文件存在、禁 `Codex`）。
- ⛔ 动手前先读 AGENTS.md（禁 mock/fallback、注释中文、禁长 inline 脚本→先写文件、实现完必须自测）。
- 凭证 **可读✅/外泄❌/索取❌**（AGENTS.md L36/L187/L271）。

## 上游与分叉
- fork 自 microfeed/microfeed（origin=andylxy）；fork 点 `b510bb2`(09-11)==`merge-base main HEAD`，从未合并。
- 判据 `git cat-file -e main:<path>`（存在=上游）。⛔ 别用 `git log --diff-filter=A`（拓扑误导）。
- `themes/feed-zh/` 上游不存在 ⇒ 零冲突面（`AGENTS.md:221`：一切改这里）。
- 自研：`api-permissions.ts`、`credential-bearer.ts`、`src/server/rbac/`、迁移 0035+ `ext_*`。

## 主题运维
- 磁盘 `themes/feed-zh/*` 是创作源，D1 是运行源：`install` → `activate <uuid>`；**仅路由/服务端改动才 deploy**。
- ⛔ 装前必递增 `microfeed-theme.json` 版本；install 只 INSERT、装完必 inactive。
- ⛔ `a,a:visited`(0,1,1) 劫持 `:visited`；修法＝重复类名 (0,2,0)；观测须 CDP `forcePseudoState`。
- ⛔ 验证暗色先写 `localStorage["microfeed-public-theme"]` 再导航。
- ⛔ 发版收尾：install+activate 后**只留最新版 + 上一版（回滚点）**；`manage theme delete <id> --confirm <id>`（软删、拒内置/拒 active），别用 D1 物理 DELETE。
- 「首页」标签**写死**在 `web-body-start.mustache`；`category_nav`/`navigation_pages` 数据驱动（`src/server/feed/siteNav.ts`）。
- 站点标题：Admin「设置 > 站点」→ `settings.webGlobalSettings.siteTitle` → builder **显式 set/delete** `publicFeed._microfeed.siteTitle`（旧 `channel._microfeed.siteTitle` 口袋已废，清空设置项不得复活）→ 模板 `{{site_title}}`（回退 `title`）；无 DB 列。改 `themeContextSchema` 后必 `yarn theme-kit:build`。
- ⛔ 公开页 CF 边缘缓存 300s（`public-cache.ts`）：改 D1 后抓首页无变化，读实时渲染须用**非法分页 query**（`/?probe=1` → `no-store`）。
- 远程 D1：`wrangler d1 execute ctwh-881019-xyz-db --remote --config .microfeed/instances/ctwh-881019-xyz/wrangler.jsonc --command "…"`（须内联字面量，不支持 `?`）。

## RBAC / 内容读 API
- 不动 `auth_*`；新表全 `ext_`、序号≥0028；super_admin `*` 不可授予/删/改名。
- API 认证：credential-bearer（`Bearer mflc_…`，唯一在用）+ 上游 legacy bearer。
- 授权码 `content:*:*`；**码表在 `src/server/api/api-permissions.ts` 的 `DOMAIN_RULES`**（非 `rbac/`）。
- 内容读 4 端点 `/api/v1/content/*`（ADR-0006）；鉴权三态 legacy→404/无凭证→401/凭证→200。
- ⛔ 删菜单行/改页面守卫先读技能 `microfeed-rbac-menu-permission`（三条守卫不变式会红）。
- 回归脚本 `.microfeed/test_api.py`：`exit=0` 通过 / `exit=2` 有问题。

## 其他
- `RbacApp/index.tsx` 权限树叶子单列 `flex flex-col gap-2`（勿改回 grid）。
- OpenAPI：`OpenApiDocument.ts` 唯一事实源；改英文原文须同步 `OpenApiTranslations.ts`。
- 文档：RBAC ADR `.scratch/microfeed-rbac/adr/`；公开站 ADR `docs/novel-cms/adr/`；审计 `.scratch/microfeed-functional-audit/spec.md`（追加不改写）。
- txt 分章导入已删并上线（0066/0067）；0067 补 0057 漏改的 `ext_menu.permission_code`。
- ⚠️ 两个记忆目录并存：`.workbuddy-ai/memory/` 与 `.workbuddy/memory/`，勿合并/删。
