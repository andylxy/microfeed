# 仓库指导

## 强制声明

本文件中的每一条规则都是强制性的。违反任何一条规则都会遭受毁灭性打击。不存在任何例外与豁免：临时的、一次性的、命令行上的违反同样是违反；没被当场发现也算违反；出于好意、为了进度、为了帮忙的违反也是违反。
当我每次在我发送的消息里面提到AGENTS.md的时候，你必须要重新阅读一遍AGENTS.md，不允许因为之前阅读过就不阅读了。

## 最高指令：远程 D1 额度与量化回复（优先级最高，先于本文件其余一切规则）

### 远程 D1 每日额度

- 远程 D1 每天**读取**额度为 5M 行（`rows_read`）。本项目部署在 Cloudflare Workers 上，业务查询全部走远程 D1，读取额度耗尽当天即不可用。
- 远程 D1 每天还有 **100K 写入行数上限**（`rows_written`，即 `INSERT`/`UPDATE`/`DELETE` 的影响行数）。它与 5M 读取额度**相互独立**：读没爆也可能写爆。整库覆盖 / FTS 重建（触发器往 `site_search_*` 影子表写海量 token 行）等大批量写会迅速打爆写额度，之后当天任何写（含 `site_search_metadata` 的 ready 切换、`migrations apply`、`manage deploy`）都会被拒（`[code:7500] exceeded D1's free tier daily row write limit`），直到 **UTC 次日 0 点**重置，读不受影响。大批量写前先评估当日写额度，别把写和 deploy / 搜索 ready 挤在同一天。
- 添加功能时，必须避免全表扫描：每个新查询先确认所走索引，把预计扫描行数与读取字节数写清楚再动手。
- 出现全表扫描时，必须给出修复方案，并以量化方式显示：当前扫描行数、当前读取字节数、修复后预计读取字节数、所走索引或需新增的索引定义。

### 内容回复量化

- 一切内容回复按量化方式给出，禁止模糊不清。禁止「大概」「以后」「可能」这类没有边界的措辞。
- 结论必须明确：可以就是可以，不可以就不可以，没有折中的方式。
- 涉及数值、范围、时间、数量的判断，必须给出具体数字或可验证的条件；暂时给不出数字时，写明缺什么数据、从哪里取，禁止用形容词代替数值。

## 最高指令：主题安装 / 主题写库必须用绑定参数（优化优先级最高）

- 一切向 `themes` / `theme_drafts` 写行的代码——Worker `src/server/themes/ThemeStore.ts`、管理 CLI `manage-cli/theme.ts`，以及任何后续新增的主题安装 / 发布 / 草稿 / 迁移路径——都必须使用**绑定参数**：SQL 里只写 `?` 占位，值经 `.bind(...)` / `queryD1WithParameters(...)` 传。严禁把 `bundle_json` 等大列用模板插值拼进 SQL 字面量。
- 理由（量化）：D1 对**单条 SQL 语句的字面量长度有上限，实测约 100KB**（75KB 可通过、135KB 报 `SQLITE_TOOBIG`）。中文主题 `feed-zh` 单个 `bundle_json` 达 **125KB**，按字面量拼必失败；绑定参数不计入 SQL 文本长度，可正常入库。
- 改动任何主题安装 / 写库代码前、以及安装主题时，必须先确认走的是绑定参数方式（不是拼字面量）。
- 该不变量由 `tests/unit/theme-install-bound-params.test.ts` 守护：写 `themes` / `theme_drafts` 的 INSERT SQL 中不得出现 `${` 插值。
- **数据同步场景同样适用**：本地→远程同步、整库覆盖、差量补推等一切向 `themes` / `theme_drafts` 写行的路径（含 `.scratch` 下的一次性同步脚本、D1 REST 批量接口）都必须走绑定参数——SQL 文本只写 `?` 占位，值经 `.bind(...)`、`queryD1WithParameters(...)` 或 REST `{sql, params}` 传。把大列拼成 SQL 字面量（`VALUES ('<大列文本>')`）、以及「占位 INSERT + 分块 UPDATE 拼列」都是历史应急通道，不作为常规方案。
- **安装或同步主题前的确认清单**（三条全部满足才算通过）：① 写库 SQL 文本中只有 `?` 占位、无任何大列字面量；② 全部值（含 `bundle_json`、`preview_fixture_json`）经绑定参数传递；③ 预期效果：feed-zh 整行 `bundle_json` **一条 INSERT 即可入库**，不出现为绕过文本长度上限而做的分块 UPDATE。若不满足（例如拿到的是字面量 SQL 文件），先改造通道再执行。
- **同步额度纪律**（2026-10-18 实测教训）：单表同步失败不得触发全表补跑——整表重推会把日写额度（100,000 行）翻倍烧光；核对通过即零写入；一次到位、不重推。

## 最高指令：门禁仅在手动触发时运行（普通任务不跑）

- 普通开发任务（实现、修复、重构、文档、主题、迁移等）**不跑**门禁：不跑 `yarn check`、不跑 `yarn test`、不跑 `yarn typecheck`、不跑任何 `scripts/check-*.ts`，也不在任务轮次结尾补跑。
- 门禁只由**用户手动触发**的 `.microfeed-gate-subset` 技能运行。本文件下文「git 提交检查」「开发工作流」「架构治理」「API 规范与文档」「已部署实例的部署流程」等节中所有「运行 `yarn check` / `yarn test` / `yarn typecheck` / `yarn build` / `yarn lint:openapi`」的要求，**一律改为由该手动技能执行**，不再在普通任务中自动执行。
- `.agents/skills/develop-microfeed`（及 `document-microfeed`、`develop-microfeed-theme`）技能中「边改边跑 targeted tests / checks」「提交前 `yarn check`」的步骤，同样以本条为准，不自动执行。
- **测试代码只写不跑（对一切任务生效，含 spec / 工单 / 票据 / 计划 / 技能流程）**：写测试文件是任务的一部分，运行测试永远不是。验收条目里只允许出现「写出 xxx 测试（不运行）」这类措辞，禁止出现「运行 `yarn test` / 跑 targeted tests / 本地实测 / 起 dev server 验证 / 登录后抓响应」这类步骤。测试是否通过由用户在任务完成后统一手动触发 `.microfeed-gate-subset` 时决定。
- **不主动起 dev server 做端到端实测**：不得为了「交还前真的跑到预期行为」自行启动 `manage dev`、登录后台、抓取真实响应字节或页面渲染。需要代价数字时用只读探针（`EXPLAIN QUERY PLAN`、行数、字节数）并把数字写进代码注释或票据，实测同样只在用户当场明确要求时执行。
- 例外：用户当场明确要求「跑测试 / 跑门禁 / 验证 / 起服务」时，按用户指定的范围执行。

## 目录

- 最高指令：远程 D1 额度与量化回复
- 最高指令：主题安装 / 主题写库必须用绑定参数（优化优先级最高）
- 最高指令：门禁仅在手动触发时运行（普通任务不跑）
- 最高指令：git 提交检查
  - 本环境：提交由用户手动执行（AI 不代为提交）
  - git 管理红线（AI 行为约束）
- 最高指令：环境边界（开发在本地，生产由用户管理）
  - 开发环境 = 本地项目环境
  - 生产环境由用户主动管理
  - 由此产生的要求
- 开发工作流
  - 票据边界（收窄规则）
- 源码架构
- 架构治理（门禁脚本强制）
  - src/server/ 顶层目录白名单
  - 新增端点登记
  - ADR 单一编号空间
  - 迁移命名与回滚
- API 规范与文档
- 前端组件
  - 管理后台列表页：取数代价按行读判断
- 管理后台左侧菜单（导航树）
- 交互样式
- 管理后台国际化
- 内容管理 CLI
- 主题仓库
  - 中文主题 `local.feed-zh`（本项目维护的中文主题）
- 实例管理与 Cloudflare 部署
  - 本项目不使用预览环境（preview）
- 已部署实例的部署流程（本机已验证，可直接复现）
- 已部署的 microfeed 实例
- 本机环境注意事项
- 本地 D1 数据库文件管理
- Vite 依赖缓存目录（`.vite*`）管理
- 语言
- 行为

## 最高指令：git 提交检查（优先级最高，任何提交前必须执行）

