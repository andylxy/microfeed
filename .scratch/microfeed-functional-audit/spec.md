# microfeed 功能类别审计与修复规范

- 日期：2026-09-25
- 分支：`feat/login-credential`（HEAD `66b420b`）
- 性质：全仓功能面体检（非 diff 审核）。**本轮只出规范，不实施。**
- 方法：按功能切分 10 类，每类只读勘察 → 对每条严重判定回读原文核实 → 再写方案。
  勘察报告中**经核实为误报的已删除并标注勘误**。
- 调整（2026-09-25 第二版）：并入**「上游升级保障」维度**——所有修复按文件归属三档评估对上游合并的影响，
  每项落实「减叉策略」与「合并后守护断言」；A6 因触碰红线文件改道实施（见 §2.5 与 §3-A6）。

---

## 1. 功能类别清单（10 类）

| # | 类别 | 主要落点 |
|---|---|---|
| C1 | 账号与认证 | `src/server/auth/`、`src/shared/AdminCredentials.ts`、`LoginCredential.ts`、迁移 0008/0029/0036/0037/0039/0042/0053 |
| C2 | 授权 / RBAC / 菜单 / 守卫 | `src/server/rbac/`、`src/shared/Rbac.ts`、`src/middleware.ts`、`src/pages/[adminPath]/ajax/**`、迁移 0028/0031/0040/0041/0043/0046/0050-0055/0057 |
| C3 | 内容管理（条目/书/卷/章/分类/搜索） | `src/server/feed/`、`src/shared/Item*.ts`、`ExtBook.ts`/`ExtCategory.ts`/`ExtVolume.ts`、迁移 0009/0012/0023/0056 |
| C4 | 正文与富文本编辑 | `src/shared/BodyFormat.ts`、`AdminRichEditor*`、Quill / wangEditor 双引擎、`src/client/RichEditor*` |
| C5 | 媒体与站点文件 | `src/server/media/`、`src/server/site-files/`、`src/shared/MediaFileUtils.ts`、`SiteFileTemplates.ts` |
| C6 | 公开 API 与契约 | `src/server/api/`、`src/shared/ApiSchemas.ts`、`OpenApiDocument.ts`、`OpenApiTranslations.ts` |
| C7 | Webhooks | `src/server/webhooks/`、`src/shared/Webhooks.ts`、迁移 0017/0019/0020/0022 |
| C8 | 主题 | `src/server/themes/`、`themes/feed-zh/`、`packages/theme-kit/` |
| C9 | CLI 与部署运维 | `manage-cli/`、`packages/cli/`、`migrations/` |
| C10 | 后台国际化与前端规范 | `src/shared/i18n/`、`src/components/ui/`、`src/styles/interactive.css` |

**健康度速览**：C8/C9/C10 的骨架（主题安装激活分离、快照表登记、部署门禁、i18n 键形状、pointer 光标）最扎实；
C6 与 C2 存在**真实安全缺口**；C3 有一条**端到端不可用**的功能链路；C1 有两条凭据撤销/限流缺口；C5 有一个存储型 XSS 面。

---

## 2. 缺陷台账

标记：`[核]` = 已回读原文确认；`[勘误]` = 勘察报告有误、已纠正；`[待确认]` = 证据不足，实施时需先验证。

### P0 — 安全 / 功能不可用（必须先修）

| ID | 类别 | 缺陷 | 证据 |
|---|---|---|---|
| **A1** | C6 | 公开 API 三域（`pages` / `site-files` / `media_files`）**零授权校验**：任一有效 `mflc_` 凭证即可改站点文件、改 Pages、领上传预签名 URL | `[核]` `src/server/api/api-permissions.ts:41-99` `DOMAIN_RULES` 只登记 7 个前缀；`src/server/api/credential-bearer.ts:101` `const granted = permissionCode === null \|\| …`；`src/shared/OpenApiDocument.ts:733` 确有 `/media_files/presigned_urls/` |
| **A2** | C2 | Webhook 六个**读**端点完全无守卫，任意已登录账号（含只读）可枚举端点、读全部投递报文 | `[核]` `src/pages/[adminPath]/ajax/webhooks/{overview,endpoints/index,endpoints/[endpointId]/index,deliveries/index,deliveries/[deliveryId]/index,explorer/subjects}.ts` 均裸 `export {… as GET}`；同目录 `endpoints/[endpointId]/secret.ts:6` 注释写明「GET 也按写来守」却只有它套了 `withWebhookGuard` |
| **A3** | C3 | **分章导入端到端不可用**（三处叠加） | `[核]` `src/components/admin/items/ImportChaptersApp/index.tsx:96-104` 正文发 `content`，而 `src/server/feed/FeedCrudManager.ts:74-80` 只认 `content_html`/`content_format` → 正文丢失；未发 `date_published_ms` → `FeedDb.ts:589,623` `msToRFC3339(undefined)` → `RangeError` 每章 500；未发 `_microfeed.bookId` → `book_id` 派生列 null |
| **A3-勘误** | C3 | ~~导入未生成 11 位 id~~ → **误报** | `[勘误]` `src/server/feed/FeedCrudManager.ts:173` `const itemId = item.id ? item.id : randomShortUUID();` 有兜底，**不是缺陷** |
| **A4** | C5 | 媒体投放无 `nosniff`，Content-Type 完全由上传方决定 → 同源 `/media/*` 可投放 svg/html，**存储型 XSS** | `[核]` `src/server/media/media.ts:8-19` `objectHeaders()` 仅 `object.writeHttpMetadata`；`src/pages/media-upload/[...key].ts:71-73` `contentType ? {contentType} : request.headers`；`src/server/media/uploads.ts:86-96` size 仅校验"安全整数非负" |
| **A5** | C1 | 重置密码**不撤销登录凭证**，改密后旧 `mflc_` 令牌仍能换会话 | `[核]` `src/server/auth/password-setup.ts:347-375` 删了 `oauth_access_token`/`oauth_refresh_token`/`oauth_consent`/`oauth_connection`/`auth_session`，唯独无 `ext_login_credentials`（表结构见 `migrations/0036`，列 `user_id`） |
| **A6** | C1 | 用户名登录**无限流**：better-auth 用户名端点 `/sign-in/username` 落到默认 `max:100/window:60`，比邮箱路径宽 20 倍 | `[核]` `src/server/auth/better-auth.ts:134-150` `customRules` 只有 `/sign-in/email` 与 `/verify-password` |

### P1 — 一致性与正确性

| ID | 类别 | 缺陷 | 证据 |
|---|---|---|---|
| B1 | C2 | 新建账号不镜像 `auth_user.role`：RBAC 拿到 `*` 而 Better Auth 侧仍是 `user`，第二授权源分裂 | `[核]` `src/server/admin/rbac-handlers.ts:838` 传 `role:"user"`，`:882` batch 只写 `ext_user_roles`；而 `replaceUserRoles:411` 有 `UPDATE auth_user SET role` |
| B2 | C2 | 写操作用**读**码守卫 | `[核]` `src/pages/[adminPath]/ajax/audit/[itemId].ts:51` POST（恢复版本/归档行）判 `CONTENT_AUDIT_READ` |
| B3 | C2 | 新建章节实际判 update 码，而页面判 create 码 → 能进页面必 403 | `[核]` `ajax/feed.ts:177` `isDeleting ? delete : update`；`items/new/index.astro:16`、`items/import/index.astro:16` 判 `CONTENT_ARTICLE_CREATE`（值 = `content:chapter:create`） |
| B4 | C2 | `ajax/api/settings.ts:14` 判 `CONTENT_SETTINGS_MANAGE`，其服务的页面 `api/settings/index.astro:19` 判 `SYSTEM_API_MANAGE` | `[核]` 同上 |
| B5 | C2 | `api-permissions.ts` 中 `content/categories`、`content/books`、`content/chapters` 三组规则**完全重复**（45-58 与 84-98） | `[核]` 已回读确认两组字面重复 |
| B6 | C6 | 审计轨迹在最缺闸门的三域静默丢失：`permission_code TEXT NOT NULL` 却可能收到 `null`，插入失败被吞 | `[核]` `src/server/api/access.ts:210` attribution.permissionCode + `:215` `catch {}`；`migrations/0038:24` NOT NULL |
| B7 | C6 | 公开 API 错误正文**读了管理端 cookie**，违反"按 Accept-Language 本地化、不读管理端 cookie" | `[核]` `src/server/http.ts:32`、`http.ts:144` 用 `adminLanguageFromRequest(request)`；而 `middleware.ts:72/191` 用 `languageFromAcceptLanguage` |
| B8 | C6 | `content-read.ts:53` 走纯文本 404，与 OpenAPI 声明的 JSON `Error` schema 不符 | `[核]` `http.ts:137` vs `OpenApiDocument.ts:278` |
| B9 | C6 | 文档 403 仅 5 处、429 零处；`/items/` `/pages/` `/site-files/` `/channels/` 均可 403，`middleware.ts:191-205` 可 429 | `[核]` |
| B10 | C6 | `handlers.ts:800-803/812-815` 硬编码英文 `{error: "Provide a valid media upload request."}` | `[核]` |
| B11 | C7 | Webhook 重试**不计日预算**：预算按 `delivery_count` 在事件插入时预订，`attempt < 6` 可重投 → 日限 1000 实际可发约 6000；魔数 6 与 `Webhooks.ts:58` 五段退避表无绑定，无抖动 | `[核]` `migrations/0019:29-48`、`src/server/webhooks/delivery.ts:347` |
| B12 | C7 | 失败无告警闭环：`webhook_alerts.resolved_at` 无任何写入方 | `[核]` `store.ts:452` 只查询 |
| B13 | C1 | 登录限流 `clientAddress` 回落 `"unknown"` → 缺 `cf-connecting-ip` 时所有客户端共用一个桶 | `[核]` `src/server/auth/login-throttle.ts:17-21` |
| B14 | C1 | 凭证数量上限可并发突破：count 后 INSERT 无事务 | `[核]` `src/server/auth/login-credentials.ts:122-125` |
| B15 | C1 | `x-device-id` 不校验长度/字符即 upsert；且浏览器后台从不发该头 → 决策链第 3 步（设备吊销）对 Web **空转** | `[核]` `src/server/rbac/resolve.ts:94-113` |
| B16 | C1 | 删账号不清 `ext_login_credentials`（无 DELETE 亦无 CASCADE） | `[核]` `migrations/0036` 注释称"由应用代码处理"，全仓无对应 DELETE |
| B17 | C3 | 审核 gate 对「新建即发布」空转：审核开启时新建并发布的章节不经审批直接公开 | `[核]` `src/server/feed/extContentReview.ts:277,300-301` |
| B18 | C3 | 分卷板全表扫描，未用 `0056` 已建的 `items_book_id` 索引 | `[核]` `src/server/feed/extVolume.ts:115-126` |
| B19 | C3 | 删分类留悬空引用：子分类 `parent_id` 悬空，`channels.genre` 保留已删分类值 | `[核]` `src/server/feed/extCategory.ts:320-322` |
| B20 | C5 | 孤儿 R2 对象无回收：删条目不走 `deletions.ts`，`ajax/feed.ts:161` 只传 `deleteImageUrls` | `[核]` |
| B21 | C6 | `middleware.ts:306-315` 在 `await next()` **之前**以固定 `status=200` 写访问日志，异常请求也记 200 | `[核]` |
| B22 | C6 | `OpenApiDocument.ts:128` 把实例域名 `feed.881019.xyz` 写进公开文档 | `[核]` |
| B23 | C10 | 硬编码文案未走 i18n：`[...path].astro:40-51`（Admin 404 英文）、`PublicSearch.ts:31/38/41/385/441/446/459`（公开搜索弹窗英文）、`book/[id]/index.astro:111,113`（`?? "未知作者"` / `?? "暂无更新"` 中文兜底） | `[核]` |
| B24 | C1 | `AdminPasswordSetupApp.tsx:133,152` 硬编码 `maxLength={128}`，同文件已 import `MIN_ADMIN_PASSWORD_LENGTH` 却未取 `MAX_ADMIN_PASSWORD_LENGTH` | `[核]` |
| B25 | C1 | `password.ts:49` `catch` 吞掉全部异常一律返回 `currentPasswordIncorrect`，掩盖 5xx | `[核]` |
| B26 | C2 | `ajax/{books,categories,search,feed/json}` 等 GET 无守卫（与同资源 `ajax/books.ts` 守了形成对比） | `[核]` `ajax/books/index.ts:18`、`ajax/categories/index.ts:17`、`ajax/search/index.ts:62`、`feed/json.ts:5` |
| B27 | C2 | 菜单只绑 `system:role:manage`，改权限却要 `system:permission:manage` → 能进页面改不了权限 | `[核]` `migrations/0041:55` vs `rbac-handlers.ts:1054` |

