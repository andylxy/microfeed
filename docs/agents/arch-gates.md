# 架构治理、API 规范与票据边界

本册从仓库根 `AGENTS.md` 移出，规则条文与实测记录逐字保留；触发条件见 `AGENTS.md` 的读取约定。

## 架构治理（门禁脚本强制）

以下规则由 `scripts/check-*.ts` 四个门禁脚本执行，接入 `yarn check`，违反即退出非零。脚本只读不写，输出格式为 `文件:行 <规则编号> <描述>`；行号为 0 表示该规则作用于整个文件或整个文件名，不指向具体某一行。

### src/server/ 顶层目录白名单

- 判断理由：`src/server/` 顶层原有 23 项（18 目录 + 5 文件），其中 4 个是按特性命名的 `app-*` 目录，把共享层（`cache/`、`auth/`、`api/`）和领域层混在同一级。2026-10-12 重排把四个 `app-*` 特性收入 `src/server/app/{announcement,permission,version}/`、`tcm/app-cache.ts` 移入 `cache/`，顶层变为 20 项（15 目录 + 5 文件）。新增功能若继续开新顶层目录，会重新把共享层淹没在特性目录里。
- 门禁：`scripts/check-server-layout.ts` 维护 21 项白名单（2026-10-18 新增 `cloud-usage`）。新增任何顶层项必须同时修改脚本白名单，否则 `yarn layout:check` 失败。

### 新增端点登记

- 判断理由：端点漏登记有两种静默缺口。① 移动端 `/api/AppBookRequest/` 有两套登记表（`APP_BOOK_REQUEST_ROUTES` 做大小写归一化、`APP_BOOK_REQUEST_CONTENT_SUFFIXES` 做鉴权开关）：归一化缺失导致任意大小写请求 404，鉴权缺失导致中间件把端点当匿名服务（fail-open）。② 公开 API 的 handler 若既不在 OpenAPI 规范里、也不在豁免类里，它仍可经 HTTP 访问，但审查 API 表面的人无从得知它存在。
- 门禁：`scripts/check-endpoint-registration.ts` 对 `src/pages/api/` 下全部 53 个 handler 分三类——24 个公开 handler 必须对应 `OpenApiDocument.ts` 里的 path（规范的 path 相对 `/api/v1/`，无版本 `/api/...` 是同一 path 的 legacy 别名，19 条 path 每条至少一个 handler）；12 个 `/api/AppBookRequest/*` 另走 App 登记表；余下 17 个归入四个豁免类——四个 `/api/app/{version,announcements,search-permission,mingci-permission}`、`/api/auth/*`（better-auth 自管，catch-all 路由）、规范与文档元端点（`openapi.*`、`llms*.txt`，含 `/api/v1/openapi.html` 与 `/api/v1/` 两个 `.astro` 路由）、`/api/` 根路由。六条规则 ENDPOINT-001..006 的逐条定义见脚本头注释：除上面的三分类外，还要求 catch-all 路由可识别、App 登记表与磁盘 handler 双向一致、且每个 AppBookRequest handler 必须属于内容路由（需鉴权）或匿名路由之一。
- 人工登记：① 公开端点进 `OpenApiDocument.ts`；② App 内部端点进 `APP_BOOK_REQUEST_ROUTES`，需鉴权的再进 `APP_BOOK_REQUEST_CONTENT_SUFFIXES`；③ 匿名端点还要进 `APP_BOOK_REQUEST_ANONYMOUS_ROUTES`（`src/server/api/access.ts`，与另两个登记表同源，`tests/unit/api-permissions.test.ts` 与门禁都读它）。注意中间件的匿名判定是「不在内容路由表即匿名」，匿名表是登记记录与审查线索、不是运行时开关，两者不出现缺口由门禁的 ENDPOINT-005 保证。

### ADR 单一编号空间

- 判断理由：`docs/novel-cms/adr/` 曾出现 `ADR-0002` 被两篇不同 ADR 共用（作者隔离 vs D1 读路径优化），引用 `ADR-0002` 的代码注释指向歧义。`.scratch/microfeed-rbac/adr/` 与 `docs/novel-cms/adr/` 的编号空间重叠，同一裸编号在两处指向不同决策。
- 门禁：`scripts/check-adr.ts` 执行四条规则：① 编号唯一（文件前缀与 H1 一致）；② 每篇 H1 以 `# ADR-NNNN:` 开头；③ `src/` 与 `migrations/` 中的裸 `ADR-NNNN` 引用必须解析到 docs 目录下的实际文件（`ADR-001 D-010`/`D-011` 仓外引用豁免）；④ 生产代码不得引用 `.scratch/<dir>/adr/*.md` 路径。
- `.scratch/` 是草稿空间，编号可任意，但生产代码不得裸引。已被代码引用的草稿 ADR 必须提升为 docs ADR 后再引用。