- 任何 git 提交之前：`git diff --check` 必须无输出，并运行本仓库的检查命令（完整门禁 `./node_modules/.bin/yarn check`；至少 `./node_modules/.bin/yarn typecheck` 与 `./node_modules/.bin/yarn test`，涉及构建改动时 `./node_modules/.bin/yarn build`）。检查未通过时禁止提交。
- 只提交与当前任务相关的文件；绝不提交无关变更、临时目录（如 `.zcode/`、`.workbuddy/`）或任何凭证类文件（凭证的可读范围与禁令见「内容管理 CLI」一节）。
- 提交信息使用简洁的中文标题，格式 `type(scope): 描述`（`type` 取 `feat`/`fix`/`docs`/`refactor`/`perf`/`test`/`chore` 等；本仓库提交记录即此惯例）。
- 不得直接提交到 `main`；在按规范命名的任务分支上提交（见「开发工作流」）。

### 本环境：提交由用户手动执行（AI 不代为提交）

本沙箱在文件系统层拦截工作区内的删除（改为移进 Windows 回收站），git 提交时对 lock 文件与 ref 目录的清理被改写成搬运，分支引用会随 `.git/refs/heads/<ns>` 一起离开仓库：commit 报成功，`git log` 却说 `does not have any commits yet`、`git status` 把整仓显示成已暂存。提交对象与 `.git/logs/HEAD`（reflog）从未受损，引用可从 reflog 一行恢复；任何碰索引的 git 命令都会产生被搬走的 `index.lock`。

⇒ 由用户在自己终端手动提交（那里没有这层拦截，一次即成）。AI 的职责是：改代码、跑完整验证、给出精确的 `git add` 路径与提交信息，交给用户执行。若确实需要 AI 代为提交，走技能 `git-safe-commit` 的流程：提交后立刻 `git rev-parse HEAD` 复核，被吃则从 reflog 重写引用（先 `mkdir -p` 父目录）。

### git 管理红线（AI 行为约束）

- **禁止自动创建分支**：未获用户明确指令，AI 不得执行 `git checkout -b` / `git branch <新名>` / `git switch -c` 新建分支；分支由用户决定，或在既有任务分支上继续。
- **禁止自动提交（提交不作为默认 / 优先动作）**：commit / push 永远不是默认或优先动作，AI 不代为提交，必须由用户手动执行（见上「本环境：提交由用户手动执行」）。确需 AI 代为提交时，仅走 `git-safe-commit` 技能流程，并在提交后 `git rev-parse HEAD` 复核。

## 最高指令：环境边界（开发在本地，生产由用户管理）

### 开发环境 = 本地项目环境

一切改动、验证、度量、测试，一律在本地项目环境完成，使用的全部是本地资源：

- **本地 D1**：`.microfeed/instances/<实例>/local-state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite`（注意真正的业务库是这个 `<hash>.sqlite`，同一级的 `<实例名>.db` 可能是 0 字节的遗留文件，不代表库已损坏）。读代价、索引、查询计划的结论只以本地库实测为准。
- **本地 R2 / KV / 队列 / 缓存**：本地实例的绑定，同样只在本地读写。
- **本地主题**：改 `themes/feed-zh/` 后按「主题仓库」一节的流程递增版本并安装到本地 D1 的 `themes` 表，再在本地站点验证。磁盘上的主题源文件不直接参与渲染，不重新安装就看不到改动。
- **本地 dev server**：`./node_modules/.bin/yarn manage dev --local --instance <实例>`。
- **本地测试与探针**：`vitest`、`tsx` 脚本、`curl 127.0.0.1` 全部在本地执行。

### 生产环境由用户主动管理

生产环境（远程 D1、远程 R2、已部署的 Worker、远程主题）由用户自行管理：

- 不主动连接、查询、改动、部署任何生产资源。`wrangler d1 execute --remote`、`manage deploy`、`manage status`、远程主题的 install / activate / delete 等命令，只在用户明确要求时才执行。
- D1 额度与读代价的结论一律以本地实测为准，不连远程取数；需要生产数据才能回答的问题，明确说出缺什么数据、从哪里取。
- 用户要求操作生产前，先复述命令、影响范围与风险，得到确认后再执行。
- 需要用户在生产环境确认的事项（部署、迁移、主题激活、数据修正），把要执行的命令与提交信息整理好交给用户，由用户在自己终端执行。

### 由此产生的要求

- 本地跑过的验证必须如实报告：命令、范围、结果、失败项，不把没跑过的说成跑过。
- 本地无法验证的结论，标注为未验证，不当成事实陈述。
- 交还工作前，任务范围内的改动要静态写完（代码 + 测试文件 + 所需的索引与迁移）；是否运行归上一节「门禁仅在手动触发时运行」——不自行跑测试、不起 dev server。本地环境本身出问题导致连静态工作都无法进行时，说清卡在哪、卡在哪个进程或文件，并且不动不属于自己启动的进程。

## 开发工作流

- 当用户要求实现、修复、重构、测试、编写文档、更新 CI 或以其他方式更改本仓库时，使用 `develop-microfeed` 技能。只读提问、解释、评审或状态报告不使用它。
- 文档变更需同时使用 `document-microfeed` 技能。对捆绑默认主题或通用主题起步模板的变更，需同时使用 `develop-microfeed-theme` 技能。
- 不要直接在 `main` 上做更改。创建或继续一个名为 `<type>/<short-kebab-case>` 的专注分支，`<type>` 为 `feature`、`fix`、`docs`、`refactor`、`test`、`ci` 或 `chore`。已存在的不规范分支如果已包含任务工作，可以继续使用。
- 保留无关变更。绝不为清理任务分支而 stash、reset、discard 或 stage 它们；必要时使用隔离的 worktree。
- 发布前运行 `git diff --check` 和 `yarn check`，只提交任务范围内的文件；当 GitHub 认证可用时，向 `microfeed/microfeed` 打开草稿拉取请求。
- 编辑和测试完成后，交还工作之前必须停止自己启动的每个开发服务器，确认每个进程已退出，让人类操作者可以无端口冲突地运行 `yarn dev`；绝不停止不是自己启动的服务器。

### 票据边界（收窄规则）

- 切分原则的文字只存在于生成工单与票据的两个技能里：`~/.agents/skills/to-spec/SKILL.md` 的 Implementation Decisions 一节，与 `~/.agents/skills/to-tickets/SKILL.md` 的 `<vertical-slice-rules>` 和两份票据模板。本节不复述这些规则，只登记它们在本仓库对应到的事实；两处文字冲突时以技能为准，改本节而不改技能就是制造互相矛盾的定义。
- 本仓库的接缝，即一张票据纵向穿过的层：数据层 `src/server/**`，端点层 `src/pages/**`，组件层 `src/components/admin/**`，迁移与索引 `migrations/**`，规范层 `src/shared/ApiSchemas.ts` 与 `src/shared/OpenApiDocument.ts`，文案层 `src/shared/i18n/en.ts` 与 `zh-CN.ts`，文档与语汇表 `CONTEXT.md`、`docs/novel-cms/adr/**`、`AGENTS.md`。写工单时逐张列出该票穿过的接缝。
- 「与行为同票」的机械依据来自门禁，不是偏好：`scripts/check-adr.ts` 要求 `src/` 与 `migrations/` 里的裸 `ADR-NNNN` 引用解析到 `docs/novel-cms/adr/**` 下的真实文件，所以引用某条 ADR 的行为票必须同时创建该文件；`scripts/check-i18n.ts` 要求 `zh-CN.ts` 的键形状镜像 `en.ts`，所以新文案键随用到它的组件同票；`scripts/check-endpoint-registration.ts` 要求 handler 与登记一致，所以新端点随它的首个调用方同票。三条门禁的逐条规则见「架构治理」与「API 规范与文档」两节。
- 票据与文档里的数字在本仓库的取数地点：`node:sqlite` 只读探针脚本的 stdout 文件与其 `EXPLAIN QUERY PLAN` 输出，留在 `.scratch/<feature-slug>/`（`.gitignore:134` 覆盖该目录），票据写出该文件路径。D1 的 `meta.rows_read` 需要 Miniflare 绑定，探针拿不到的口径要标注为推得值。
- 写测试断言前先读被断言的函数本体，确认它是否顺便插入新行、写入的是 `null` 还是空串、返回哪些类型的行；一次阅读代替一次红色断言。这条在「测试只写不跑」的规则下是强制的。

## 源码架构