### P2 — 清理与防回归

| ID | 类别 | 缺陷 |
|---|---|---|
| C1' | C1 | `AdminCredentials.ts:32-36` `ADMIN_SETUP_SECRET_NAMES` 全仓无调用方（死代码）；`validateAdminUsername` 用 `.length`（UTF-16 码元）与 `validateAdminPassword` 的 `Array.from` 口径不一致 |
| C2' | C6 | `ext_api_key_owners`（0032）死表；`api-keys.ts:286 revokeApiKey` 不同步删除 owner 行留孤儿；`0033` 的 `api_keys.secret_hash` 无读写 |
| C3' | C2 | `ext_rbac_audit` 只写不读（无页面展示） |
| C4' | C7 | `events.ts:10` `"system"` origin 从无代码发射 |
| C5' | C8 | `src/shared/themes/ThemeRows.ts:7,14` 用 `@/shared/themes/ThemeContract` 绝对导入，违反「`src/shared/` 用相对导入」 |
| C6' | C5 | `MediaFileUtils.ts:3` `isValidMediaFile` 只判真值，不校验 category 合法性或 URL 协议 |
| C7' | C9 | `snapshot.test.ts:136-144` 只抽查几张表，未断言「迁移中每张 CREATE TABLE 都已登记」 |
| C8' | C3 | `FeedDb.ts:278` `in` 子句拼接无占位符（当前仅传常量，属潜在注入面） |
| C9' | C9 | 迁移号 0044/0045/0047-0049 缺失，0046 注释引用不存在的 0045 |
| C10' | C5 | `ajax/r2-ops.ts:26` `await request.json()` 在 try 之外，畸形 JSON 直 500 |
| C11' | C2 | `Constants.ts:222-225` 键名仍为 `CONTENT_ARTICLE_*`（值已改为 `content:chapter:*`） |
| C12' | C3 | 导入无事务/去重，中途失败留半本书，重跑重复建章 |

---

## 2.5 上游升级保障（减叉策略）

本仓是 `microfeed/microfeed` 的 fork（`origin=andylxy/microfeed`，无 upstream remote），上游活跃、本仓约落后 10 天。
**一切修复都必须保证上游升级时：冲突可预期、语义不静默回退。** 三条来源：本仓既定分叉原则（见工作记忆）+
`AGENTS.md` 结构约束 + 本次按 git 创建提交实测的归属判定。

### 2.5.1 文件归属三档（判定依据 = `git log --diff-filter=A` 创建提交；合并前用 fetch 上游复核）

| 档 | 定义 | 代表文件 | 修复策略 |
|---|---|---|---|
| **A 本地特有** | 创建于本地 9 月特色提交（rbac/审核/小说/wangEditor 等），上游不存在 | `src/server/api/api-permissions.ts`、`credential-bearer.ts`、`login-throttle.ts`、`src/server/rbac/*`、`src/server/feed/ext*.ts`、`ImportChaptersApp/`、`src/shared/Rbac.ts`、`tests/unit/admin-endpoint-guards.test.ts` | **随便改**，零上游冲突 |
| **B 上游继承·本地已深度分叉** | 上游引入，但本地 OAuth/webhook/API 基础已大改 | `src/pages/api/auth/[...all].ts`、`src/middleware.ts`、`src/server/admin-routes.ts`、`admin/webhook-handlers.ts`、`[adminPath]/ajax/webhooks/*.ts`、`src/shared/OpenApiDocument.ts`、`src/server/api/access.ts` | **只追加调用/插行**；合并冲突面小且可预测 |
| **C 上游核心·本地改动少** | 上游主干文件，本地仅零星修改 | `src/server/media/media.ts`、`uploads.ts`、`src/pages/media-upload/[...key].ts`、`src/server/auth/password-setup.ts`、`better-auth.ts`、`src/server/feed/FeedDb.ts`、`FeedCrudManager.ts`、`src/server/http.ts`、`src/shared/MediaFileUtils.ts` | **只插一行/一个数组元素**；语义行为变化尽量挪到本地 A 档文件 |
| **红线上游文件** | 项目硬约束 | `auth_user` / `auth_session` 表结构、`createMicrofeedAuth` / `better-auth.ts` 结构 | **不改**（追加 customRules 也不允许） |

### 2.5.2 五条硬规则（每条修复必须自证遵守）

1. **迁移只增不改**：已部署迁移文件一字不动（D1 迁移以文件名为身份键，改已应用文件 = 静默失效）。
   新迁移一律 `ext_` 前缀 + 语义名 + 序号 ≥ 0058，`INSERT OR IGNORE`/`NOT EXISTS` 幂等（D1 可能重放）。
2. **迁移撞号预案**：上游 `0023_multilingual_search.sql` 已与本地 `0023_ext_novel.sql` 撞号——同号不同名不致命
   （`d1_migrations` 以 `name` 为键去重）。合并时按**文件名**区分，本地迁移永远保留 `ext_` 前缀便于肉眼识别；
   **绝不**把本地语句塞进上游迁移文件，也不改名已存在迁移。
3. **上游文件只插行**：对 B/C 档文件的最小 diff = 追加调用本地函数 / 追加 header / 追加一条 DELETE；
   **新增逻辑一律放本地 A 档新文件**，上游文件只出现"一行调用"。
4. **红线不动**：`auth_user`/`auth_session` 结构、`createMicrofeedAuth`/`better-auth.ts` 结构级改动一律不做；
   `[adminPath]/ajax/*` 与 `middleware.ts` 只追加调用。
5. **合并后守护断言**：每次合并上游后跑四门禁（`AdminCredentials.test.ts` + worker `auth`/`rbac`/`login-credential` +
   `username-login`），并逐项复核本规范每类修复的守护断言（§2.5.3），防「语义静默回退」。

### 2.5.3 各修复项的上游影响评估

| 修复 | 涉及文件（档） | 减叉策略 | 冲突风险 |
|---|---|---|---|
| A1 | `api-permissions.ts`/`credential-bearer.ts`（A）；迁移 0058（本地新增） | 全部本地文件；迁移保持 `ext_` 前缀 | 低（迁移仅撞号不致命） |
| A2 | `ajax/webhooks/*.ts` 六个（B）；`webhook-handlers.ts`（B） | 每文件 3 行：`import` + `export const GET = withWebhookGuard(x)`；不新建包装层 | 低（插行级） |
| A3 | `ImportChaptersApp/`（A）；`FeedCrudManager.ts`（C） | C 档只改 1 行：`item.date_published_ms ?? Date.now()`；payload 修正全在 A 档组件 | 中低（C 档 1 行，合并时肉眼可见） |
| A4 | `MediaFileUtils.ts`（C，只加常量）；`media.ts`/`uploads.ts`（C） | 白名单/上限常量放共享模块；C 档只追加 header 两行 + 校验改调本地函数 | 中（uploads 校验段改函数体，需最小 diff） |
| A5 | `password-setup.ts`（C） | 重置分支 DELETE 清单内追加 1 条 SQL | 低（追加 1 行） |
| **A6** | `[...all].ts`（B，追加 1 行调用）；本地新文件 `auth-endpoint-throttle.ts`（A）；迁移 0059（本地新增） | **不改 `better-auth.ts`**（红线）；咽喉拦截 + 本地限流实现 | 低 |
| B1/B16 | `rbac-handlers.ts`（A） | 本地文件 | 零 |
| B3/B4/B26/B27 | `[adminPath]/ajax/*.ts` 与页面（混合） | 只改守卫参数/判码行，不改结构 | 低 |
| B6 | `access.ts`（B） | 只改 attribution 哨兵与 catch 降级 | 低 |
| B7 | `http.ts`（C） | 只改 `localizedError`/`notFoundResponse` 内部取语言来源 | 中（函数体改动，diff 尽量小） |
| B11/B12 | `webhooks/delivery.ts`、`store.ts`（B） | 退避表绑定改读共享常量；`resolved_at` 补写入方 | 中 |
| B22 | `OpenApiDocument.ts`（B） | 域名改为运行时派生（改生成逻辑） | 低（本地已深度分叉） |
| B23 | `[...path].astro`、`PublicSearch.ts`、`book/[id]/index.astro`（混合） | 只把硬编码串替换为 i18n 调用 | 低 |
| 其余 P1/P2 | `ext*.ts`、`rbac/*`、`login-throttle.ts`、`r2-ops.ts`、`snapshot.ts` 等（A） | 本地文件 | 零 |
| C5'（ThemeRows 相对导入） | `src/shared/themes/ThemeRows.ts`（本地） | 修导入语句 | 零 |