### 迁移命名与回滚

- 判断理由：wrangler 以文件名作为 `d1_migrations` 记账键，改名会导致迁移重复执行。0107 及以前的 103 个迁移文件名已冻结不可改，快照在 `scripts/frozen-migration-names.txt`。0108 起引入 `NNNN_<type>_<desc>.sql` 命名（type ∈ schema/index/data/seed/cleanup），让 reviewer 从文件名即可识别迁移类型。data 与 cleanup 类迁移必须含 `-- rollback:` 注释块，说明回滚方式。
- 门禁：`scripts/check-migrations.ts` 执行四条规则：① 0108+ 编号连续无缺号（0044、0047–0049 的历史缺号在冻结边界内，豁免）；② 0001–0107 文件名与快照逐条比对，改名与新增占位都能抓到；③ 0108+ 文件名含合法 type；④ 0108+ 的 data/cleanup 迁移含 `-- rollback:` 块。

## API 规范与文档

- 不要添加断言 `docs/` 或任何 `README.md` 中的散文、标题、链接、命令片段、侧边栏标签或确切文件内容的单元测试。文档必须保持可手动编辑而不需要配套测试改动。用 `yarn docs:check` 和 `git diff --check` 校验文档，并在实现边界（可执行行为、schema、生成器、公共规范）测试，不测试渲染后的文字。
- 把 `src/shared/ApiSchemas.ts` 与 `src/shared/OpenApiDocument.ts` 视为外部 API 规范的唯一事实来源。用 Zod 定义可复用的请求/响应 schema，并把每个公共 API 操作（方法、路径、参数、请求体、响应状态、响应 schema、认证与兼容行为）注册到 OpenAPI 文档中。
- API 处理器与它的 OpenAPI 操作必须同步更新。尽量在运行时校验中复用同一批 Zod schema，保持路由文件精简，并在向后兼容需要时显式保留既有字段或认证方式。
- 在 UI、OpenAPI、Scalar 与 LLM 文档中，把 Bearer 认证呈现为唯一的 API-key 认证方式。仅用于兼容的认证行为保留在运行时代码与聚焦测试中，不作为选项暴露给新的集成。
- 绝不手动编辑 OpenAPI JSON、OpenAPI YAML、Scalar 输入、`llms.txt` 或 `llms-full.txt` 这类独立规范文件。它们必须从 `OPENAPI_DOCUMENT` 生成；完整 LLM 参考必须内嵌该完整生成的规范保持自包含。
- 为每个变更或新增的端点添加规范与运行时测试，然后在发布前运行 `yarn lint:openapi` 和 `yarn check`。
- **豁免：移动端专用通道不注册进 OpenAPI 规范**——`/api/AppBookRequest/*`、`/api/app/version`、`/api/app/announcements`、`/api/app/search-permission`、`/api/app/mingci-permission`。`AppBookRequest` 命名空间是对旧 .NET 后端接口的 1:1 移植（路径与响应 JSON 逐字节一致，App 只换 baseUrl、零改码），属 App 与后端之间的内部通道，并非面向公众的 feed API；其响应信封 `{code,data,msg}` 与字段形状由 `.scratch/tcm-import/spec.md` §6 与 `tests/worker/tcm-app-routes.test.ts` 锁定（golden 逐字节比对）。后四个端点由 App 调用、**均需登录凭证 + 各自一个 App 能力权限码**（升级描述符 `app:version:read`、运营公告 `app:announcement:read`、搜索 `app:search:global` / `app:search:book`、名词解释 `app:mingci:view`；其中 version 与 announcements 在 2026-10-16 之前是**匿名**的，因为当时以为存在「没有凭证的客户端」—— 实测不成立，全新安装的 App 带 `SecurityConfig.getApiKey()` 内置凭证），同样不面向公众。运行时覆盖由 `tcm-app-routes.test.ts` / `tcm-app-reads.test.ts` / `tcm-app-auth.test.ts` / `app-version-routes.test.ts` / `app-announcement-endpoint.test.ts` / `app-search-permission.test.ts` / `app-mingci-permission.test.ts` 提供，不在 `OpenApiDocument.ts` 重复登记。除这五条移动端通道外，`/api/auth/*`、规范与文档元端点（`openapi.*`、`llms*.txt`）与 `/api/` 根也不进 OpenAPI 规范——完整分类见本册「架构治理 → 新增端点登记」，以该节与 `scripts/check-endpoint-registration.ts` 为准。
- `GET /api/AppBookRequest/GetAllMingCi` 复用 `app:mingci:view` 判定做服务端纵深防御：缺码/无凭证/DB 故障均 fail-closed 返回空数组 + `no-store`；不挂该权限码的 DOMAIN_RULES 规则，以免缺码返 403（由 `tests/worker/app-mingci-getall.test.ts` 覆盖）。