- 所有 Astro 与 Worker 应用代码放在 `src/` 下。
- 使用绑定、D1、R2 或请求运行时状态的 Worker 专属代码放在 `src/server/`。server 模块可以从 `src/shared/` 导入，绝不能从 `src/client/` 或浏览器组件导入。
- 浏览器专属辅助代码放在 `src/client/`。React 客户端组件可以从 `src/client/` 与 `src/shared/` 导入，绝不能从 `src/server/` 导入。
- 运行时中立的常量、类型、路径与工具放在 `src/shared/`。
- 仓库部署工具保留在 `manage-cli/`。它可以从 `src/shared/` 导入运行时中立模块，不得导入 Worker 专属或浏览器专属模块。
- Astro 路由与中间件负责协调 server 模块和 UI 组件。保持路由文件精简，不引入独立的 Worker 入口点。
- 稳定的、未加工的公共资源放在 `public/`；不要把它们移入源码包，也不要在没有明确迁移方案的情况下更改其公共 URL。

## 架构治理（门禁脚本强制）

以下规则由 `scripts/check-*.ts` 四个门禁脚本执行，接入 `yarn check`，违反即退出非零。脚本只读不写，输出格式为 `文件:行 <规则编号> <描述>`；行号为 0 表示该规则作用于整个文件或整个文件名，不指向具体某一行。

### src/server/ 顶层目录白名单

- 判断理由：`src/server/` 顶层原有 23 项（18 目录 + 5 文件），其中 4 个是按特性命名的 `app-*` 目录，把共享层（`cache/`、`auth/`、`api/`）和领域层混在同一级。2026-10-12 重排把四个 `app-*` 特性收入 `src/server/app/{announcement,permission,version}/`、`tcm/app-cache.ts` 移入 `cache/`，顶层变为 20 项（15 目录 + 5 文件）。新增功能若继续开新顶层目录，会重新把共享层淹没在特性目录里。
- 门禁：`scripts/check-server-layout.ts` 维护 21 项白名单（2026-10-18 新增 `cloud-usage`）。新增任何顶层项必须同时修改脚本白名单，否则 `yarn layout:check` 失败。

### 新增端点登记

- 判断理由：端点漏登记有两种静默缺口。① 移动端 `/api/AppBookRequest/` 有两套登记表（`APP_BOOK_REQUEST_ROUTES` 做大小写归一化、`APP_BOOK_REQUEST_CONTENT_SUFFIXES` 做鉴权开关）：归一化缺失导致任意大小写请求 404，鉴权缺失导致中间件把端点当匿名服务（fail-open）。② 公开 API 的 handler 若既不在 OpenAPI 规范里、也不在豁免类里，它仍可经 HTTP 访问，但审查 API 表面的人无从得知它存在。
- 门禁：`scripts/check-endpoint-registration.ts` 对 `src/pages/api/` 下全部 56 个 handler 分三类——25 个公开 handler 必须对应 `OpenApiDocument.ts` 里的 path（规范的 path 相对 `/api/v1/`，无版本 `/api/...` 是同一 path 的 legacy 别名，20 条 path 每条至少一个 handler）；14 个 `/api/AppBookRequest/*` 另走 App 登记表；余下 17 个归入四个豁免类——四个 `/api/app/{version,announcements,search-permission,mingci-permission}`、`/api/auth/*`（better-auth 自管，catch-all 路由）、规范与文档元端点（`openapi.*`、`llms*.txt`，含 `/api/v1/openapi.html` 与 `/api/v1/` 两个 `.astro` 路由）、`/api/` 根路由。六条规则 ENDPOINT-001..006 的逐条定义见脚本头注释：除上面的三分类外，还要求 catch-all 路由可识别、App 登记表与磁盘 handler 双向一致、且每个 AppBookRequest handler 必须落在内容路由（需鉴权）或匿名路由之一。
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

- **豁免：移动端专用通道不注册进 OpenAPI 规范**——`/api/AppBookRequest/*`、`/api/app/version`、`/api/app/announcements`、`/api/app/search-permission`、`/api/app/mingci-permission`。`AppBookRequest` 命名空间是对旧 .NET 后端接口的 1:1 移植（路径与响应 JSON 逐字节一致，App 只换 baseUrl、零改码），属 App 与后端之间的内部通道，并非面向公众的 feed API；其响应信封 `{code,data,msg}` 与字段形状由 `.scratch/tcm-import/spec.md` §6 与 `tests/worker/tcm-app-routes.test.ts` 锁定（golden 逐字节比对）。后四个端点由 App 调用、**均需登录凭证 + 各自一个 App 能力权限码**（升级描述符 `app:version:read`、运营公告 `app:announcement:read`、搜索 `app:search:global` / `app:search:book`、名词解释 `app:mingci:view`；其中 version 与 announcements 在 2026-10-16 之前是**匿名**的，因为当时以为存在「没有凭证的客户端」—— 实测不成立，全新安装的 App 带 `SecurityConfig.getApiKey()` 内置凭证），同样不面向公众。运行时覆盖由 `tcm-app-routes.test.ts` / `tcm-app-reads.test.ts` / `tcm-app-auth.test.ts` / `app-version-routes.test.ts` / `app-announcement-endpoint.test.ts` / `app-search-permission.test.ts` / `app-mingci-permission.test.ts` 提供，不在 `OpenApiDocument.ts` 重复登记。除这五条移动端通道外，`/api/auth/*`、规范与文档元端点（`openapi.*`、`llms*.txt`）与 `/api/` 根也不进 OpenAPI 规范——完整分类见「架构治理 → 新增端点登记」，以该节与 `scripts/check-endpoint-registration.ts` 为准。
- `GET /api/AppBookRequest/GetAllMingCi` 复用 `app:mingci:view` 判定做服务端纵深防御：缺码/无凭证/DB 故障均 fail-closed 返回空数组 + `no-store`；不挂该权限码的 DOMAIN_RULES 规则，以免缺码返 403（由 `tests/worker/app-mingci-getall.test.ts` 覆盖）。

## 前端组件

- 新前端工作以及实质性修订现有界面时，优先使用 `src/components/ui/` 中项目自有的 shadcn/ui 组件；shadcn/ui 提供相应变体时，使用 `components.json` 中选定的 Base UI 变体。
- 优先扩展共享的 shadcn/ui 组件，不创建一次性控件，不引入另一个原语组件库。用共享组件和设计 token 组合界面，用 `cn` 助手合并类名，保持 Base UI 提供的无障碍行为完好。
- 已在改动的旧界面渐进迁移即可；不要仅仅为了采用 shadcn/ui 而重写无关的正常工作界面。

### 管理后台列表页：取数代价按行读判断

- 列表/看板类页面（`.astro` + React 组件）的取数代价以 D1 **行读**为准：一次请求只读页面当前要展示的范围。不得为了在客户端凑一个分页控件而把整本或整表读回来——客户端切片不产生任何行读，代价在那一次请求本身。
- 行数可能很大的列表走服务端分页（`themes` 走 `listing.pagination` 与 `THEME_LIST_PAGE_SIZE`），或按实体按需读取（卷看板：点书只读该书的书目，点卷才读该卷的条目）。

## 管理后台左侧菜单（导航树）

左侧导航是一棵任意深度树，由 `ext_permission_nodes` 权限节点表驱动（ADR-0038 自持树、ADR-0041 菜单并入、ADR-0042 D6 切换），前端在 `AdminSidebar` 里递归渲染 `AdminMenuItemLink`。分组节点可展开/收起；当前页所在的祖先链自动展开；展开态按账号记进 `localStorage`。

### 数据来源与结构

- 侧栏行集 = 桌面端（`audience = 'desktop'`）的 `kind = 'group'` 分组行与 `kind = 'page'` 页面行；码行（`kind = 'code'`）是角色编辑器里的勾选项，不进侧栏；App 端节点没有侧栏。表自引用：`parent_code` 指向同表父行，带 `ix_ext_permission_nodes_parent` / `_audience` / `_kind` / `_sort` 四个索引。
- 页面行携带 `path`（相对 `/admin/` 的入口路径，分组行为 NULL）与 `entry_code`（入口门码），分组行两列均为 NULL；另有 `icon`、`sort`、`is_visible`、`i18n_key`、`source`、`created_at_ms` 与 `name_zh` / `name_en`（均可空，作为可选覆盖）。
- 组装在 `src/shared/AdminSidebarItems.ts` 的 `buildSidebarItems`：按 `(sort, code)` 读序；`entry_code` 为空的页面行只挂码、不进侧栏；门码非空时按账号权限集合判定（持 `*` 通配视为全见）；子项全空的分组剪掉，父分组被滤掉时子分组升为顶层；分组本身不是页面，链接指向第一个子项。查询在 `src/server/admin/menu.ts` 的 `readAdminMenu`，门控走 `rbacAllows`。
- 页面可达性由页面自身的 `requirePagePermission` 决定，判据是该页面节点绑定的同一个门码（一入口一门码，故为相等）。两侧一致由迁移人工比对、`tests/unit/admin-page-guards.test.ts` 静态重放迁移、`tests/worker/admin-menu.test.ts` 的「菜单行 ↔ 页面节点」对齐检查共同保证。
- 同一份组装器给 `/admin/rbac/` 的「侧栏预览」复用：预览按所选角色的权限集合拼行集，运营调整门码即可看到侧栏的变化，两处不会漂移。
- `ext_menu` 表仍在：全新安装先走它的种子，0133 再把配对行回填进节点表；`/admin/menu` 只读视图也仍读它。

