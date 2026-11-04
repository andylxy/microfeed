# microfeed — 仓库协作规范（中文常驻骨架）

> **门禁只在手动触发时运行**，详见下方「最高指令」小节；普通任务不跑测试、类型检查、构建与 `scripts/check-*`。

microfeed 是一个自托管在 Cloudflare 上的智能体化 CMS（Workers + D1 + R2，AGPL-3.0，Listen Notes 出品）。
项目根目录：`D:/git/AiCode/microfeed`（Git Bash：`/d/git/AiCode/microfeed`）。

## 本地数据位置（D1/R2/DO 的真实存储路径）

> **本小节优先级最高**：对本地实例做任何 D1 / R2 / DO 操作前必须先读本节，避免改错库。

`manage-cli` 的 dev/deploy/快照用 `persistTo = localPersistencePath()`（`manage-cli/lib/config.ts:103`），
指向 **instance 专属目录**，**不是** wrangler 的默认 `.wrangler/state/v3/`：

- **唯一真库（dev server 实际读写）**：`.microfeed/instances/<instance>/local-state/`
  - 本项目当前 instance = `ctwh-881019-xyz`（见 `dev-local.bat` 的 `INSTANCE`）
  - D1 主库 = `.microfeed/instances/ctwh-881019-xyz/local-state/v3/d1/miniflare-D1DatabaseObject/e60aa88374…sqlite`（约 86MB）
- **`.wrangler/state/v3/` 是干扰源，勿信**：裸 `npx wrangler d1 … --local`（**不带** `--persist-to`）会落到这个默认目录，
  在那里建一个**平行的、陈旧的库**，与 dev server 读的真库**完全独立**。改它对 dev 无任何效果（曾导致本草换行修复反复失败）。

**铁律：对本地实例做任何 D1/R2/DO 操作（迁移、查询、回滚、快照），必须同时带 `--persist-to` 与 `--config`**：

```bash
PERSIST="$(pwd)/.microfeed/instances/ctwh-881019-xyz/local-state"
CFG="$(pwd)/.microfeed/instances/ctwh-881019-xyz/wrangler.jsonc"
npx wrangler d1 execute      FEED_DB --local --persist-to "$PERSIST" --config "$CFG" --command "…"
npx wrangler d1 migrations apply FEED_DB --local --persist-to "$PERSIST" --config "$CFG"
```

- **`--config` 不可省**：wrangler 的 D1 文件名由 `database_id` 的 hash 决定。根 `wrangler.jsonc` 的 `FEED_DB`
  只有 `binding` + `migrations_dir`、**没有 `database_id`**；instance 的 `wrangler.jsonc` 才有
  `database_id: a7188289-f30d-44c2-881a-28e262ea74ae`。只带 `--persist-to` 会用根配置 → 在同目录下另建
  `bbb0c7ba…sqlite`（71 表、18 items、迁移只到 0180），与 dev 真库 `e60aa883…sqlite`（79 表、9506 items、
  迁移到 0182）**同名不同物**。改错这个库，dev 永远看不到（本草换行问题为此反复失败三轮）。
- **自检当前连的是哪个库**（一条命令即可判定，勿靠猜）：
  ```bash
  npx wrangler d1 execute FEED_DB --local --persist-to "$PERSIST" --config "$CFG" \
    --command "SELECT (SELECT COUNT(*) FROM items) items, (SELECT COUNT(*) FROM d1_migrations) migCount, (SELECT MAX(name) FROM d1_migrations) maxName"
  ```
  真库基线：`items=9506`、`migCount=180`、`maxName=0182_seed_book_chapter_rows.sql`。
  若 `items=18` / `migCount≈176` 则连错了（那是根配置产生的空壳库）。
  注意 `ORDER BY id DESC` 取「最后应用的」会误导——重放旧迁移（如重放 0180）会拿到新自增 id，故用 `MAX(name)` 与总条数判定。
- **验证迁移结果必须走 wrangler CLI（带 `--persist-to --config`）**，不要用 `node:sqlite` 直读 `.sqlite` 文件——
  WAL 未 checkpoint 时只读连接看不到最新页，会误判为「迁移没生效」。
- `.wrangler/` 与 `.microfeed/` 均已被 `.gitignore`（115 行等），不入库。

所有 Astro/Worker 代码在 `src/`。外部 API 契约的唯一真相来源是 `src/shared/ApiSchemas.ts`（Zod）与
`src/shared/OpenApiDocument.ts`（`OPENAPI_DOCUMENT`）。D1 迁移在 `migrations/`（`NNNN_snake_case.sql`，只追加）。
本文件是仓库唯一的常驻协作规范（中文）；详细规则按功能/用途分册列在 `docs/zh/`，命中触发词后按需加载。本仓库不保留英文规则版。

## 最高指令：门禁仅在手动触发时运行