### 2.5.4 升级合并流程（每次拉上游后固定动作）

1. `git fetch` 上游 → 在干净工作树（先提交或 stash 本地成果）上 merge；
2. 迁移目录按**文件名**逐一比对去重，本地 `ext_` 迁移保留，上游新增迁移原样引入；同号不同名仅排序难读、不处理；
3. 跑四门禁（见 2.5.2-5）→ 逐项跑本规范 §10 各修复的守护测试（新增的 `api-permissions`/`media-headers`/`import-chapters-payload`/`admin-endpoint-guards` 升级版）；
4. 若守护断言红 → 判定为「语义静默回退」，按原修复方案重新落地，**不得反向改守护断言**。

## 3. 修复方案

### 阶段 A — P0（6 项）

#### A1：公开 API 三域补授权 + 未映射即拒绝

**文件与函数**
- `src/server/api/api-permissions.ts`
  - `DomainRule`（`{prefix, read, write, create?, update?, delete?}`）
  - `DOMAIN_RULES: DomainRule[]`
  - `requiredCode(rule, method)`、`requiredApiPermission(pathname, method)`
- `src/server/api/credential-bearer.ts`
  - 授权判定 `const granted = permissionCode === null || …`（约 `:101`）
- `src/shared/Constants.ts` → `PERMISSION_CODES`
- 新迁移 `migrations/0058_ext_media_file_permission.sql`
- `src/shared/i18n/en.ts` / `zh-CN.ts`（权限中文名）

**改动**
1. `DOMAIN_RULES` 末尾（删除重复的三组后）追加：
   ```
   {prefix: "pages",      read: "content:page:manage",      write: "content:page:manage"},
   {prefix: "site-files", read: "content:site_file:manage", write: "content:site_file:manage"},
   {prefix: "media_files",read: "media:file:manage",        write: "media:file:manage"},
   ```
   取"读写同码"与 `channels` 域既有风格一致（频道是整体管理，同理）。
2. `media:file:manage` 是新码，需：
   - `PERMISSION_CODES.MEDIA_FILE_MANAGE = 'media:file:manage'`（**必须**，否则 `PermissionCode` 类型与迁移目录不等，`admin-endpoint-guards.test.ts` 会红）。
   - 迁移 0058：`INSERT INTO ext_permissions (id, code, name) VALUES ('p_media_file_manage','media:file:manage','媒体文件管理');`
     （`id` 由 `permissionId()` 推导为 `p_<code 的 ':'→'_'>`，与 0031 一致。）
   - **回归兜底（关键）**：同一迁移内把该码授予所有当前持有 `content:site_file:manage` 的角色，避免既有合法凭证 403：
     ```sql
     INSERT INTO ext_role_permissions (role_id, permission_id)
     SELECT role_id, 'p_media_file_manage' FROM ext_role_permissions
      WHERE permission_id = 'p_content_site_file_manage';
     ```
     用 `NOT EXISTS` 或 `INSERT OR IGNORE` 保证幂等（D1 迁移可能重放）。
3. `credential-bearer.ts`：把 `permissionCode === null` 从"放行"改为"拒绝"——
   `const granted = permissionCode !== null && (permissions.has(RBAC_WILDCARD) || permissions.has(permissionCode));`
   同时 `attribution.permissionCode` 为 null 时走显式审计分支（见 B6）。

**依赖**：无新依赖。需同步改 `tests/worker/api-permissions.test.ts:99`（该断言当前把"三域返回 null"固化为期望行为）。

**验证**：新增 `tests/unit/api-permissions.test.ts` 断言「`/api/v1/` 下每个路由 suffix 都能命中一条 `DOMAIN_RULES`」——
从 `src/server/api/access.ts` 的 `integrationSuffix` 清单与 `OpenApiDocument.ts` 的 path 集合求并集，逐个调 `requiredApiPermission` 断言非 null。

---

#### A2：Webhook 六个读端点补守卫

**文件**：`src/pages/[adminPath]/ajax/webhooks/` 下 6 个文件
（`overview.ts`、`endpoints/index.ts`、`endpoints/[endpointId]/index.ts`、`deliveries/index.ts`、`deliveries/[deliveryId]/index.ts`、`explorer/subjects.ts`）

**改动**：把裸 `export {x as GET} from "@/server/admin/webhook-handlers";` 改为
```ts
import {x, withWebhookGuard} from "@/server/admin/webhook-handlers";
export const GET = withWebhookGuard(x);
```
`withWebhookGuard`（`webhook-handlers.ts:66-75`）已实现，判 `PERMISSION_CODES.SYSTEM_WEBHOOK_MANAGE`，**无需新增函数**。
只读角色（`readonly`，仅 4 个 `content:*:read`）天然拿不到 `system:webhook:manage`，补完后自动收敛。

**验证**：升级 `tests/unit/admin-endpoint-guards.test.ts`——当前只校验"用到的码在目录内"，
正则也扫不到 `withWebhookGuard`。改为：
1. 扫描 `src/pages/[adminPath]/ajax/**/*.ts` 每个文件；
2. 断言每个导出的 `GET/POST/PUT/DELETE` 要么带 `requireRbac`/`withXxxGuard` 包裹，要么出现在显式豁免清单（豁免清单须为空或有注释说明）。

---

#### A3：分章导入修复

**文件**：
- `src/components/admin/items/ImportChaptersApp/index.tsx` → `onImport()`（约 `:82-114`）
- `src/server/feed/FeedCrudManager.ts` → `pubDateMs` 归一化（约 `:88`）
- `src/shared/novelChapterImport.ts` → `ChapterDraft`（如需加字段）

**改动**
1. **正文字段**：payload 由 `content: draft.content` 改为 `content_html: draft.content`，并显式带 `content_format: "html"`。
   （`FeedCrudManager.ts:74-80` 只在 `Object.hasOwn(item,"content_html")||Object.hasOwn(item,"content_format")` 时才写 `description`。）
2. **发布时间**：payload 带 `date_published_ms`（导入即 `Date.now()`，可按章节序号递减保证排序）。
   服务端双保险：`FeedCrudManager.ts:88` 的 `if (item.date_published_ms)` 改为
   `(internalSchema as any).pubDateMs = item.date_published_ms ?? Date.now();`
   ——根除 `msToRFC3339(undefined)` 的 `RangeError`（`FeedDb.ts:623`）。
3. **归属书**：`items/import/index.astro` 不给 `bookId`，组件内也无书选择器（已核实）。
   两个方案，**需用户决策**：
   - 最小修复：保持"导入章节不归属书"的现有语义，仅修 1+2，使功能可用。
   - 完整修复：新增书选择器（页面查 `ext_book` 列表 → 传给组件 → 写入 `_microfeed.bookId`），
     使 `book_id` 派生列生效、书本页能查到。
   **默认按最小修复实施**，完整修复列为独立项。
4. **幂等**（P2 的 C12' 一并处理）：为每章生成客户端幂等键随请求发送，复用 `0012_item_create_idempotency.sql` 已有机制。

**验证**：新增 `tests/unit/import-chapters-payload.test.ts`，断言构造出的 payload 含
`content_html`、`content_format`、`date_published_ms`、`title`、`status`，且直接喂给
`FeedCrudManager` 后 `internalSchema.description` 非空、`pubDateMs` 为数字。
（现有 `tests/unit/novel-chapter-import.test.ts` 只测纯函数 `splitChapters`，未覆盖请求负载——正是漏网原因。）

---

#### A4：媒体投放安全头 + 上传校验

**文件**
- `src/server/media/media.ts` → `objectHeaders(object: R2Object): Headers`（`:8-19`）
- `src/server/media/uploads.ts` → 校验段（`:86-96`）
- `src/shared/MediaFileUtils.ts` → 新增共享常量（与 `src/pages/media-upload/[...key].ts`、`packages/cli/src/media.ts`、`AdminFileUploader` 共用）

**改动**
1. `objectHeaders` 追加：
   - `headers.set("x-content-type-options", "nosniff");`
   - 若 `content-type` 不在安全内联白名单（`image/png|jpeg|gif|webp|avif`、`video/*`、`audio/*`、`application/pdf`）→
     `headers.set("content-disposition", "attachment");`
   白名单以常量形式放 `src/shared/MediaFileUtils.ts`，命名 `INLINE_SAFE_MEDIA_TYPES`。
2. `uploads.ts` 增：体积上限常量 `MAX_MEDIA_UPLOAD_BYTES`（建议 100 MiB，与 R2 单次上限对齐）、
   MIME 白名单校验（复用同一常量），越界返回 413 + i18n 错误键。
3. `src/pages/media-upload/[...key].ts:71-73`：落到统一校验函数，不再直接取 `request.headers`。

**依赖**：无新依赖。`packages/cli/src/media.ts:117-151` 同步引用同一常量（workspace 内相对/包导入，按 cli 既有风格）。

**验证**：`tests/unit/media-headers.test.ts` 断言 svg/html 响应带 `nosniff` + `content-disposition: attachment`，png 不带 attachment。

---

#### A5：重置密码撤销登录凭证

**文件**：`src/server/auth/password-setup.ts` 重置分支（`:346-375`，一串 `DELETE` 语句）

**改动**：在同一事务的 `batch` 内、删 `auth_session` 之后追加：
```sql
DELETE FROM ext_login_credentials WHERE user_id = (SELECT "userId" FROM "auth_password_setup" WHERE "id" = ?);
```
列名 `user_id` 已核实（`migrations/0036`）。同时把该 DELETE 纳入与既有语句相同的事务边界。

**验证**：`tests/worker/password-setup.test.ts`（若无则新增）断言：建用户 → 发凭证 → 重置密码 → 该凭证再请求返回 401。

---

#### A6：用户名登录限流（改道：不动 better-auth.ts）

**背景**：缺陷本体在 `src/server/auth/better-auth.ts:134-150`（`rateLimit.customRules` 缺 `/sign-in/username`，
落到默认 `max:100/60s`）。但 `better-auth.ts` 是**红线文件**（结构不改），且上游活跃——直接改配置会扩大上游合并冲突面。
故改道：利用 `/api/auth` 的**唯一咽喉** `src/pages/api/auth/[...all].ts`（B 档，本地已深度分叉，追加调用符合约定），
在调用 `auth.handler(request)` **之前**做限流。