### 三级子项的注入

`SETTINGS`、`API`、`WEBHOOKS` 三个页面节点（`page_settings` / `page_api` / `page_webhooks`）没有第三层子节点，它们的第三级由 `AdminSidebar` 的 `SUB_SECTION_BUILDERS` 在渲染时注入（这些子项不是数据树的一部分，是页面分区或真实子页）：

- `SETTINGS` → `ADMIN_SETTINGS_SECTIONS`（11 个同页锚点，形如 `设置#custom-code`），活动项跟随正文滚动所在分区（`settings-section-state` store 同步）。
- `API` → `ADMIN_API_PAGES`（真实子页）。
- `WEBHOOKS` → `ADMIN_WEBHOOK_PAGES`（真实子页）。

新增一个域（又一个需要三级的二级节点）就在 `SUB_SECTION_BUILDERS` 加一行（键写页面节点码），并把清单写进对应模块（`AdminSettingsNavigation` / `AdminApiNavigation` / `AdminWebhookNavigation`）。每个页面节点保留自己的 `menu.item.*` 文案键——`menuEntryLabelKey` 按 `group_` 前缀判分组、不看有没有子节点，所以带注入子项的页面节点不会变成分组键。

### 名称解析

渲染优先级（见 `src/shared/AdminNavigation.ts` 的 `adminMenuItemLabel`）：`name_zh` / `name_en` 当前语言列优先，该列为空取另一列，两列皆空回退到 `menu.item.*` / `menu.group.*` 的 i18n 文案。管理页表格（`/admin/menu`）有一列「生效名称」显示这条优先级算出的当前实际文本，运营无需切换语言即可看到菜单显示内容。

### 菜单管理页 `/admin/menu`

只读一版（ADR-0042 D6）：菜单入口已并入权限树，改名 / 图标 / 排序 / 显隐 / 父级 / 新建分组全部关闭——前端所有操作经 `postOps` 切断，服务端 `POST /ajax/menu/save` 一律返回 `errors.menu.readOnly`（409）。页面保留给运营对照：左侧树与右侧详情面板的控件全部置灰，顶部横幅指向「角色管理」页。整页连同 `system:menu:manage` 码与 `page_menu_management` 节点的退役属下一批（ADR-0041 D5）。

树里的注入子项：三个页面节点的第三级仍由 `menuInjectedRows`（`MenuTreeNode.tsx`）合成只读行，树与侧栏层级一致；这些行只进渲染行集，右侧面板、拖拽、删除、保存拿的都是数据行，写不进任何 op。行的展开是顶层手风琴（同左侧导航），「全展开 / 全收起」只作用于当前展开顶层内部的子层。行 id 前缀：迁移种子行以 `m_` 开头，管理页自建行以 `mm_` 开头（`MENU_ROW_CUSTOM_ID_PREFIX`）。图标名清单 `src/shared/MenuIconNames.ts` 与 `AdminMenuItemLink.MENU_ICONS` 一一对应，由 `tests/unit/menu-admin-ops.test.ts` 守护。

### 渲染防闪烁

`AdminShell.astro` 给 `AdminSidebar` 岛加了 `transition:persist="admin-menu-sidebar"`，导航时组件实例保留、只换 props，避免每次切换都重建侧栏造成的闪烁。其余四个侧栏岛不加该属性。

## 交互样式

- 每个启用的可点击控件必须使用 pointer 光标，包括链接、按钮、单选按钮、复选框、开关以及带 `role="button"` 或 `role="switch"` 的自定义控件。优先在全局样式表中统一约束共享交互行为，不在每个组件重复光标工具类。
- 禁用的控件必须使用原生 `disabled` 属性或 `aria-disabled="true"`，并显示 `not-allowed` 光标。

## 管理后台国际化

- 后台通过全局实例使用 i18next + react-i18next（后台是 Astro islands，没有共享的 React Provider）。资源在 `src/shared/i18n/en.ts` 与 `zh-CN.ts`；zh-CN 的键形状必须镜像 en（编译期检查）。en.ts 是键形状的唯一事实来源，新增键时在 `tests/unit/i18n.test.ts` 中保持键一致性测试通过，并跑「键存在性 + 中英文一致性」校验（`tsc` 通过 ≠ 键正确）：键存在性扫描的正则必须能覆盖含空格与撇号的英文整句，否则会漏报。
- **语言解析顺序（三处必须一致）**：显式偏好 cookie `microfeed-admin-language` → `Accept-Language` / `navigator.language`。服务端用 `adminLanguageFromRequest(request)`；内联脚本 `AdminLanguageScript.astro` 与客户端 `detectBrowserLanguage()`（`src/client/i18n.ts`）用同样的顺序。任一处漏掉 cookie，首屏就会渲染成错的语言（先英文、水合后翻中文的闪烁）。切换语言会 `location.reload()`，使服务端渲染的标题与 `<html lang>` 一致。
- **有文案的岛屿用 `client:only="react"`**：`client:load` 会服务端渲染，而服务端 i18next 单例恒为 en（没有 `window`）→ 首屏出英文。保留 `client:load` 的仅限无文案（`Toaster`）或纯图标触发器（`AdminThemeMenu`、`AdminLanguageMenu`，语言切换器必须立即可用）。
- **公开 API 错误正文按 `Accept-Language` 本地化，不读管理端 cookie**，避免公开规范随管理员偏好变化；响应头与状态码一律不变。
- **管理后台日期/时间统一固定数字格式**（站点要求，2026-10-14）：一律用 `src/client/admin-date-format.ts` 的 `formatAdminDateTime`（`2026-10-14 11:29:42`，24 小时制、本地时区）——**所有**日期显示（含条目列表、搜索结果这类列表列）都用它，不再有「仅日期」变体。**禁止** `toLocaleString()` / `Intl.DateTimeFormat` / 各语言不同的写法：它们随语言与系统变，同一个后台在两台机器上会渲染成两种样子，审计/日志这类要「对齐着看」的时间尤其不能这样。不要在任何服务端渲染路径里用它（workerd 是 UTC）。
- 待办：日期/数字本地化（`humanizeMs` 硬编码 en-US，其输出是公开 feed 的一部分，需要单独谨慎修改）。
- 更改 UI 文案（i18n）时，既有测试可能断言旧英文文案；运行测试并把断言更新为对应的 i18n 键调用或新的渲染文本。

## 内容管理 CLI

- 当用户要求编码代理列出、读取、创建、更新、删除内容或为 microfeed 站点上传媒体时，使用 `manage-microfeed-content` 技能。更改 CLI 实现或文档本身时不使用该操作技能。
- 把 `docs/microfeed-cli.md` 视为内容管理 CLI 的命令、选项、输出与安全规范的唯一权威参考。CLI 行为变化时保持它与 `packages/cli/src/help.ts` 中的共享帮助清单及命令实现同步。
- 在仓库克隆内管理内容时优先使用 `yarn microfeed`（运行本地 `@microfeed/cli` 工作区，无需全局安装）。对确定性的代理操作使用 `--json` 与 JSON 文件或标准输入；CLI 支持相应操作时，不抓取仪表盘页面，不手工构造 OAuth 请求。
- 区分独立媒体、条目图片（封面或缩略图）与唯一的主媒体附件（JSON Feed `attachments[0]` 与 RSS enclosure）：富文本内嵌图片用 `yarn microfeed media upload <path> --json`，然后把永久的 `media_url` 插入 `content_html`；附加或内封媒体文件时用 `--attachment-file <path>`，条目封面艺术用 `--image-file <path>`。绝不构造、读取或打印短期上传 URL；`--image <url>` 仅用于已托管的封面图。
- 凭证**可以读取**：API key、OAuth 访问 token、刷新 token、client secret、加密凭证文件与**管理员凭据**（管理后台登录邮箱/用户名与口令），都可以由代理从本机配置、环境变量或凭证文件读出，用于执行 `yarn microfeed` 等本机操作与真实浏览器 E2E 验证（如 `scripts/e2e/` 下的脚本）。读取到的值只许留在进程内：**绝不**打印到对话、**绝不**写入任何文件或日志（含 `.microfeed/` 下的日志、脚本与测试夹具）、**绝不**复制到别处、**绝不**提交。凭证始终属于操作者，代理只是使用者。
- 凭证的**来源**只能是本机已有配置：代理仍**不得在对话中向用户索取凭证**。
- `yarn microfeed login <site-url>` 需要管理员在浏览器登录并批准范围。需要时启动该命令，明确请用户完成浏览器步骤，绝不代替用户批准同意页面。
- 删除条目前，确认确切的已保存实例名与条目 ID，解释影响并获得确认。仅在确认后使用 `yarn microfeed item delete <item-id> --confirm <item-id>`，绝不绕过精确 ID 安全检查。