## 前端组件

- 新前端工作以及实质性修订现有界面时，优先使用 `src/components/ui/` 中项目自有的 shadcn/ui 组件；shadcn/ui 提供相应变体时，使用 `components.json` 中选定的 Base UI 变体。
- 优先扩展共享的 shadcn/ui 组件，不创建一次性控件，不引入另一个原语组件库。用共享组件和设计 token 组合界面，用 `cn` 助手合并类名，保持 Base UI 提供的无障碍行为完好。
- 已在改动的旧界面渐进迁移即可；不要仅仅为了采用 shadcn/ui 而重写无关的正常工作界面。

### 管理后台列表页：取数代价按行读判断

- 列表/看板类页面（`.astro` + React 组件）的取数代价以 D1 **行读**为准：一次请求只读页面当前要展示的范围。不得为了在客户端凑一个分页控件而把整本或整表读回来——客户端切片不产生任何行读，代价在那一次请求本身。
- 行数可能很大的列表走服务端分页（`themes` 走 `listing.pagination` 与 `THEME_LIST_PAGE_SIZE`），或按实体按需读取（卷看板：点书只读该书的书目，点卷才读该卷的条目）。

## 票据边界（收窄规则）

- 切分原则的文字只存在于生成工单与票据的两个技能里：`~/.agents/skills/to-spec/SKILL.md` 的 Implementation Decisions 一节，与 `~/.agents/skills/to-tickets/SKILL.md` 的 `<vertical-slice-rules>` 和两份票据模板。本节不复述这些规则，只登记它们在本仓库对应到的事实；两处文字冲突时以技能为准，改本节而不改技能就是制造互相矛盾的定义。
- 本仓库的接缝，即一张票据纵向穿过的层：数据层 `src/server/**`，端点层 `src/pages/**`，组件层 `src/components/admin/**`，迁移与索引 `migrations/**`，规范层 `src/shared/ApiSchemas.ts` 与 `src/shared/OpenApiDocument.ts`，文案层 `src/shared/i18n/en.ts` 与 `zh-CN.ts`，文档与语汇表 `CONTEXT.md`、`docs/novel-cms/adr/**`、`AGENTS.md`。写工单时逐张列出该票穿过的接缝。
- 「与行为同票」的机械依据来自门禁：`scripts/check-adr.ts` 要求 `src/` 与 `migrations/` 里的裸 `ADR-NNNN` 引用解析到 `docs/novel-cms/adr/**` 下的真实文件，所以引用某条 ADR 的行为票必须同时创建该文件；`scripts/check-i18n.ts` 要求 `zh-CN.ts` 的键形状镜像 `en.ts`，所以新文案键随用到它的组件同票；`scripts/check-endpoint-registration.ts` 要求 handler 与登记一致，所以新端点随它的首个调用方同票。三条门禁的逐条规则见本册「架构治理」与「API 规范与文档」两节。
- 票据与文档里的数字在本仓库的取数地点：`node:sqlite` 只读探针脚本的 stdout 文件与其 `EXPLAIN QUERY PLAN` 输出，留在 `.scratch/<feature-slug>/`（`.gitignore:134` 覆盖该目录），票据写出该文件路径。D1 的 `meta.rows_read` 需要 Miniflare 绑定，探针拿不到的口径要标注为推断值。
- 写测试断言前先读被断言的函数本体，确认它是否顺便插入新行、写入的是 `null` 还是空串、返回哪些类型的行；一次阅读代替一次红色断言。这条在「测试只写不跑」的规则下是强制的。