**文件**
- `src/pages/api/auth/[...all].ts` → `ALL` 处理器：在 `let response = await auth.handler(request);`（约 `:310`）前追加 1 行：
  ```ts
  const throttled = await enforceAuthEndpointThrottle(request, env.FEED_DB);
  if (throttled) return throttled;
  ```
  **仅此一处追加，不触碰任何既有逻辑。**
- 本地新文件 `src/server/auth/auth-endpoint-throttle.ts`（A 档，零上游影响）：
  - 导出 `enforceAuthEndpointThrottle(request: Request, db: D1Database): Promise<Response | null>`
  - 仅拦截 `POST /api/auth/sign-in/username` 与 `/api/auth/change-password`；其余路径恒放行
  - 限流维度 =（IP + 路径），`max: 5 / window: 60_000`；第 6 次返 429 + i18n 错误键（`Accept-Language`）
  - IP 取 `cf-connecting-ip` → `x-forwarded-for` → `null`；`null` 时**跳过 IP 维度**（与 B13 同口径，避免"unknown"共桶）
- 新迁移 `migrations/0059_ext_auth_throttle.sql`（本地，`ext_` 前缀）：
  ```sql
  CREATE TABLE IF NOT EXISTS ext_auth_throttle (
    key TEXT NOT NULL PRIMARY KEY,
    window_start_ms INTEGER NOT NULL,
    count INTEGER NOT NULL
  );
  ```
  写入采用「读 → 窗口过期则重置 → upsert」，写入前顺手 `DELETE WHERE window_start_ms < ?` 清理旧窗口（防表无限膨胀）。

**验证**：`tests/worker/auth.test.ts` 增两条断言：
1. 连续 6 次 `POST /api/auth/sign-in/username`（带伪造 `cf-connecting-ip`）→ 第 6 次 429；
2. 第 7 次仍 429（窗口未过）；`change-password` 同规则。
不触发任何 better-auth 限流逻辑（不依赖 `auth_rate_limit` 表），两套机制互不干扰。

---

### 阶段 B — P1（核心一致性）

- **B1**：`src/server/admin/rbac-handlers.ts:838` 建号路径，在 `:882` 的 batch 内补
  `UPDATE auth_user SET role = ? WHERE id = ?`（与 `replaceUserRoles:411` 同形状），角色由所选角色推导，保持单一授权源。
- **B2**：`ajax/audit/[itemId].ts:51` POST 分支改判 `CONTENT_AUDIT_WRITE`（新码）或按动作分派；
  **首选**不改码，改为按 body 动作分派：恢复版本 → `content:chapter:update`，归档 → `content:audit:manage`。
  新增 `content:audit:manage` 需走与 A1 相同的「迁移 + PERMISSION_CODES + 授予既有角色」三件套。
- **B3**：`ajax/feed.ts:177` 的分派改为 `isDeleting ? delete : (isCreating ? create : update)`，
  `isCreating` 由 body 是否带 id 判定（与 `items/new/index.astro` 的 `content:chapter:create` 对齐）。
- **B4**：`ajax/api/settings.ts:14` 改判 `SYSTEM_API_MANAGE`，与页面一致。
- **B5**：删除 `api-permissions.ts` 中重复的第二组 `content/categories|books|chapters` 规则（保留前一组，注释已在前一组）。
- **B6**：`src/server/api/access.ts:210-215`
  - `attribution.permissionCode` 为 null 时写显式哨兵（如 `"__unmapped__"`）而非 null，满足 `NOT NULL`；
  - `catch {}` 改为记录结构化告警（不吞异常），保证最缺闸门的域也有审计行。
- **B7**：`src/server/http.ts:32` 与 `:144` 的 `localizedError` / `notFoundResponse` 改用 `languageFromAcceptLanguage(request)`，
  与 `middleware.ts` 同源。**注意**：后台页面仍用 `adminLanguageFromRequest`，只改公开 API 路径。
- **B8**：`src/server/api/content-read.ts:53` 改走 JSON 错误响应（与 `OpenApiDocument.ts:278` 的 `Error` schema 一致）。
- **B9**：OpenAPI 文档为 `/items/`、`/pages/`、`/site-files/`、`/channels/` 补 403，为限流路径补 429。
- **B10**：`handlers.ts:800-803/812-815` 硬编码英文改 i18n 键（en + zh-CN 同步）。
- **B11**：`src/server/webhooks/delivery.ts:347` 的 `attempt < 6` 改为取 `Webhooks.ts` 的退避表长度（单一事实来源），
  并加 ±20% 抖动；重投时按 `0019` 的预算表预留额度（或显式记录为"重试不占日预算"并更新文档注释）。
- **B12**：为 `webhook_alerts.resolved_at` 补写入方（端点恢复/手动确认处），或删除该列并更新注释。
- **B13**：`login-throttle.ts:17-21` 的 `clientAddress` 回落由 `"unknown"` 改为按 `cf-connecting-ip` → `x-forwarded-for` →
  `null`；`null` 时**跳过** IP 维度限流（只按账号维度），避免全局共桶锁死。
- **B14**：`login-credentials.ts:122-125` 的 count + INSERT 包进同一 D1 事务（batch）。
- **B15**：`resolve.ts:94-113` 对 `x-device-id` 加长度（≤64）与字符（`[A-Za-z0-9_-]`）校验；
  设备吊销对 Web 空转的问题单列决策项（**需用户决策**：是否让后台发送设备头）。
- **B16**：删账号处补 `DELETE FROM ext_login_credentials WHERE user_id = ?`（与 B1 同文件区域，纳入同一事务）。
- **B17**：`extContentReview.ts:277,300-301` 让"新建即发布"也进审核队列（`Object.keys(before).length===0` 时 snapshot 取空对象而非 after）。
- **B18**：`extVolume.ts:115-126` 改写为按 `book_id` 索引列查询（`WHERE book_id = ?`），消除全表扫描。
- **B19**：`extCategory.ts:320-322` 删除前先校验无子分类/无引用，或把子分类 `parent_id` 置空并清理 `channels.genre`。
- **B20**：`ajax/feed.ts:161` 删条目时把条目的正文内嵌图片与主媒体一并交给 `scheduleBestEffortMediaDeletion`。
- **B21**：`middleware.ts:306-315` 把访问日志写入移到 `await next()` **之后**，取真实响应 status。
- **B22**：`OpenApiDocument.ts:128` 的实例域名改为从请求 origin 派生（运行时插值），文档内不留具体域名。
- **B23**：三处硬编码文案抽成 i18n 键（`[...path].astro` 的 404、`PublicSearch.ts` 的搜索弹窗、`book/[id]/index.astro` 的兜底文案）。
- **B24**：`AdminPasswordSetupApp.tsx:133,152` 改取 `MAX_ADMIN_PASSWORD_LENGTH`。
- **B25**：`password.ts:49` 的 catch 分类：已知业务错误 → 4xx，其余 → 5xx 并记录。
- **B26**：`ajax/{books/index,categories/index,categories/[categoryId],search/index,feed/json}` 按资源补守卫（与 `ajax/books.ts:11` 对齐）。
- **B27**：菜单绑定或权限校验二选一收敛（**建议**：给 RBAC 页菜单增绑 `system:permission:manage` 的分组子导航，
  与既有 0050 菜单分组机制一致，而非放宽校验）。

### 阶段 C — P2（清理与防回归）

按 C1'–C12' 逐项清理；其中 **C7'（snapshot 与迁移对账测试）与 C10'（r2-ops JSON 解析）优先**，
前者防未来 `ext_` 新表静默丢数据，后者是 500。

---

## 4. 数据结构变更汇总

| 迁移 | 内容 | 幂等性 |
|---|---|---|
| `0058_ext_media_file_permission.sql` | 插入 `ext_permissions('p_media_file_manage','media:file:manage','媒体文件管理')`；把该码授予所有持有 `content:site_file:manage` 的角色 | `INSERT OR IGNORE` + `NOT EXISTS` |
| `0059_ext_auth_throttle.sql` | 新建 `ext_auth_throttle(key, window_start_ms, count)`（A6 限流存储，本地表） | `CREATE TABLE IF NOT EXISTS` + 写入时清旧窗口 |
| `0060_ext_audit_manage_permission.sql`（仅当 B2 选新码方案） | 插入 `content:audit:manage` 并授予持有 `content:audit:read` 的角色 | 同上 |
| `0061_ext_menu_rbac_permissions.sql`（B27，**已被 0065 反做**） | 插入 `ext_menu` 行 `rbac_permissions`（`parent_code='group_account'`、`path='rbac/permissions'`、绑 `system:permission:manage`、sort 502）；`users` 顺延到 503 | `INSERT OR IGNORE` + 绝对 `UPDATE` |
| `0062_ext_menu_rbac_audit.sql`（C3） | 插入 `ext_menu` 行 `rbac_audit`（`path='rbac/audit'`、绑 `system:role:manage`、sort 504），让 `ext_rbac_audit`（0054）的只读审计页可达 | `INSERT OR IGNORE` |
| `0063_ext_menu_rbac_permission_map.sql`（**部分被 0064 反做**） | 给 `ext_menu_permissions` 补 3 行树映射：`rbac_permissions→system:permission:manage`、`rbac_audit→system:role:manage`、`rbac→system:permission:manage`（第 3 行本就是 `INSERT OR IGNORE` 空操作） | `INSERT OR IGNORE` |
| `0064_ext_menu_permissions_dedupe.sql` | 删除 0063 引入的 2 行**重复树映射**（`rbac_permissions`/`rbac_audit` 那两行，0052 第 64/65 行早已把两码映射到 `rbac` 页），修复「每个码在权限树中恰好出现一次」不变量 | 绝对 `DELETE` |
| `0065_ext_drop_rbac_permissions_page.sql`（§17.4） | 删除 `ext_role_permissions` 里 `p_system_permission_manage` 的授权行、`ext_menu_permissions` 里带退休码的行与 `('rbac_audit','system:role:manage')`、`ext_permissions` 的 `system:permission:manage`、`ext_menu` 的 `rbac_permissions` 行；`users` sort 从 503 还原到 502 | 全部为绝对 `DELETE` / 绝对 `UPDATE` |