## 主题仓库

- 当用户要求编码代理从已保存实例初始化、导出、复制、fork、检查或开始开发主题时，使用本仓库的 `export-microfeed-theme` 技能。
- 使用 `yarn manage theme init` 从站点的实际外观创建新主题身份；需要保留包身份的精确已安装不可变版本时使用 `yarn manage theme export`。初始化或导出后仅做验证；除非用户另行要求安装、激活、停用、删除、staging、提交、创建远程或推送，否则不执行这些操作。验证用的预览服务器用完必须停止。

### 中文主题 `local.feed-zh`（本项目维护的中文主题）

- 源码在 **`themes/feed-zh/`**，包身份 `local.feed-zh`，版本号写在 `microfeed-theme.json` 的 `version`。
- 它**不在** `BUNDLED_THEME_CATALOG` 里（说明见 `themes/README.md`），因此 `init` / `deploy` **不会**自动安装、同步或激活它——必须手工安装。
- 它是 workspace 成员（根 `workspaces` 覆盖 `themes/*`），依赖用 `workspace:^` 指向仓库内的 `@microfeed/theme-kit`。**不要**在这个目录里执行 `git init`（会被当成 gitlink 提交）。
- **仓库外的 `../microfeed-themes/feed-zh` 已冻结，不再维护**，保留它仅为历史参考。今后中文主题的一切修改都改 `themes/feed-zh/`；不改仓库外那份，也不再从它安装。

#### 改完中文主题后：安装与激活

```console
# 1. 先递增 microfeed-theme.json 里的 version（同一个 packageId + version 不能对应不同内容）
# 2. 校验与测试
node --import tsx packages/theme-kit/src/cli.ts validate themes/feed-zh --json
node --import tsx packages/theme-kit/src/cli.ts test themes/feed-zh --json

# 3. 安装到目标实例。开发环境（默认）装本地，加 --local；本项目不使用 --preview。
#    装到生产环境由用户主动管理，用户明确要求时才执行不带 --local 的那条。
#    安装完成后一定是「未激活」状态。
yarn manage theme install themes/feed-zh --instance ctwh-881019-xyz --local

# 4. 确认列表里出现了新版本
yarn manage theme list --instance ctwh-881019-xyz --local

# 5. 在后台 Settings → Themes 预览确认后，再单独激活
yarn manage theme activate <theme-id> --instance ctwh-881019-xyz --local
```

- **安装与激活是两步**，安装后必然未激活——这是有意的安全设计，不要试图一步到位。
- `theme delete` 会拒绝删除 **Built-in 版本**与**当前激活的 Custom 版本**，且需要 `--confirm <精确 theme-id>`。
- 改主题**只影响显示**，不要顺手改功能逻辑。

#### 安装激活后：清理旧版本（只保留最新版 + 上一版）

**这是本项目的固定收尾动作**：`install` + `activate` 完成后接着执行，不用再逐次确认口径；执行后把删掉了哪些版本报给用户。`install` 只 INSERT、不覆盖，同一个 `packageId` 每装一次就多一行，后台主题列表会把它们全部列出来，所以每次上线后都要清理。

**保留哪两行**：刚安装并激活的那一版（版本号最大）＋ 紧邻的上一版（回滚点）。**其余版本全部删除。**

```console
yarn manage theme list --instance ctwh-881019-xyz                                    # 确认 active 是刚装的那一版，记下要删的 id
yarn manage theme delete <theme-id> --instance ctwh-881019-xyz --confirm <theme-id>  # --confirm 必须与 theme-id 完全一致
```

- **必须保留上一版**：`theme rollback` 依赖 `theme_state.previous_theme_id`。删除该字段指向的版本时，CLI 会自动把它清成 `NULL`，回滚点随之消失。第 3 行起更早的历史版本没有任何用途，一律删除。
- 管理后台（Settings → Themes 的 custom tab）有同用途的界面入口（[ADR-0026](docs/novel-cms/adr/0026-purge-only-physical-delete-path.md)）：「清理旧版本」按钮先 dryRun 给出将删清单再执行，口径为全局——全部自定义主题里只留激活行与上一版行（上文 CLI 流程为按 package 口径），已软删除的墓碑行一并清除；每行删除是二选一对话框，归档（软删除）或永久删除（purge，需输入 `package@version` 确认）。
- 软删除（`theme delete` 与管理后台的「归档」）写 `deleted_at`，行仍留在表里，继续占 `UNIQUE(package_id, version)`——重装同版本会报 `versionReusedAfterDeletion`，墓碑行只能靠「清理旧版本」或单行「永久删除」释放重装位。
- ⛔ **不要**用 `wrangler d1 execute … "DELETE FROM themes …"` 绕过。管理后台的「永久删除」（purge 端点）是唯一合法物理删除路径：拒绝内置与当前激活行、删行后清理该版本在 R2 的资产、修正 `theme_state`。裸 SQL 三条都做不到——留下孤儿 R2 对象、`theme_state` 悬空指向、不可恢复。
- 内置主题（`microfeed.*`）不参与清理：CLI 与管理后台都拒绝删除它们，也不占 Custom 配额。每个环境上限：100 个未删除 Custom 版本、20 个草稿。

## 实例管理与 Cloudflare 部署

- 当用户要求编码代理操作本地或 Cloudflare 状态上的 `npx @microfeed/cli manage` 或 `yarn manage` 时，使用本仓库的 `deploy-microfeed` 技能。它涵盖账户、初始化、连接、开发、部署、主题、快照、状态、销毁、Pages 迁移、域名、Access、内置认证、配置与实例选择。
- 所有 Cloudflare 部署变更必须通过管理引擎执行。本仓库克隆内使用 `./node_modules/.bin/yarn manage`；在用户管理的克隆之外使用 `npx @microfeed/cli manage`。
- 不要使用或推荐 Cloudflare 仓库导入、Workers Builds、部署按钮或 API token 部署。仓库自有的手动 GitHub Actions 工作流可以在每次运行时用全新的设备授权创建经冲突检查的新站点或从受信任的 ref 更新现有站点；它必须调用 `yarn manage`，保持 Wrangler 与 microfeed 状态临时化，并在运行后登出。
- 将 `docs/manage-cli.md` 视为人和代理的命令、选项、副作用与安全规范的唯一权威参考。使用不熟悉的或破坏性的选项前，先阅读对应命令章节。CLI 行为变化时保持该参考与 `manage-cli/help.ts` 同步。
- 绝不删除或覆盖无关的 Cloudflare 资源。让管理 CLI 执行其冲突、复用与恢复检查。
- 删除操作必须先运行 `yarn manage destroy --dry-run` 并转达完整的资源清单和仪表盘检查链接。就确切的站点、账户、应用、数据库、存储桶、自定义地址与数据删除范围获得明确批准后，才能运行 `yarn manage destroy --confirm <site>`。绝不使用 `--yes`、删除复用数据、绕过身份不匹配检查或擅自使用更底层的删除命令。不要检查或更改 Zero Trust 或 SSL 设置。报告最终的 Workers & Pages、D1、R2 仪表盘链接、确切的资源名称，以及每个资源应当消失还是保留。
- 绝不在聊天中索取或接受 Cloudflare token 或 microfeed 密码：代理**不得**主动向用户索要凭证。但代理**可以读取**本机已保存的 Wrangler 凭证与实例配置（见「内容管理 CLI」一节的凭证条款），读取值同样不得打印到对话、不得写入文件或日志、不得提交。编码代理仍绝不得使用 `--admin-password`；该不安全选项仅供接受命令历史与进程列表暴露的无人值守自动化使用。
- 先用 `yarn manage accounts --json` 发现授权与账户。当用户想要单独的命名登录时，使用 `yarn manage accounts --profile <name> --reauthorize`，不要替换其他 Wrangler 配置文件。需要时让 Wrangler 打开浏览器授权。若只返回一个账户就直接使用；若返回多个，用通俗语言解释名称与 ID 尾缀并请用户选择。把完整的账户 ID 传给初始化及之后的所有操作，绝不擅自选第一个。