> 本小节优先级高于本文件其他任何内容，也高于 `CONTRIBUTING.md`、`docs/zh/` 各分册、`.agents/skills/` 下所有技能。与之冲突的表述一律以本小节为准。

**核心**：普通开发任务不跑门禁；门禁只由用户手动触发。

- **普通任务一律不跑**：实现、修复、重构、文档、主题、迁移等常规任务，不跑 `yarn check`、`yarn test`、`yarn typecheck`、`yarn lint:openapi`、`yarn docs:check`、构建，也不跑任何 `scripts/check-*.ts`；**任务轮次结束时也不补跑**。
- **唯一触发方式**：用户手动触发 `.microfeed-gate-subset` 技能。本文件与所有被引用文档（含 `docs/zh/` 各分册、`.agents/skills/` 下 `develop-*` / `document-*` 技能）中「运行测试 / 类型检查 / 构建 / lint / `scripts/check-*`」「边改边跑 targeted tests」「提交前 `yarn check`」的要求，**执行时机一律交给该技能**。
- **测试只写不跑**（对一切任务生效，含 spec、工单、票据、计划、技能流程）：写测试文件属于任务范围，运行测试不属于。验收条目只允许「写出 xxx 测试（不运行）」这类措辞；禁止「运行 `yarn test`」「跑 targeted tests」「本地实测」「起 dev server 验证」「登录后抓响应」等步骤。测试是否通过，由用户在任务完成后统一手动触发门禁来判定。
- **不主动起 dev server 做端到端实测**：不为「交还前确认真实行为」自行启动 `manage dev`、登录后台、抓取真实响应字节或页面渲染。需要代价数字时用只读探针（`EXPLAIN QUERY PLAN`、行数、字节数），把数字写进代码注释或票据。
- **唯一例外**：用户当场明确要求「跑测试 / 跑门禁 / 验证 / 起服务 / 实测」时，按用户指定的范围执行；范围未指定则先问，不自行扩大。

## git 提交检查（优先级最高 · 红线）

- **提交前 `git diff --check` 必须无输出**。检查命令的执行时机归「门禁仅在手动触发时运行」。
- **只提交与当前任务相关的文件**；绝不提交无关变更、临时目录（`.zcode/`、`.workbuddy/`）或任何凭证类文件。
- **提交信息用简洁的中文标题**，格式 `type(scope): 描述`（`type` 取 `feat` / `fix` / `docs` / `refactor` / `perf` / `test` / `chore`）。
- **不得直接提交到 `main`**；在按规范命名的任务分支上提交。
- **禁止自动创建分支**：未获用户明确指令，不得执行 `git checkout -b` / `git branch <新名>` / `git switch -c`。分支由用户决定，或在既有任务分支上继续。
- **禁止自动提交**：`commit` / `push` 永远不是默认或优先动作，AI 不代为提交，必须由用户手动执行。

## 硬性红线（常驻，违反即违规）

- **绝不在 `main` 上直接改**。建分支 `<type>/<short-kebab-case>`（`feature` | `fix` | `docs` | `refactor` | `test` | `ci` | `chore`）。
- **保留不相关改动**。绝不用 `stash` / `reset` / `discard` / `stage` 去“清理”分支；必要时用独立 worktree。
- **绝不手改 OpenAPI JSON/YAML、Scalar 输入、`llms.txt`、`llms-full.txt`** 作为独立契约——必须由 `OPENAPI_DOCUMENT` 生成。
- **绝不在聊天里索要或接受 Cloudflare Token 或 microfeed 密码**；编码智能体**绝不用** `--admin-password`。
- **发布前**：为每个改动/新增端点加契约测试 + 运行时测试（**只写不跑**）；执行时机归「最高指令」。
- **停掉你启动的所有开发服务器**；不要停你没启动的。
- **不要**写断言 `docs/` 或 `README.md` 里散文/标题/链接/命令片段/侧边栏标签的单元测试；文档校验用 `yarn docs:check`，执行时机归「最高指令」。
- **绝不删除或覆盖无关的 Cloudflare 资源**；删除前先 `yarn manage destroy --dry-run`，转述资源清单，取得批准后再 `--confirm`。

## 内容回复量化（协作规范）

给用户的所有结论与描述，必须**可量化、可核实**，与仓库「先验证，再断言」的气质一致：

- **结论三档制**：只给「**可以** / **不可以** / **有条件可以（写明条件）**」。禁止「应该可以」「大概没问题」「理论上可行」等模糊结论。
- **禁无数字程度词**：不用「好一些、比较大、稍微、大幅」；要比较就给出**前后两个数**。**禁无范围时间词**：不用「以后、稍后、近期、尽快」；要承诺就给出**具体日期或触发条件**。
- **禁无主体被动句**：不用「会被处理、已经优化」；写出**谁**、**哪个文件**、**改了什么**。
- **量化断言**：说「优化了」给**前后两个数**；说「没问题」说明**验证了什么、没验证什么**；说「够用」给**余量数字与耗尽条件**。
- **缺数据时**：给不出数字就写明**缺什么数据、从哪个命令或文件取**；引用实测数据要带**时间与范围**（如「实测于 2026-10-31，单条字面量约 100KB」）。