> **0061 → 0065 的净效果为零**：B27 当初选择「新增菜单行 + 新页」来让只持
> `system:permission:manage` 的账号有落点，但两页是同一块屏幕、拆分后任一单码持有者
> 仍会在另一半按钮上 403（线上该码授权行数为 0）。最终收敛为一个页面一个码，
> 0065 把 0061 加的行与码全部收回。0061/0062/0063/0064 保留为过程记录，不再代表当前状态。
> 因此当前**实际生效**的 RBAC 菜单为 3 行：`rbac`（`system:role:manage`）、
> `rbac_audit`（`system:role:manage`）、`users`（`system:user:manage`，sort 502）。

> 迁移命名纪律（§2.5.2）：全部 `ext_` 前缀 + 语义名；**绝不**修改已部署迁移文件；
> 与上游同号不同名仅排序难读，按文件名去重即可。
> 测试侧约定（§17.4）：`admin-page-guards.test.ts` 会按文件名顺序应用迁移里的
> `DELETE FROM ext_menu WHERE code = '…'`，所以删页面**不必**改动已落库的迁移文件。

约束（已核实，见 `migrations/0057` 注释）：
- `ext_permissions.code` UNIQUE，`id` 由 code 派生（`permissionId()`：`p_<code 的 ':'→'_'>`）；
- `ext_role_permissions.permission_id` 外键**仅** `ON DELETE CASCADE`，**无** `ON UPDATE CASCADE`
  → 若要改名必须「插新 → 拷授权 → 删旧」，不能直接 UPDATE。本方案的"新增码"不涉及改名，无此风险。
- 新增权限码必须同步：`PERMISSION_CODES`（`src/shared/Constants.ts`）+ `src/server/rbac/seed.ts` 的 `RBAC_PERMISSIONS`
  + i18n 权限分组中文名，否则 `admin-endpoint-guards.test.ts` 与 worker 的镜像断言会红。

## 5. 错误处理策略

统一三条：
1. **失败闭合（fail-closed）**：授权路径中"未映射/未知"一律拒绝，不再放行（A1 的核心）。
2. **不吞异常**：审计写入、日志写入等旁路操作的 `catch {}` 必须降级为结构化告警，保留原始错误（B6、B25、C10'）。
3. **错误正文与状态码分离**：状态码/响应头永不因本地化改变；公开 API 只按 `Accept-Language`（B7）。

## 6. 依赖管理

- 本轮**不引入任何新第三方依赖**。所有常量、校验、类型均落在 `src/shared/`（`MediaFileUtils.ts`、`Constants.ts`、`Rbac.ts`），
  `manage-cli/`、`packages/cli/` 与浏览器组件共用，避免出现第二份白名单。
- `src/shared/` 下新增/修改模块一律**相对导入**（`./Rbac`），不得用 `@/shared/`（C5' 即为违反此条）。

## 7. 架构概述

改动分布在三层，边界严格按 AGENTS.md，**并叠加 §2.5 上游减叉约束**（A 档随便改 / B 档只追加调用 / C 档只插行 / 红线不动）：

```
src/shared/       ← 新增：权限码常量、媒体 MIME/体积常量、导入 payload 类型（A 档）
   ↑ 被 server / client / manage-cli 共同引用（唯一事实来源）
src/server/       ← 授权判定（fail-closed）、事务化删除、索引化查询、审计不吞异常（A 档）
                   + 新增本地文件 auth-endpoint-throttle.ts（A6 限流实现，A 档）
src/pages/        ← 端点守卫包裹（B 档插行）、导入 payload 修正（A 档）
                   + [...all].ts 追加 1 行限流调用（B 档追加调用）
src/components/   ← 导入 payload 构造、密码长度常量（A 档）
migrations/       ← 0058 权限码、0059 限流表（本地新增，ext_ 前缀，只增不改）
tests/            ← 新增「全路由已映射」「全端点有守卫」「导入 payload」三类对账测试 + A6 限流断言
```

浏览器组件不得从 `src/server/` 导入；`src/shared/` 不得用 `@/shared/` 绝对导入。
C 档文件（`media.ts`、`uploads.ts`、`FeedCrudManager.ts`、`password-setup.ts`、`http.ts`）**只允许插行级 diff**，
合并冲突时可肉眼辨认并手工解决。

## 8. 验证方法

分层，按 AGENTS.md 的门禁：

1. **类型与契约**：`yarn types` → `yarn typecheck`（= types + astro check + tsc --noEmit，**门禁是这个，不是裸 tsc**）。
2. **i18n**：凡改文案/新增键 → `yarn i18n:check`（键存在性 + 中英文一致性）。
3. **OpenAPI**：凡改契约 → `yarn lint:openapi`；`tests/unit/openapi.test.ts` 必须绿（改英文原文须同步 `OpenApiTranslations.ts`）。
4. **定向测试**（**不要跑全量 `yarn test`**——本环境约 130 例会因 safe-delete 拦临时目录清理而 timeout 假失败）：
   `./node_modules/.bin/yarn vitest run tests/unit tests/worker/rbac.test.ts tests/worker/auth.test.ts`
   命令前需 `export PATH="/c/Users/zhs/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:…:$PATH"`。
5. **提交门禁**：`git diff --check` 无输出 + 上述三项 + `yarn build`（涉及构建改动时）。
6. **部署后验证**：迁移是静默应用的，成功 ≠ schema 已落。A1/A2/A5/A6 涉及生产授权与凭据，
   部署后需按 `microfeed-deploy-verify` 直查远程 D1 复核（新权限码是否落库、既有角色是否被授予、`ext_auth_throttle` 表是否创建）。
7. **上游合并演练（每次拉上游后）**：按 §2.5.4 固定流程——干净工作树 → merge → 迁移按文件名去重 →
   四门禁（`AdminCredentials.test.ts` + worker `auth`/`rbac`/`login-credential` + `username-login`）→
   本规范 §10 各修复的守护测试逐项复跑；红则判「语义静默回退」重新落地，**不得反向改守护断言**。

## 9. 实施边界

**改动范围**
- 阶段 A：6 项（A1–A6），涉及 `src/server/api/`、`src/pages/[adminPath]/ajax/webhooks/`、
  `src/components/admin/items/ImportChaptersApp/`、`src/server/feed/FeedCrudManager.ts`、
  `src/server/media/`、`src/shared/`、`src/server/auth/password-setup.ts`（追加 1 行）、
  `src/pages/api/auth/[...all].ts`（追加 1 行调用）、本地新文件 `src/server/auth/auth-endpoint-throttle.ts`、
  `migrations/0058`、`migrations/0059`。
- 阶段 B：B1–B27（27 项）。
- 阶段 C：C1'–C12'（12 项）。

**排除范围**
- 不动 `auth_user` / `auth_session` 表结构（安全红线）。
- **完全不改 `createMicrofeedAuth` / `better-auth.ts`**（红线；A6 已改道 `[...all].ts` + 本地新文件，见 §3-A6）。
- 不删除任何已部署迁移文件；迁移号只增不改（C9' 的编号断号**只补注释说明，不重命名文件**）。
- 不合并/删除 `.workbuddy-ai/memory/` 与 `.workbuddy/memory/` 两个记忆目录。
- 不自动 git 提交（本环境由用户手动执行）。
- 不改上游 C 档文件结构——`media.ts`/`uploads.ts`/`FeedCrudManager.ts`/`password-setup.ts`/`http.ts` 只允许插行级 diff。

**新增文件落位**
- 迁移：`migrations/0058_ext_media_file_permission.sql`、`migrations/0059_ext_auth_throttle.sql`
  （均 `ext_` 前缀 + 语义名，仅新增不改旧）。
- 服务端：`src/server/auth/auth-endpoint-throttle.ts`（A 档本地文件，唯一新增模块）。
- 测试：`tests/unit/api-permissions.test.ts`、`tests/unit/media-headers.test.ts`、
  `tests/unit/import-chapters-payload.test.ts`（其余在既有测试文件内追加）。
- 常量：优先落在既有 `src/shared/MediaFileUtils.ts`、`Constants.ts`，**不新建模块**除非确无归属。

**需同步的文档**
- `src/shared/OpenApiTranslations.ts`（凡改 OpenAPI 英文原文）。
- `docs/microfeed-cli.md`（若 CLI 行为变化）。
- `.scratch/microfeed-functional-audit/spec.md`（本文件，每完成一项打勾并记录复核结论）。

**需用户决策的三项**（实施前必须确认，不得自行假定）
1. A3 归属书：最小修复（不归属书）vs 完整修复（加书选择器）。**默认最小修复。**
2. B2 权限码：新增 `content:audit:manage` vs 按动作复用现有码。**默认按动作分派、不新增码。**
3. B15 设备吊销：是否让后台发送 `x-device-id`。**默认本轮不动，只加校验。**

## 10. 实施清单（顺序化、原子化）

> 每个编号是一次原子改动，改完即跑对应定向测试；不得合并多个编号一次性提交。