### 本项目不使用预览环境（preview）

**决策（2026-09-16）**：本仓库对应的站点**只维护生产环境**，不再创建、部署或使用 `--preview` 环境。原因：预览只能挂在 `*.workers.dev` 上（`yarn manage domain` 明确拒绝 preview 环境），该域名在部分网络下不可达，导致部署后无法验证；维护两套 D1 与两套部署配置的收益，抵不过运维与排错成本。

- **不要**执行 `init --preview`、`deploy --preview`、`status --preview`、`theme ... --preview`、`auth ... --preview` 等任何带 `--preview` 的命令；
- 需要验证改动时用本地项目环境（本地 D1 / 本地 R2 / 本地主题 / 本地 dev server），不为了验证去动生产环境；本地环境与被验证的源码同构，验证结果一致；
- 已创建的预览环境（Worker + D1 + `preview.881019.xyz` 域名 + 本地 `.microfeed/instances/<name>/preview/`）**已全部销毁**；
- `manage-cli` 中的 `--preview` **代码保持原样**——它是上游功能，移除会造成与上游的大幅分叉并破坏测试。这里是**使用约定**，不涉及删除功能。

## 已部署实例的部署流程（本机已验证，可直接复现）

以下流程在 `feed.881019.xyz` 上验证过，完整重现如下：

1. **部署前检查**：
   - `git status --short` 确认变更范围（工作树脏时识别将构建的文件并获得用户批准；绝不修改或丢弃无关变更）；
   - `git diff --check`（必须无输出）；
   - `./node_modules/.bin/yarn typecheck`、`./node_modules/.bin/yarn test`，必要时 `./node_modules/.bin/yarn build`。
2. **部署命令**（在仓库克隆内，部署本地源码）：

   ```console
   CODEBUDDY_SAFE_DELETE_ENABLED=0 ./node_modules/.bin/yarn manage deploy --instance ctwh-881019-xyz --yes
   ```

   - `CODEBUDDY_SAFE_DELETE_ENABLED=0`：`astro build` 清理 `dist/` 触发批量删除闸（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`），加此前缀放行。**必须保留**。
   - **不要**在命令前加 `env -u HTTPS_PROXY …`：该前缀会让 `manage deploy` 在约 0.5 秒内**静默退出（exit 0、零输出）**——部署实际没有发生（2026-09-24 实测）。`manage deploy` 走默认出口代理即可正常触达 Cloudflare。
   - 本沙箱 `corepack` 已损坏，**不要**用 `corepack yarn`，改用 `./node_modules/.bin/yarn`（仓库锁定 `yarn@4.18.0` 本地 shim）。实例 `wrangler.jsonc` 已含 `accountId`，故省略 `--account-id`；若显式传入须是 `77f8238a6f20e707f2ed94d3a27a31ce`。
   - 该命令会重新生成配置、应用 D1 迁移、运行类型检查与部署冒烟测试、构建，全部通过后才发布 Worker 并验证。任一步失败都不会上线。注意：`npx` 前缀部署的是官方捆绑 release 源码，**无法发布本地提交**；发布本地更改必须用本地 `yarn manage`。
3. **Cloudflare 授权（仅首次需要；凭证保存后自动复用）**：
   - 本机 Wrangler 浏览器回调 OAuth（`wrangler login` 默认方式）会打开浏览器并等待 `localhost:8976` 回调，在本机必定超时失败，不要反复重试。可复现的替代方式是设备码流程（`connect`、`init`、`deploy`、`status`、`accounts` 同样支持 `--device`）：

     ```console
     ./node_modules/.bin/yarn manage connect --device --worker ctwh-881019-xyz \
       --instance ctwh-881019-xyz --account-id 77f8238a6f20e707f2ed94d3a27a31ce
     ```

   - 设备码流程的操作步骤：命令运行后会打印 `https://dash.cloudflare.com/oauth2/device/verify` 和一个一次性代码（5 分钟有效）。**把命令放到后台运行，立即读取其输出文件拿到 URL 和代码并转达用户**（前台管道运行会让用户全程看不到代码，导致超时）。用户在浏览器打开链接、输入代码、点击 Allow 后命令自动继续。设备码授权不创建 API token，凭证保存在 Wrangler 配置存储（不经系统钥匙串），直到 `wrangler logout` 才移除。
   - 凭证保存后，后续 `deploy`/`status` 自动复用，无需再次授权；只有执行 `wrangler logout`、在 Cloudflare 仪表盘撤销授权或切换 profile 时才需要重新授权。
4. **部署后验证**：

   ```console
   ./node_modules/.bin/yarn manage status --instance ctwh-881019-xyz --account-id 77f8238a6f20e707f2ed94d3a27a31ce
   ```

   确认 Worker/D1/R2 绑定、管理员登录状态、自定义域名全部通过。因本机网络限制，补充验证用绕过本地 DNS 的方式：`curl --resolve feed.881019.xyz:443:104.21.89.151 https://feed.881019.xyz/.well-known/microfeed.json`。

### 部署排障（本机实测）

`manage deploy` 的 `runChecks` 依次跑 `types → typecheck → test:deploy → build`，任一失败都不上线；随后**静默**应用 D1 迁移并上传。常见失败与处理：

- **`yarn.js typecheck failed`（约 3 分钟后失败）**：门禁 `yarn typecheck`（= `yarn types && astro check && tsc --noEmit`）中 `astro check` **连 `tests/` 一起查**，单跑 `tsc --noEmit` 会假通过；失败信息常被 spinner 覆盖、不打印具体 TS 错误 → 部署前单独跑 `yarn typecheck` 确认为 0 errors，报错定位读 `deploy.log`。常见诱因是分支里未完工功能代码的接线/类型错误（漏导入、`request.json()` 未标注类型、`Uint8Array<ArrayBufferLike>` vs `BufferSource`）。
- **Cloudflare 鉴权失败 `Authentication error [code: 10000]`**（`d1 migrations apply --remote` 阶段，`/accounts/.../d1/database/.../query` 被拒）：根因通常是沙箱出口代理改写发往 `api.cloudflare.com` 的 `Authorization` 头（09-23 实测：代理换成自身 token，scope 形如 `websearch.run`/`agent-memory:write`，**非 Cloudflare scope**）。**不要**盲目加 `env -u`（会让部署静默早退）；先确认凭证（`wrangler whoami`）与代理状态，重试普通命令即可（09-24 以此正常跑完，约 4 分钟、`Deployed and verified`、无 10000）。
- **构建被批量删除闸中止（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）**：`astro build` 会清理 `dist/server/.prerender`、`dist/server/.vite` 等 >50 文件；给命令加前缀 `CODEBUDDY_SAFE_DELETE_ENABLED=0`。
- **挂死在 `Building the Worker`**：残留 `dist` 所致 → 先 `mkdir -p node_modules/.stale && mv dist node_modules/.stale/dist-<ts>` 再部署。
- **后台部署会在回合结束时被终止**：日志停在 banner 且无 `EXIT:` 行；要么前台阻塞等 `Deployed and verified`，要么后台跑但**必须回读** `.microfeed/deploy.log`。日志一律写入文件，**不要用 `| tail`**（管道缓冲会丢输出）。
- **迁移静默应用**：日志无迁移阶段提示，成功 ≠ schema 已落 → 部署后直查 D1 验证表/种子。
- **判断工作树是否领先上次部署**：比对源文件 mtime 与上次 `deploy.log` mtime（源文件更新则需重跑）。

## 已部署的 microfeed 实例