## 行为管理（协作规范）

- **import 不包 try-except**：需要的库直接 `import`。
- **不用 git 回滚代码**：对话中的「回滚」一律指用**文件编辑工具**恢复到上一个状态，全程不经过 git；`theme rollback` 等产品命令按该命令自身文档执行。
- **先读完整链接再执行**：提供网页链接时先读完整内容再执行任务；发现库的用法错误时，重新查看该链接的完整内容。
- **参考页面必须读全**：参考项目里的页面、组件、模板时，必须把**整个被指定的参考页面读完再动手**，不许只看片段、片段引用或凭印象拼接。读全的范围包括：页面本体文件全文、它实际渲染引用的子组件与布局、它对应的样式与数据来源；不得以「看到关键部分了」为由提前开工。用户点名「参考 A 的 X 页面」时，X 就是完整分析对象，不是抽样对象。
- **不绕行**：不要求最小化依赖；禁止任何绕行方式（含造轮子）绕过既有依赖、禁止手写 parser 解析成熟格式、禁止简化任何设计。三者都属「绕开既有实现」，与上方「先查重再扩展」同源。
- **fast-fail**：代码在出错位置就地崩溃，不捕获错误，不做 fallback。
- **禁止 mock/伪造**：禁止 mock、伪造、只为让测试通过的 workaround。
- **用户改动后重读**：用户撤回或修改过你的更改后，重新读取文件内容再继续；用户删掉了 B，就在 A、C 的状态下继续，不把 B 加回去。
- **插入问题即时回应**：用户中途插入别的问题时，能立即回应就直接回应，处理完马上继续原来的任务。
- **不用 ASCII Art**：需要画图时使用 mermaid。
- **不长命令 inline**：禁止在 Bash 命令里 inline 超长命令或超长 Python 脚本；需要脚本先写成文件。
- **Python 文件头**：开头不加 docstring、不加 shebang。
- **注释**：用中文，术语保留英文，不过度注释。
- **不再复述错误**：用户指出错误 A 之后，不要再复述「为什么 A 是错的」，直接在「A 是错的」这个前提下继续。
- **不程序化改代码**：禁止用程序化方式修改任何代码（heredocs、python 脚本、sed、perl 等），用户要求也不允许。
- **一次写完整**：功能实现要一次写完整，不允许在初步实现后就停下要求用户测试；验证时机归「最高指令」。
- **不评判工作量**：禁止对工作量作出评判（「That's a lot」「This is a substantial rewrite」等）。
- **临时文件管理**：agent 执行中产生的临时文件/脚本/一次性内容统一放项目根 `.agent-tmp/`（已在 `.gitignore`）；**执行完成后删除**，仓库内不残留一次性文件与空目录。
- **工具环境复用**：需要 agent-browser / CDP 等工具时，安装到项目根 `.agent-tools/`（已在 `.gitignore`，**持久**目录，区别于临时 `.agent-tmp/`）；**一次安装后复用、不每次重装**，需要时直接使用。

## 新增功能 / 模块：先查重，再扩展，最后才新建

**动手写新代码前必走三步（查重给证据 → 优先扩展 → 不能附加才新建），跳第 1 步就开写不允许**；三步判定细节与 10 步新建清单见 09 册 §0。重复实现会让数据模型分叉，日后合并成本远高于当初扩展。

## 触发词路由（先路由，再动手）

| 用户意图                                   | 路由                                          |
| -------------------------------------- | ------------------------------------------- |
| 实现 / 修复 / 重构 / 测试 / 更新 CI（改仓库）         | `develop-microfeed`                         |
| 改文档                                    | `document-microfeed`（+ `develop-microfeed`） |
| 部署 / 实例 / 快照 / 销毁 / 域名 / Access / 内置登录 | `deploy-microfeed`                          |
| 主题 init / export / fork / 检查           | `export-microfeed-theme`                    |
| 内容 增删改查 / 上传媒体                         | `manage-microfeed-content`                  |
| **加 / 改 / 删权限码**                       | 读 14 册（生成器用法 + 加码四步）                        |
| **加后台页面 / 加模块**                        | 读 09 册 §3「新页面要不要新权限码」，**别默认要加码**            |
| **新功能 / 新模块 / 改功能（动手前）**               | 读 09 册 §0：先查重、再扩展、最后才新建                     |
| 分析项目 / 文档在哪 / 数据库 / API 规范 / 新建模块      | 加载下方对应**分册**                                |