**阶段 A（P0）**
1. 新增 `migrations/0058_ext_media_file_permission.sql`：插入 `media:file:manage`，并授予持有 `content:site_file:manage` 的角色（`INSERT OR IGNORE` + `NOT EXISTS` 幂等）。
2. `src/shared/Constants.ts` 的 `PERMISSION_CODES` 增 `MEDIA_FILE_MANAGE: 'media:file:manage'`。
3. `src/server/rbac/seed.ts` 的 `RBAC_PERMISSIONS` 同步该码（保持与 SQL 种子镜像）。
4. `src/shared/i18n/en.ts` + `zh-CN.ts` 补该权限的中文名（`yarn i18n:check` 验证）。
5. `src/server/api/api-permissions.ts`：删除重复的第二组 `content/categories|books|chapters` 规则。
6. 同文件：追加 `pages` / `site-files` / `media_files` 三条域规则。
7. `src/server/api/credential-bearer.ts`：授权判定改为 fail-closed（`permissionCode !== null && …`）。
8. `tests/worker/api-permissions.test.ts`：把"三域返回 null"的旧断言改为期望具体权限码。
9. 新增 `tests/unit/api-permissions.test.ts`：断言 `/api/v1/` 每个路由 suffix 都能命中 `DOMAIN_RULES`。
10. `ajax/webhooks/overview.ts`：GET 包 `withWebhookGuard`。
11. `ajax/webhooks/endpoints/index.ts`：GET 包 `withWebhookGuard`。
12. `ajax/webhooks/endpoints/[endpointId]/index.ts`：GET 包 `withWebhookGuard`。
13. `ajax/webhooks/deliveries/index.ts`：GET 包 `withWebhookGuard`。
14. `ajax/webhooks/deliveries/[deliveryId]/index.ts`：GET 包 `withWebhookGuard`。
15. `ajax/webhooks/explorer/subjects.ts`：GET 包 `withWebhookGuard`。
16. `tests/unit/admin-endpoint-guards.test.ts`：升级为"每个 ajax 端点的每个导出方法都有守卫"，正则需覆盖 `withWebhookGuard`。
17. `src/server/feed/FeedCrudManager.ts:88`：`pubDateMs` 改为 `item.date_published_ms ?? Date.now()`。
18. `ImportChaptersApp/index.tsx` `onImport()`：payload 改 `content_html` + `content_format: "html"`。
19. 同函数：payload 补 `date_published_ms`（按章节序号递减）。
20. 新增 `tests/unit/import-chapters-payload.test.ts`：断言 payload 经 `FeedCrudManager` 后 `description` 非空、`pubDateMs` 为数字。
21. `src/shared/MediaFileUtils.ts`：新增 `INLINE_SAFE_MEDIA_TYPES` 与 `MAX_MEDIA_UPLOAD_BYTES`。
22. `src/server/media/media.ts` `objectHeaders()`：加 `nosniff`；非白名单类型加 `content-disposition: attachment`。
23. `src/server/media/uploads.ts`：接入 MIME 白名单与体积上限，越界返 413 + i18n 键。
24. `src/pages/media-upload/[...key].ts:71-73`：改为调用统一校验函数。
25. `packages/cli/src/media.ts:117-151`：同步引用共享常量。
26. 新增 `tests/unit/media-headers.test.ts`：svg/html → nosniff + attachment；png → 无 attachment。
27. `src/server/auth/password-setup.ts` 重置事务：追加 `DELETE FROM ext_login_credentials WHERE user_id = (…)`。
28. 新增/补充 worker 测试：重置密码后旧 `mflc_` 凭证请求返 401。
29. 新增 `migrations/0059_ext_auth_throttle.sql`：建 `ext_auth_throttle` 表（`IF NOT EXISTS` 幂等）。
30. 新增 `src/server/auth/auth-endpoint-throttle.ts`（A 档本地文件）：`enforceAuthEndpointThrottle()`，仅拦
    `sign-in/username` 与 `change-password`，5 次/60s，IP 缺失时跳过 IP 维度。
31. `src/pages/api/auth/[...all].ts`：在 `auth.handler(request)` 前**追加 1 行**限流调用（仅追加，不改既有逻辑）。
32. `tests/worker/auth.test.ts`：连续 6 次用户名登录（带伪造 `cf-connecting-ip`）→ 第 6 次 429；`change-password` 同规则。
33. 跑 `yarn typecheck` + 定向 vitest（api / rbac / auth / unit 子集）+ `yarn i18n:check` + `yarn lint:openapi`；记录阶段 A 复核结论。

**阶段 B（P1）** — 每项一条，编号 34–60：B1 → B27 按上表顺序逐项落地；
其中 B2、B15、B27 需先按"需用户决策"确认方向。
61. 阶段 B 全量复核：`yarn typecheck` + 定向 vitest + `yarn i18n:check` + `yarn lint:openapi`。

**阶段 C（P2）** — 编号 62–73：C1'–C12'，C7' 与 C10' 优先。
74. 阶段 C 复核 + 全类别回归扫描（重跑本审计的 10 类勘察，确认无新增缺陷、无回退）。

**收尾**
75. `git diff --check` 无输出；给出精确的 `git add` 路径清单与中文提交信息，交由用户手动提交。
76. 部署（AI 执行）+ `microfeed-deploy-verify` 直查远程 D1 复核新权限码落库、既有角色授权、`ext_auth_throttle` 表创建。
77. **上游合并演练**：按 §2.5.4 拉上游 → 迁移按文件名去重 → 四门禁 → §10 各修复守护测试逐项复跑。

## 11. 下一步

本轮（2026-09-25 第二版）已并入**「上游升级保障」维度**：
- 按 git 创建提交实测文件归属三档（A 本地特有 / B 上游继承深度分叉 / C 上游核心），A6 因触碰红线文件
  （`better-auth.ts`）**改道**到 `/api/auth` 唯一咽喉 `[...all].ts`（追加 1 行调用）+ 本地新文件 + 迁移 0059；
- 新增五条减叉硬规则、迁移撞号预案、每项修复的上游影响评估表，以及 §8-7 / §10-77 的**上游合并演练**收尾步骤。

**阶段 A 已实施**（A1–A6 全部落地 + 阶段 A 复核通过），尚未进入阶段 B。缺陷台账与方案主体（阶段 A/B/C）不变，编号已重排。

## 12. 实施偏差记录（阶段 A）

本阶段执行中出现的事实偏差、与原始方案的不同之处，以及测试环境限制，统一记录于此，供阶段 B/C 与上游合并演练参考。

### 12.1 A1（i18n 范围）
- 原始方案将 i18n 键纳入本轮修复范围。实际：i18n 键（en/zh-CN）仅因 A4 新增 `errors.media.unsupportedContentType` / `errors.media.fileTooLarge` 而**按需补充**，不扩大既有翻译面；i18n 范围维持「只加不改」。

### 12.2 A3（排序方向）
- 方案中文字「递增」按**严格递增**理解；实际实现采用**非递减（>=）**语义（允许并列值），更贴合媒体/条目列表的稳定排序需求。若上游某处依赖严格递增，合并时需复核。