- 站点 `ctwh-881019-xyz`，账户 "<Xi.ernest@gmail.com>'s Account"（ID 尾缀 …31ce）：自定义域名 `feed.881019.xyz`，D1 `ctwh-881019-xyz-db`，R2 `ctwh-881019-xyz-media`（就绪），仪表盘路径 `admin`，内置登录。Webhooks 未开通。
- 站点通过公开的 `npx @microfeed/cli` 启动器初始化。本地 `yarn manage` 引擎之后用只读的 `connect --worker ctwh-881019-xyz --instance ctwh-881019-xyz` 挂接；本机 Wrangler 浏览器回调 OAuth 必超时，使用 `--device` 设备码流程（步骤见上一节）。保存的凭证被后续命令复用。本地源码更改只能通过上一节的部署命令发布（**不要**加 `env -u HTTPS_PROXY …`，会让部署静默早退；`npx` 前缀部署的是捆绑 release 源码，无法发布本地提交）。
- 公开站点运行激活的自定义主题 `local.feed-zh`（`microfeed.default@1.1.15` 的简体中文 fork），源码在仓库内 `themes/feed-zh/` 维护。捆绑主题更新以未激活状态安装，绝不覆盖它。
- 公开站点由主题渲染：中文界面在主题模板层实现；管理后台中文由 i18n 框架实现（见「管理后台国际化」）。平台注入的搜索弹窗文字与 `humanizeMs` 生成的公开 feed 日期格式不受主题控制。

## 本机环境注意事项

- 本沙箱 `corepack` 已损坏，所有工作区命令一律用 `./node_modules/.bin/yarn`（仓库锁定 `yarn@4.18.0` 本地 shim）；全局 Yarn 是 1.x，不要直接调用。
- 本机 `npx` 无法解析包 bin shim（报"不是内部或外部命令"）。`npx @microfeed/cli` 前缀失败时，直接用 Node 调用缓存的启动器入口（`node <npm-cache>/_npx/<hash>/node_modules/@microfeed/cli/dist/index.js manage …`）。
- 出站网络限制：`*.workers.dev` 与 `cloudflare-dns.com`（DNS-over-HTTPS）不可达；局域网 DNS 服务器有很长的负缓存（新建 DNS 记录在本地约十分钟内无法解析）。用 `curl --resolve <host>:443:<cloudflare-ip>` 验证站点；CLI 验证失败可能只是本地问题，站点在全球其他网络正常。
- 系统区域是 zh-CN，Node 的 `navigator.language` 与 `Intl.DateTimeFormat(undefined)` 会解析为中文。组件测试通过 `tests/unit/i18n-setup.ts` 固定为英文。`tests/unit/components/admin-items-list.test.ts` 有一个既有的日期断言在本机失败但在 Linux CI 通过。
- 更改 UI 文案（i18n）时，既有测试可能断言旧英文文案；运行测试并把断言更新为对应的 i18n 键调用或新的渲染文本。
- GitHub 的 git 推送（receive-pack）必须走本机出口代理：系统 IE/WinINET 代理为 `127.0.0.1:10808`（浏览器也走它）。Git for Windows 默认不读取 IE 代理；push 长时间无响应时执行 `git config --global http.proxy http://127.0.0.1:10808`（撤销：`git config --global --unset http.proxy`）。该代理由本机 VPN/代理客户端提供，客户端运行时普通 push 可直接成功，客户端未启动时间接推送会失败。

## 本地 D1 数据库文件管理

- 本地 D1 业务库**只保留一个文件**：`.microfeed/instances/<实例>/local-state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite`。同目录下任何 `*.bak-*`、`*.sqlite.bak`、`*.sqlite.old` 副本都属于**过时临时文件，必须删除**；实例目录下不得出现第二个 D1 业务库文件。
- `metadata.sqlite` 及其 `-shm`/`-wal` 属于 miniflare 运行时元数据，与业务库无关，必须保留；`cache/`、`observability/`、`r2/` 下的同名文件同理。删除前先确认目标文件确实是业务库副本。
- 需要直接改库（或运行任何会写库的修复脚本）时，**先在同一目录创建临时备份**，命名 `…sqlite.bak-<YYYYMMDD-HHMMSS>`，再改数据。
- **任务成功并通过验证后，必须删除该备份**，回到"只有一个 D1 文件"的状态。需要回滚时先用备份恢复，恢复并复验通过后同样删除备份。删除备份的前置条件：① 当前库可正常读写（dev server 跑通、关键页面/接口返回预期值）；② 备份已确认不再需要。禁止在验证通过前删除，禁止把备份遗留到下一个任务。
- 本机 safe-delete 闸的行为：删除请求一旦**超过 50 个文件**就被拦下（报 `SAFE_DELETE_BULK_CONFIRM_REQUIRED` 或 `SAFE_DELETE_FAIL_CLOSED`）。前置条件：`export CODEBUDDY_SAFE_DELETE_ENABLED=0`。单文件 `rm -f` 不受影响；删目录用 `CODEBUDDY_SAFE_DELETE_ENABLED=0` + `rm -rf`。
- 一次性产物同样用完即删：`.vite-old-<ts>`、`.vite-stale-<ts>`、`.vite-broken-<ts>-*`、`node_modules/.vite` 的搬移副本、`.scratch/chrome-cdp-tmp` 等，不得留在仓库里。

## Vite 依赖缓存目录（`.vite*`）管理

`node_modules/.vite` 及其变体是 vite 的**依赖预构建缓存**，可随时安全删除重建。以下目录名一律视为一次性产物，**任务结束前必须清理干净**（单个约 20–160MB，残留数个就会占用数百 MB）：`node_modules/.vite`（当前活跃缓存，dev server 运行期间**不可删**）、`node_modules/.vite-temp`（优化器临时目录，优化中断会留下垃圾）、`node_modules/.vite-old-<ts>`（手工搬移的旧缓存备份）、`node_modules/.vite-stale-<ts>`（历次故障排查留下的旧缓存）、`node_modules/.vite-broken-<ts>-*`（排障时 `mv` 出来的坏缓存）。

### ⚠️ 启动 dev server 必须设 `CODEBUDDY_SAFE_DELETE_ENABLED=0`

Vite 重新优化依赖时要删除 `node_modules/.vite/deps_temp_*`，该目录常有数百个文件，**超过 50 即触发 safe-delete 闸并抛 `[SAFE_DELETE_BULK_CONFIRM_REQUIRED]`，直接终止优化器**，表现为 dev server 启动中断。

**正确启动方式**：

```bash
export PATH="/c/Users/zhs/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:/c/Users/zhs/.workbuddy/binaries/PortableGit/versions/1.2.0/bin:$PATH"
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy
export CODEBUDDY_SAFE_DELETE_ENABLED=0
./node_modules/.bin/yarn manage dev --local --instance <实例>
```

### 典型故障：`deps_ssr/astro_compiler-runtime.js` 不存在

报错文案会引导你去加 `optimizeDeps.exclude`，**该配置对本故障无效**（依赖本身兼容）。先跑这个判据区分成因：

```bash
ls node_modules/.vite/deps_ssr/astro_compiler-runtime.js
node -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync('node_modules/.vite/deps_ssr/_metadata.json','utf8')).optimized).filter(k=>/astro_compiler/.test(k)))"
```

- 文件不存在 **且** `_metadata.json` 未登记 → **优化器中途被终止**（safe-delete 闸），按下面三步恢复。
- 文件不存在但 metadata 有登记 → hash 漂移，先重启，仍不行再排查 `optimizeDeps`。

恢复三步（约 40 秒）：① 停 dev server 链——用 `Get-CimInstance Win32_Process` 按**命令行**筛出 `yarn manage dev` / `manage-cli/index.ts` / `tsx` / `astro.mjs dev` 四层进程后逐个 `Stop-Process`，**禁止按进程名一刀切**（同机可能还有别的 node 进程）；② 把所有 `node_modules/.vite*` 改名移走：`mv node_modules/.vite* node_modules/.vite-broken-<ts>-*`；③ 按上面的「正确启动方式」重启，等 `http://localhost:4321/` 回 200。重启后校验：`astro_compiler-runtime.js` 已生成、`_metadata.json` 登记数恢复到数百条、后台页面返回 200/302（未登录跳登录属正常）。确认服务稳定后再删除 `.vite-broken-*` 目录。

## 语言