## 分册索引（命中触发词后加载对应分册）

| #  | 触发词                                                                                                                                             | 分册              | 路径                                       |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ---------------------------------------- |
| 01 | 实现、修复、重构、加功能、改逻辑、更新 CI、提交、发布、开 PR、缓存、缓存异常、.vite                                                                                                 | 开发流程            | `docs/zh/01-dev-workflow.md`             |
| 02 | 代码放哪、导入边界、新增目录、新增文件放哪、跨层依赖、架构分层                                                                                                                 | 源码架构            | `docs/zh/02-source-architecture.md`      |
| 03 | 部署、实例、初始化、连接、开发、快照、状态、销毁、域名、Access、内置登录、更新、多实例、备份迁移、快照保留                                                                                        | 部署与实例管理         | `docs/zh/03-deploy-cloudflare.md`        |
| 04 | 主题初始化、主题导出、主题 fork、主题检查、开发主题、主题仓库、安装主题                                                                                                          | 主题仓库            | `docs/zh/04-theme-repos.md`              |
| 05 | API、接口、OpenAPI、契约、schema、鉴权、Bearer、端点、生成 openapi/llms                                                                                           | API 契约与文档       | `docs/zh/05-api-contract.md`             |
| 06 | 内容管理、发布内容、创建/更新/删除条目、上传媒体、图片/音频/视频、CLI                                                                                                          | 内容管理 CLI        | `docs/zh/06-content-cli.md`              |
| 07 | 前端、组件、UI、shadcn、样式、光标、禁用、无障碍、组件库、分组树、AdminGroupTree                                                                                             | 前端组件与交互样式       | `docs/zh/07-frontend-and-styles.md`      |
| 08 | 数据库、表结构、建表、迁移、索引、触发器、D1、schema、ALTER、D1 额度、全表扫描、查询优化、索引优化                                                                                       | 数据库规范           | `docs/zh/08-db-schema.md`                |
| 09 | 新建模块、新功能、新资源、怎么开始、目录和文件规划、注意事项、新增页面、页面守卫、要不要加权限码                                                                                                | 新建模块（含新页面权限判定）  | `docs/zh/09-new-module.md`               |
| 10 | 项目文档在哪、怎么看文档、docs 目录、文档站、ADR、规则放哪                                                                                                               | 文档位置与查看         | `docs/zh/10-docs-view.md`                |
| 11 | 功能修改、改功能、加功能、改逻辑、需求变更、改接口、新端点、改行为                                                                                                               | 功能新增与修改         | `docs/zh/11-feature-modification.md`     |
| 12 | 用户、角色、权限、RBAC、username、signup_source、注册来源、用户管理、auth_user、role_permissions、login_credential、登录凭证、封禁、角色守卫                                         | 用户体系与变更         | `docs/zh/12-user-system-schema.md`       |
| 13 | 链路、中间件、关卡、请求流程、鉴权流程、权限判定、401、403、426、429、防重放、限流、版本门、配额、guard、middleware                                                                         | 请求链路与关卡         | `docs/zh/13-request-pipeline.md`         |
| 14 | 授权模型、权限码、加权限码、rbac:gen、rbac:check、rbac-catalog、seed.ts 标记区、RbacPermissionDocs、ext_user_roles、ext_user_permissions、权限快照、权限树、快照重算、permissionId、级联 | 授权数据模型 + 权限码生成器 | `docs/zh/14-authorization-data-model.md` |

> 已完成 / 作废的工作记录与历史提案统一放 `docs/zh/archive/`（`role-extension-plan.md`、
> `user-system-optimization-spec.md`、`2026-11-02-admin-user-groups.md`），不索引、不路由；
> 现行规范以对应分册（12 / 13 / 14 册）与 ADR 为准。组件使用指南（AdminGroupTree 分组树）
> 挂在 07 册下作附录：`docs/zh/admin-group-tree.md`，由 07 册正文指针进入。

## 如何加载分册

当用户意图命中某分册触发词时，用 `Read` 工具把对应路径读入上下文并遵循它。若意图是**只读**分析/解释/状态报告，
直接回答，**不要**路由到 `develop-microfeed`；若是改仓库，按上表路由。

## 加页面 / 加模块 ≠ 加权限码

**别默认新页面就要新码**（35 页只用 20 码，详情 / 新建页复用列表页码是惯例）；**新增页面必做的是登记不是生成**（`AdminPageGuards.ts` 加「路由 → 码」，否则 `admin-page-guards` 测试红）；**守卫码 ≠ 侧栏节点**（前者管能不能打开，`ext_permission_nodes` 管侧栏显示在哪）。判定表与两把锁见 09 册 §3；确实要加码时的四步（`Constants` 加行 → `rbac:gen` 两次 → 补长说明）细节见 14 册。