### 12.3 A4（上传白名单 / 响应码 / 不信任请求头）
- 新增两个共享常量而非复用 CLI 私有集：`ALLOWED_MEDIA_UPLOAD_TYPES`（= CLI `MEDIA_TYPES` 全部 MIME 并集，自然排除 svg/html/js）管上传；`INLINE_SAFE_MEDIA_TYPES`（image png/jpeg/gif/webp/avif + pdf；video/*、audio/* 经前缀判定）管内联。两常量职责分离，已在 `MediaFileUtils.ts` 注释说明与 CLI `MEDIA_TYPES` 的镜像关系。
- 上传越界返回 **413**（超体积）/ **415**（不支持类型），均走 `AppError` → `appErrorResponse` 本地化；`handlers.ts` 的 `prepareApiMediaUpload` 补 `AppError` 捕获，消除潜在 500。
- 签名 PUT **只信已签名的 `contentType`**，为空传 `undefined`（不再回退 `request.headers`），消除「请求头伪造类型」的攻击面。

### 12.4 A6（限流改道 / 429）
- better-auth `rateLimit.customRules` 仅 `/sign-in/email` 5/60s；用户名登录与改密落默认 100/60s。
- 因红线 `better-auth.ts` 不可改，限流改道到 `/api/auth` 唯一咽喉 `[...all].ts`（追加 1 行 `enforceAuthEndpointThrottle` 调用）+ 本地新文件 `auth-endpoint-throttle.ts` + 迁移 `0059_ext_auth_throttle`。
- 越界返回 **429** + `Retry-After`；`cf-connecting-ip` 缺失时降级为全局键 `auth:${pathname}`（跳过 IP 维度，不阻塞功能）。

### 12.5 测试环境限制（重要）
- 本沙箱 vitest（unit + worker 两套 config）因 `tests/unit/i18n-setup.ts` → `@/client/i18n` → `react-i18next.init()` 在 Node 模块求值期抛 `Cannot read properties of undefined (reading 'config')` 而**整体不可用**（pre-existing 环境问题，与本轮改动无关）。
- 对策：所有定向测试按 spec 写入对应文件（待 CI/环境修复后生效）；纯逻辑用 `tsx` 单独脚本校验；门禁以 `yarn typecheck` + `yarn i18n:check` + `yarn lint:openapi` 为准。

### 12.6 typecheck 门禁偏差（部署前置）
- 阶段 A 实施期间，`yarn typecheck` 基线报 5 个错误：
  - 2 个属本轮 A4 引入（`uploads.ts` 的 `input.size` 未收窄、`MediaFileUtils.ts` 的 `split(";")[0]` 在 `noUncheckedIndexedAccess` 下为 `string|undefined`）——**已修复**（直接对 `input.size` 判空；`?? ""`）。
  - 2 个属本分支既有 webhook 守卫 WIP（`webhooks/endpoints/*` 用 `withWebhookGuard` 包裹 GET 但漏加命名导入）——**已补导入**（`listAdminWebhookEndpoints` / `getAdminWebhookEndpoint`，二者在 `webhook-handlers.ts` 均有导出）。
  - 1 个属 novel 章节导入 WIP 的 `tests/unit/import-chapters-payload.test.ts`（`date_published_ms` 类型 `{}` 不能传给 `toBeGreaterThan`）——**超出本轮审计范围**，需 novel 功能负责人处理；它阻断部署门禁（项 76），须单独解决。
- 复跑 `yarn typecheck` 后预期仅余上述 novel 测试 1 项错误；本轮 A1–A6 代码本身 typecheck 干净。

如确认方案，输入 **「进入执行」** ——阶段 A 已完成，下一步进入阶段 B（B1 起）顺序执行，
未完成项继续下一轮，直到全部关闭。

## 13. 实施偏差记录（阶段 B）

阶段 B（B1–B27）已全部实施并复核（typecheck exit 0、i18n:check 2017/2017、lint:openapi 通过；
vitest 环境不可用同 §12.5）。要点偏差：

- **B5 无需改动**：spec 记录的 content/categories|books|chapters 第二组重复规则已被 A1 重构消除
  （当前 api-permissions.ts 三前缀各出现一次），项直接关闭。
- **B2**：审计 POST 恢复版本与归档行均映射到现有写码 `content:chapter:update`
  （按默认「不新增码」；`content:audit:manage` 不存在）。仅归档分支未来可拆独立码，注释已留缝。
- **B11**：重试上界取 `attempt <= WEBHOOK_RETRY_DELAYS_SECONDS.length`（保 5 次重试、全部延迟档可用，
  字面 `< length` 会少一次重试且 8h 档死代码）；抖动 ±20%；预算按事件计、重试不重复预留（注释明确）。
  测试以 `Math.random→0.5` 保持精确断言有效。
- **B12**：`webhook_alerts` 无 endpoint_id 且唯一 kind=fanout_limit（一次性通知），
  「端点恢复写 resolved_at」结构上不可能 → 采纳选项 b：迁移 0060 DROP COLUMN resolved_at，
  修剪改按 created_at 年龄，store 查询去掉 WHERE resolved_at IS NULL。
- **B14**：上限检查改为批内条件 INSERT（`WHERE (SELECT COUNT(*) …) < 上限`）；
  `auditStatement` 增加可选 `onlyIf` EXISTS 守卫（向后兼容），避免限额命中时残留描述未发生写入的审计行；
  batch 后 `changes!==1` 抛 LoginCredentialLimitError。既有 worker 测试语义不变。
- **B17**：按 spec 取创建 snapshot={}；另需两处配套——createdPublished（before 空且 status=PUBLISHED）
  强制 pin（否则状态变更分支跳过 pin、gate 仍空转），pinToLastApproved 对空 snapshot 跳过 status 回填
  （否则公开出现「空内容已发布」条目）。注意：审核开启时「拒绝一个草稿创建」现在会把条目清空
  （原实现回填创建内容），这是 spec 处方的直接后果。
- **B22**：以 `$MF_ORIGIN` 占位替换文档内 5 处实例域名（含翻译表镜像），未做逐请求插值——
  文档 `servers[0].url` 本就是相对路径（客户端自动按服务 origin 解析），prose 示例用占位符
  与既有 `$MF_TOKEN` 约定一致，避免改动静态生成管线。
- **B23**：PublicSearch.ts 保持运行时中立（theme-kit 相对导入它），文案改经
  `PublicSearchStrings` 字典注入（英文默认），服务端由新增 `PublicSearchI18n.ts` 按
  Accept-Language/管理语言解析；脚本内文案经 `MF_SEARCH_I18N` JSON 注入。book 页兜底文案
  zh 输出不变（"未知作者"/"暂无更新"），仅新增英文翻译。
- **B26**：`[adminPath]/feed/json` 是仪表盘引导文档，按资源绑 `content:chapter:read`
  （readonly 默认角色持有，仪表盘不受影响）；其内容含 settings，属已知轻微超范围。
- **B27**：新增迁移 0061 菜单行（绑定 system:permission:manage，group_account 分组）+
  新页 `/rbac/permissions/` 页守卫同码（一菜单一码）；未放宽任何校验。
  权限专管员在角色 CRUD 上仍会 403（端点层由 role:manage 把守），属预期。
- **typecheck 途中修复**：B20 引入的 `updatedFeed.item` 未收窄（`?.` 修复）、B7 引入的
  `request?.headers.get()` 类型（`?? null` 修复）；均为本轮改动自检发现并当场关闭。

## 14. 实施偏差记录（阶段 C）

- **C7'**：对账测试（tests/unit/manage-cli/snapshot.test.ts「classifies every table the
  repository migrations create」）落地后即抓到三张漏分类真实表：`ext_api_access_log_v2`（durable）、
  `microfeed_installation`（durable）、`ext_auth_throttle`（ephemeral，0059）——已补进 SNAPSHOT_TABLES。
  FTS 虚表与影子表沿用 `ITEM_SEARCH_VIRTUAL_TABLE_PREFIXES` 前缀过滤（与生产管线同源）。
- **C10'**：解析移入 try；`SyntaxError` 单独映射 `errors.r2.invalidUpload` 400，
  其余错误保持原 400 语义（避免把 createSignedUpload 的业务错误误报为 JSON 解析失败）。
- **C1'**：`ADMIN_SETUP_SECRET_NAMES` 删除（全仓零引用，测试亦无引用）；
  用户名长度口径改 `Array.from`（码点）与密码一致。
- **C2'**：勘察推翻前提——`ext_api_key_owners` 全仓无写入方，"孤儿行"不可能存在；
  收敛为 revoke/delete batch 补 `DELETE FROM ext_api_key_owners`（落实 0032 注释契约、防未来写入方），
  死表/死列以 migrations/README.md 备案保留（DROP 会牵动 SNAPSHOT_TABLES 读取链路，得不偿失）。
- **C4'**：`WebhookOrigin` 类型移除 "system"（发射侧死变体）；DB CHECK 与公共 schema 保留该值
  （存储超集，未来补 system 发射方纯增量）。tests/unit/webhooks.test.ts 的代表 origin 改 "api"。
- **C8'**：`in` 分支改占位符绑定；空数组短路为 `1 == 0`（SQLite 无合法 `IN ()`）。
- **C9'**：按「已应用迁移一字不动」红线不改 0046 注释，新增 migrations/README.md 备案
  编号空洞（0044/0045/0047-0049）与四条迁移约定。
- **C11'**：`CONTENT_ARTICLE_*` → `CONTENT_CHAPTER_*` 全仓改名（12 文件 15 处，0 残留）。
- **C12'**：客户端去重方案（未改 ajax/feed 契约）：导入前经 `/ajax/items?status=all&limit=300`
  分页拉取现有条目（游标 next_cursor，硬上限 20 页），以规范化标题为去重键；新建章加入键集
  同时防运行内重复；失败降级为不去重（绝不阻断导入）。toast 新增 importMixed 三计数键，
  原 importPartial 删除（SSOT）。
- **C3'**：为 ext_rbac_audit 建最小只读页 `/rbac/audit/`（服务端渲染，无新 React 岛）；
  `readRecentRbacAudit` 读取器放 audit.ts（表所有者模块）；迁移 0062 菜单行绑
  system:role:manage，页守卫同码。范围说明：权限专管员（仅 permission:manage）看不到该页，
  因留痕主体是角色/授权变更，与 B27 的权限配置页互补。
- **收尾额外**：novel 导入测试的 ts(2345)（`unknown!` → `{}` 不匹配 toBeGreaterThan）改
  `as number` 断言——纯类型修复，解除部署门禁阻断（该错误原列"超范围"，因阻断交付按最小化处理）。
- **阶段 C 复核**：typecheck（见 qa_typecheck_final.log）、i18n:check 2026/2026、
  lint:openapi 通过、`git diff --check` 干净；回归扫描确认 admin 变更端点守卫无回退
  （account/* 走会话自检、webhook/* 走 withWebhookGuard，均为设计内形态）。

### 14.1 部署期修正（deploy8 失败 → deploy9 成功）

deploy8 在 test:deploy 门禁失败（api-item-service 6 例），二分定位出三处需修正：

1. **B17 回退**：spec 处方与已提交的 API 契约测试（api-item-service 8 例，HEAD 全过）
   直接冲突——`items/service.ts` 的 `recordContentChange` 从不传 `openReview`（闸门对
   API 创建恒开），B17 的 createdPublished 强制 pin 会把 API 新建的已发布条目 pin 到
   空 snapshot，数据被清空。已提交测试即部署契约，故 extContentReview.ts 三处 B17
   改动全部回退至 HEAD。**B17 转决策项**：需先厘清 `service.ts` 与全局审核开关的
   一致性（现在 API 创建无视开关恒开闸门），再决定「新建即发布是否持回」。
2. **A3 回退**：`pubDateMs = date_published_ms ?? Date.now()` 破坏 OpenAPI 明文承诺
   的「更新省略字段即保留」（更新省略日期被覆写为 now，2 例失败）。import 客户端
   本就始终传日期，RangeError 前提不成立，回退该 hunk。
3. **C6' 修正**：存库 URL 有四种合法形态（http(s) 绝对、/media/ 路径、
   production|preview|development 前缀桶键、裸遗留键 media/…），形状白名单会误杀
   遗留数据（api-item-service 用例实测）。改为按意图精确化：拒绝 script 可执行协议
   （javascript:/data:/任何非 http(s) 协议），放行其余；category 白名单保留。

修正后 test:deploy:worker 45/45、test:deploy:unit 11/11、typecheck 0 errors。
**deploy9 成功**（Deployed and verified https://feed.881019.xyz），远程 D1 已验证
迁移 0058–0062 全部落库，ext_menu 三行（rbac/rbac_permissions/rbac_audit）绑定码正确。

## 15. 代码评审（两轴）与后续修正

对 `git diff HEAD` 全量未提交改动做了 Standards / Spec 双轴评审（子代理并行），
**发现两处此前未被我复核到的真实回归**——两者都不在 `test:deploy` 门禁子集内，
故部署与之前的定向验证都没拦住：

1. **B27/C3' 漏了菜单→权限映射表**：`ext_menu` 行加了，但 `ext_menu_permissions`
   （0052，角色编辑器权限树的数据源）没加 → `tests/unit/admin-page-guards.test.ts`
   的「守卫码必须有菜单行绑定」断言失败（该测试只读 0041 的菜单行，也看不到 0061/0062）。
   修正：迁移 **0063** 补 3 行映射（rbac_permissions / rbac_audit / rbac→permission:manage），
   并把该测试的菜单来源从「只读 0041」改为「读取所有含 `INSERT INTO ext_menu` 的迁移」
   （贴合该测试自身声明的单一事实来源意图）。
2. **C7' 重复分类**：`microfeed_installation` 本就已归类为 `targetSpecific`（第 130 行），
   我又把它加进 `durable` → `assertClassifiedTables` 抛「more than one classification」，
   `snapshot.test.ts` 18 例失败。修正：从 `durable` 移除并留注释说明其 targetSpecific 归属。
3. **A3 回退的守护断言失效**：`import-chapters-payload.test.ts` 断言映射器对省略日期
   也产出数字（A3 行为），回退后必然失败。修正：把该守护改写成正确分层——导入载荷恒带
   数字日期 + 映射器对省略日期保持未设（守护「更新即保留」契约）。

另有 Standards 轴指出的两项已修：**OpenAPI `/media_files/presigned_urls/` 缺 403/413/415**
（A1 的 `media:file:manage` 与 A4 的 413/415 已在代码中生效，文档未跟上）→ 已补并同步
`OpenApiTranslations.ts`；**0060 列级 DDL 不可重放** → 因该文件已上线（一字不动红线），
改在 `migrations/README.md` 如实界定「列级 DDL 例外，靠文件名记账保证一次性」。
`ajax/feed.ts` 的 `content:chapter:*` 字面量 → 改回 `PERMISSION_CODES.CONTENT_CHAPTER_*`。

**记为后续项（评审判断项，未改）**：① `auth-endpoint-throttle.ts` 与 `login-throttle.ts`
固定窗口实现同形（表不同），可在下次合并时抽公共件；② `rbac/permissions/index.astro` 与
`rbac/index.astro` 除守卫/标题外逐行相同，可抽共享布局；③ `media-upload/[...key].ts`
（上游 C 档）仍用 `adminLanguageFromRequest`——其主调用方即后台仪表盘，语言选择可辩护，
未改以免增加上游冲突面；④ `content-read.ts` 404 由纯文本改 JSON 后响应头随之变化，
属 B8 处方的必然结果（契约修正而非漂移）。

### 15.1 评审期修正的验证

- `tests/unit/server/extVolume.test.ts`、`tests/unit/admin-page-guards.test.ts`、
  `tests/unit/openapi.test.ts` 三个套件修正后**全过**（夹具补 `book_id` 列、菜单来源改全迁移、
  文档 403/413/415 与翻译同步）。
- `tests/unit/manage-cli/snapshot.test.ts` 在批量与隔离运行中**间歇超时**（4 例，全部
  `Test timed out`/`Hook timed out`，**0 例断言失败**），失败项均为归档/多段上传/恢复机械
  用例，与表分类无关；C7' 的分类用例本身在通过集内（早前一次整文件 51/51 通过）。
  结论：该文件的超时是本环境已知的临时目录清理问题（safe-delete 拦 `rm`），非本次改动回归。

## 16. 评审待办落地（§15 三项）

1. **A6 IP 维度与 B13 对齐**：抽出共享 `src/server/auth/client-address.ts`
   （`cf-connecting-ip` → `x-forwarded-for` 首跳 → `null`），`login-throttle.ts` 与
   `auth-endpoint-throttle.ts` 共用，`credential-bearer.ts`/`credential-login.ts` 改导入。
   端点节流在**无地址时跳过 IP 维度**（原为全局单键）——与 B13「不共桶自锁」一致。
   两个窗口计数器**刻意不合并**并在文件头写明原因（预检秒级 + 自答 429 vs 失败 ms 级 +
   成功清零），仅共享地址解析与形状。
2. **A1/A2 验证测试覆盖补齐**：
   - `tests/unit/api-permissions.test.ts` 改为**派生式**：探针由 OpenAPI 文档的每个
     (path, method) 生成（`{param}` 具体化），由 `isIntegrationApiPath` 谓词决定哪些必须
     映射到码；另含 legacy 基路径负向控制。用例数 5 → **32**，新增文档路径/后缀即被覆盖。
   - `tests/unit/admin-endpoint-guards.test.ts` 的守卫扫描从「仅 webhooks 目录」拓宽到
     **整个 `[adminPath]` 面**（84 个 .ts），两类豁免各带理由（会话自助 `ajax/account/`、
     预认证 `ajax/auth/credential-login.ts` 与 `login/`；纯 302 壳 `channels|items/index.ts`）；
     并新增**重导出目标解析**——`ajax/rbac/*` 是 `rbac-handlers` 的薄重导出（守卫在目标模块内，
     16 处），目标无守卫的裸重导出仍是 A2 原形，照样失败。
3. **RBAC 页去重**：新增 `src/components/admin/rbac/RbacBoardPage.astro` 承载 AdminShell +
   RbacApp，两页（`/rbac/`、`/rbac/permissions/`）各缩到 20 行且**守卫留在页内**
   （守卫码是页面与菜单行的绑定凭据，`admin-page-guards` 测试从页面文件解析）。

验证：`api-permissions`(32) / `admin-endpoint-guards`(4) / `admin-page-guards`(3) /
`source-architecture`(18) / `server/extVolume`(7) 共 **64 例全过**。

### 16.1 顺带修掉的重复路由（Astro 警告发现）

`yarn typecheck` 输出里出现 Astro 路由器警告：`/[adminPath]/ajax/books` 同时由
`ajax/books.ts` 与 `ajax/books/index.ts` 定义（**同一提交 3ac9b4a 引入**），并提示
"collision will result in a hard error in following versions of Astro"。核实：

- `books.ts` GET → `listBookOptions()` 返回 `{books:[{id,title}]}`；
- `books/index.ts` GET → `listBooksBoardHandler()` 返回 `BooksBoard = {books: BookAdmin[], categories}`；
- 两个消费方（`BooksApp.tsx:93`、`VolumesApp.tsx:75`）**都从同一 URL 读 `data.books`**，
  且 board 形态是 options 的超集 → `books.ts` 是冗余重复路由，胜者不确定意味着后台书目
  载荷可能被静默换形。

处置：删除 `src/pages/[adminPath]/ajax/books.ts`，并删除随之孤立的
`listBookOptions`（零调用、零测试，其能力已由 board 载荷覆盖）。删除后**路由冲突警告
消失**（typecheck 日志 `defined in both` 计数 0），两个消费方统一拿到 board 载荷。

### 16.2 线上复核（deploy12 后）

- `Deployed and verified https://feed.881019.xyz`；`/` 200、`/api/v1/openapi.json` 200、
  `/api/v1/llms.txt` 200。
- **B22 线上验证**：`/api/v1/openapi.json` 中实例域名出现次数 **0**（`$MF_ORIGIN` 占位生效，
  无真实域名泄漏）。
- **B7 线上验证**：同一公开端点 `/search.json` 带 `Accept-Language: zh-CN` 返回
  「搜索查询长度需在 2 到 200 个字符之间。」，带 `en` 返回英文 —— 无管理端 cookie 也生效，
  证明公开 API 走的是 Accept-Language 而非 cookie。
- `/search.json` 的 400 是记录的「2–200 字符」校验（探针 1 字符导致），非回归。

## 17. 提交后回修：worker 套件（门禁子集之外）暴露的 4 处红

推送后跑**全部** `tests/worker/**`（25 文件，此前只跑门禁子集 7 文件）暴露 4 处失败，其中
**1 处是我引入的真实功能回归**，3 处是旧测试期望未随处方更新：

1. **真回归（已修）**：B14 把凭证上限改成批内条件 INSERT 时，内联子查询漏了
   `revoked = 0` —— 原 `countLoginCredentialsForUser` 的注释明写「只计未吊销行，
   吊销即释放配额」，我却按 `user_id` 全量计数 → 吊销后无法再建凭证。
   修复：子查询补 `AND revoked = 0`。
2. `tests/worker/admin-menu.test.ts`（写死菜单顺序）：0061/0062 新增两行后 23 vs 21 红
   → 期望数组补 `RBAC_PERMISSIONS`(sort 502)/`USERS`(503)/`RBAC_AUDIT`(504)。
3. `tests/worker/rbac.test.ts` ×2：editor 授权数 12 → **13**（0058 给 site_file 管理角色
   多授了 `media:file:manage`，即 A1 的预期行为）→ 期望更新并注明来源。
4. `tests/worker/login-credential.test.ts`：旧用例「upstream-owned 域无需 RBAC 码」断言
   `/api/v1/pages/` 返回 allow —— 那正是 A1 要修的**漏洞**。改写为断言新契约：
   无授权账号 forbidden、`r_super_admin` allow。

### 17.1 0063 的补偿迁移 0064（权限树重复映射）

`tests/worker/rbac.test.ts` 的不变量「每个可分配码在权限树中**恰好出现一次**」在修改
期望值后仍红：我 0063 加的两行与 0052 **已有映射重复**（0052 第 64/65 行早把
`system:role:manage` 与 `system:permission:manage` 都挂在 `rbac` 页上）。

结论：`ext_menu_permissions` 是**权限树**映射（码 → 唯一承载页），菜单**可见性**由
`ext_menu.permission_code` 决定 —— 0061/0062 已足够，树映射本不需要动。0063 已落库
（一字不动红线），故写 **0064** 删除那两行重复映射；0063 的第三行本就是
`INSERT OR IGNORE` 空转，保留无害。

### 17.2 运维观察（线上授权现状，非缺陷）

线上 `ext_permissions` 中 **5 个 `system:*` 码全部 granted_to = 0** —— 系统/账户区
（用户、角色与权限、Webhook、API 设置）实际只有 `super_admin`（通配 `*`）可达。
这不是本次改动引入的（`system:role:manage` 历来无人被授予），但意味着**新增的
`/rbac/permissions` 页当前也只对 super_admin 可见**。若希望某非超管角色管理权限授予，
需在角色编辑器里把 `system:permission:manage` 授予该角色（码已在目录与权限树中，
UI 可直接勾选）；是否授予属运维决策，未擅自代改。

### 17.3 门禁口径教训（再次）

`test:deploy:worker` 只跑 7 个文件（api-item-service / bootstrap-admin /
installation-identity / item-idempotency / item-search / pages-site-files /
password-setup），**不包含** admin-menu、rbac、login-credential、webhooks、auth 等。
三次部署「通过」都没覆盖上述 4 处失败。规程补充：**声明复核通过前，必须跑
`vitest run --config vitest.worker.config.ts tests/worker/` 全量**（25 文件 293 例），
而非只跑门禁子集。

### 17.4 B27 的最终收敛：0065 删除 `/rbac/permissions` 并合码

§13 的 B27 落地（0061 新增菜单行 + 新页）在复核中被判定为**只复制了页面、没有复制能力**：
两页渲染同一个 `RbacApp`（后抽为 `RbacBoardPage.astro`），差异只有守卫码、`activeNavItem`
与标题；而角色 CRUD 端点要 `system:role:manage`、保存授权要 `system:permission:manage`，
于是任一单码持有者都能进页面却在另一半操作上 403。线上实测两码的
`ext_role_permissions` 行数均为 **0**（§17.2），"权限专管员"从未存在。

最终收敛为**一个页面一个码**：`system:permission:manage` 合并回 `system:role:manage`。
迁移 **0065**（删 `ext_menu` 的 `rbac_permissions` 行、`ext_permissions` 的退休码、
相关 `ext_menu_permissions` 行、`users` sort 还原）承接 0064 已做的树映射去重。
代码侧删除 `PERMISSION_CODES.SYSTEM_PERMISSION_MANAGE`、`ADMIN_MENU_CODES.RBAC_PERMISSIONS`、
三个 i18n 键，以及死代码 `GET /ajax/rbac`（`getAdminRbacBoard`）与 `ADMIN_URLS.ajaxRbacBoard`。

决策与取舍见 `.scratch/microfeed-rbac/adr/0002-one-rbac-board.md`。**§13 B27 与 §17.1/§17.2 中
关于"两页并存"的描述至此作废**，保留为过程记录。

测试侧新增一条可复用约定：`tests/unit/admin-page-guards.test.ts` 现在会按文件名顺序应用
迁移里的 `DELETE FROM ext_menu WHERE code = '…'`，因此**删除页面不必再改动已落库的迁移文件**。
另注：`tests/unit/admin-endpoint-guards.test.ts` 解析 `ext_permissions` 的删除只认
`code IN (…)` 与 `code LIKE '…%'` 两种写法，迁移里写 `code = '…'` 会被它忽略。