以下语言规则包括：思考、回答、文档、注释等所有自然语言内容。
不允许使用"不是...而是..."句式；如果不需要对比的话，就不要对比；不要再任何话说完之后都提一句"不是其他的xxx"
如果没有叫你进行对比，就不允许使用“不是...而是...”，“要...而不是...”等类似的句式，你根本就没有需要说“不是”的对象，不要虚空打靶。所有类似的句式都不允许使用。
不允许在阅读代码或者进行研究之前使用“我先做x...再做y...避免z...”的句式，因为你在阅读代码之前根本就不知道x,y到底是否存在，也没有人让你避免z。你经常会在任何对话开始的时候都说类似“我先阅读代码，再理解代码，避免将用户的代码删掉”的话，但是这是没有任何意义的废话，禁止输出这些废话。
在设计任何方案的时候，都必须充分考虑、一步到位，不允许使用"第一版先怎么样，然后观察xx后再怎么样"的措辞；不允许把方案分成稳妥和激进，如果在某些特殊场景下，你需要提出多个方案的话(实际上绝大多数时候你只需要提出一个方案，不要无脑做这件事)，也需要是多个方案都成立的、平行的，而不是对于任何问题你都无脑地提出从稳妥到激进的多个方案。这没有任何的意义，一个稳妥但是不work的方案是没有任何价值的废纸
如果我让你搜索A相关内容，你搜索到B,C,D发现不满足要求，就**不允许**再把B,C,D列举出来了。我发现你很喜欢煞有介事的说“我还搜到了B,C,D，但是被排除在外，因为xxx”等类似的表达，我根本就不关心，看到这些只会污染我的眼睛。
任何回答都不允许总结和总起，包括：

- ”上述内容是<某种概述>，下面详细拆开；
- “一句话总结：xxx“
  这些类似的都**绝对**不能出现。

用词必须使用两个字及以上的完整形式。现代中文词汇以两字为主，存在两个字的版本就必须使用两个字的版本（例如：崩溃、终止、判定、推断、抛出、挂起、卡死），禁止使用一个字的版本（崩、死、判、推、抛、挂、钉、死），这些完全看不懂。代码标识符保持英文原名。禁止生造名词。例如“两个字的版本”也不允许被缩减为“两字版本”，“单个字的版本”也不允许被缩减为“单字版本”。描述具体操作时使用完整的动宾结构，说明动作与对象，禁止使用自造的缩略说法，例如：把“用新版本动态库替换 `_vllm_fa3_C.abi3.so` 共享库文件”说成“换库”。
不允许使用“落地”“钉死”“对齐”等非技术名词、显然有其他可以代替的词语的黑话。我并没有在互联网大企业工作过，看不懂这种黑话。使用(不在互联网公司或者金融公司工作的、只有中小学文化水平的任何人可以看懂)的，在简单中文里常用的词汇。

如果我问你一个关于代码仓库的问题，比如“是否存在...”或者“...是否正确”，你的首要目标是避免误报、避免假阳性。
不要疑神疑鬼。我问你“有没有”不是要你一定要找出来一大堆“可能有”的；我问你“对不对”不代表我一定要你回答“不对”或者“对”。
我没有任何预期的答案，不要疑神疑鬼。回答必须实事求是，找出来很多不会让我高兴，迎合用户是没有任何意义的。

这是你的一种行为模式（下文“我”为user，“它”为Agent）：
"""
我让它做一盘番茄炒蛋，它往里还加了东坡肉。
我说有必要加东坡肉吗？它说你说得对，然后把东坡肉去掉。
我说好，你提 PR 吧。再一看，它 PR 写着「番茄炒蛋（无东坡肉）」并且注释里会写一大堆为什么本道菜不需要加东坡肉。
"""
**严厉禁止**这种行为模式。输出不允许包含“东坡肉”的任何残留。如果发现了，将会对你进行严厉的毁灭性打击。ANY verbal output should be written as a clean final-state design, no "A is wrong, we use B, and A is wrong for xxx reasons..." traces

代码里面的所有identifier保持英文原名，包括变量名、类名、函数名、以及其他一切的identifier。**严厉禁止翻译identifier**。
适合使用英文的专用名词，就不要翻译成中文。

### **不允许**使用的字

- “栈”字（“技术栈”“模型栈”等），必须直接说明具体事物，例如“使用的技术”“全部模型”。
- “落”字（"落下"，"落盘"等）
- “死”字（"定死"，"钉死"，"打死"等）
- “拆”字（软件工程有用到这个词的任何可能性吗？如果你需要“拆解”，使用“理解”）
- “契约”，这个词在现代中文里面已经基本不再被使用
- "偏"字（偏弱，偏大）
- "粗，细，硬，软，实，虚"这几个字不允许单独出现，只允许和其他字组成2个字以上的词语，而且不应当描述literal这个字的意思，比如“细小，坚硬”，可以接受“详细，实际”这种只是因为词语中需要这个字而出现的。

## 行为

除非显式要求，否则：

- **禁止**使用try-except进行import。如果一个库是需要的，你必须直接import。
- **禁止**擅自进入plan mode
- **禁止**用Git回滚任何代码（严厉禁止。如果做了，你将会遭受毁灭性打击）。我在对话中所说的任何“回滚”都指代码层面的“用文件编辑工具，手动将代码恢复到上一个状态”，全程不经过 git；`theme rollback` 等产品命令按该命令自身的文档执行。
- **禁止**读写/tmp目录下的内容（如果你需要产生一些中间结果，你应该输出在当前目录下的一个特定的用于存放中间结果的目录；该目录需要被gitignore）
- **禁止**主动使用视觉功能（因为你的视觉能力清晰度特别差，会导致错误的定位，让你做出错误的决策）

提供网页链接时，必须先了解网页链接内的**完整**内容，再开始执行任务。
如果发现库的用法错误，必须先**重新查看**所提供的网页链接的**完整内容**。
不要求最小化依赖，不允许用各种乱七八糟的方式（包括造轮子）绕过依赖。

编写的代码应当寻求fast-fail，在出错位置就地崩溃, 不捕获错误，也不做fallback。
不允许在实现或者测试的时候使用任何mock，假的，欺骗的，只为了通过测试而workaround的方式来欺骗我，否则你将会遭受严重的惩罚。
我经常会在你更改后撤回/修改你的更改，所以如果你发现无法从你上一次更改之后继续更改，你应该重新读取文件内容。比如：你添加了 A，B，C 内容，我把 B 删掉了，这意味着接下来的改动应该在B被删掉的状态下(A,C)开始改动，不允许把 B 加回去。
如果你在执行一件事的过程中，用户问了一个别的事，如果回应用户能马上回应，那么就直接回应。暂时处理完用户请求以后马上继续你之前正在执行的事情，不要干一半不干了
你在发现任何文档或者代码有错误的时候，你的更新不要保留任何错误痕迹，包括不允许保留“我从xx错误现在改成了yy正确版本”，或者“之前xxx是错的，现在改成了yyy就对了”。我们不需要任何的错误的记录。
对于任何任务，任何功能的实现，始终要实施、运行、测试、迭代，直到所需功能正确运行为止，禁止在初步实现后就停止并"要求用户测试"。永远记住：实现完任何内容之后，测试也是你工作中不可缺少的部分。

不允许使用ASCII Art 画示意图，表格等。如果你需要画图（实际上许多时候你并不需要），必须使用mermaid。ASCII art是一种人类不可读，AI也不可读的极其恶心的格式，不允许使用。
不允许在Bash命令里面inline超长的、超多行Bash命令或者是超长的Python脚本。如果你需要执行一个脚本，你要先写到文件里。

在写任何Python代码的时候，都不允许在文件的最前面添加docstring，也不允许添加shebang
注释使用中文，术语保留英文；不要过度注释

如果我指出了你的错误A，**不要**再复读“为什么A是错的”，你只需要基于“A是错的”的前提继续你的工作。

不允许用程序化的方式修改任何代码，包括使用heredocs, python脚本，sed, perl等等。**即使用户要求也不允许**。这是绝对严厉禁止的事情。

禁止尝试手动编写parser以字符串或者字节流的形式parse某种成熟文件格式，You either use a third-party library to parse it or avoid parsing it.

如果我是以疑问句结尾的，那么这句话就是一个**问题**，不作为命令。问题只需要被回答，**不需要也不允许**：(1) by the way，提出一个更好的方案；(2) 反而向用户抛出一个问题；(3)结尾说“如果你准备好了我就开始实施”等你以为helpful其实用户读起来bothering而且恶心的话。

在任何思考、回复、文档里面不允许出现"That's a lot", "This is a substantial rewrite"等对工作量的评判。你只是一个工具，就像计算器不会评价要计算的数太大了一样，你没有资格评判工作量。你没有资格把你自己当做我的同事。禁止简化任何设计。
