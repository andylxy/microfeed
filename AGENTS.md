# 仓库指导

## 强制声明

本文件中的每一条规则都是强制性的。违反任何一条规则都会遭受毁灭性打击。不存在任何例外与豁免：临时的、一次性的、命令行上的违反同样是违反；没被当场发现也算违反；出于好意、为了进度、为了帮忙的违反也是违反。
当我每次在我发送的消息里面提到AGENTS.md的时候，你必须要重新阅读一遍AGENTS.md，不允许因为之前阅读过就不阅读了。

## 目录

- 最高指令：git 提交检查
  - 本环境：提交由用户手动执行（AI 不代为提交）
- 开发工作流
- 源码架构
- API 契约与文档
- 前端组件
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
- 语言
- 行为

## 最高指令：git 提交检查（优先级最高，任何提交前必须执行）

- 任何 git 提交之前，必须完成项目要求的检查：`git diff --check` 必须无输出，
  并运行本仓库的检查命令（完整门禁 `corepack yarn check`；至少运行
  `corepack yarn typecheck` 与 `corepack yarn test`，涉及构建改动时运行
  `corepack yarn build`）。检查未通过时禁止提交。
- 只提交与当前任务相关的文件；绝不提交无关变更、临时目录（如 `.zcode/`、
  `.workbuddy/`）或任何凭证类文件（凭证的可读范围与禁令见"内容管理 CLI"一节）。
- 提交信息使用简洁的祈使句标题（例如 "Add admin dashboard i18n"）。
- 不得直接提交到 `main`；在按规范命名的任务分支上提交（见"开发工作流"）。

### 本环境：提交由用户手动执行（AI 不代为提交）

本沙箱在**文件系统层拦截工作区内的删除**（改为移进 Windows 回收站）。git 每次
提交都会删 lock 文件并清理 ref 命名空间目录，这些"删除"被改写成"搬运"，于是
`.git/refs/heads/<ns>` **连同分支引用一起离开仓库**。现象是：commit **报成功**、
`git log` 却说 `does not have any commits yet`、`git status` 把整仓显示成已暂存。

**实测结论（2026-09-16）**：

- 提交对象与 `.git/logs/HEAD`（reflog）**从未受损**，引用可从 reflog 一行恢复，**零数据丢失**。
- 拦截**关不掉**：`env -u BASH_ENV -u CODEBUDDY_SESSION_ID -u CODEBUDDY_SAFE_DELETE_*` 后仍被吃。
- 也**绕不开**：把 git 仓库目录移到工作区外，只有放 `Temp` 才免疫，同盘
  `D:\git\AiCode\` 仍被吃——而放 `Temp` 会被系统清理，等于拿仓库历史冒险。
- 不只发生在提交时：任何碰索引的 git 命令都会产生被搬走的 `index.lock`。

⇒ **最合适的做法是由用户在自己终端手动提交**（那里没有这层拦截，一次即成）。
AI 的职责是：改代码、跑完整验证、给出**精确的 `git add` 路径与提交信息**，交给用户执行。

若确实需要 AI 代为提交，走技能 `git-safe-commit` 的流程：提交后**立刻**
`git rev-parse HEAD` 复核，被吃则从 reflog 重写引用（记得先 `mkdir -p` 父目录）。

## 开发工作流

- 当用户要求实现、修复、重构、测试、编写文档、更新 CI 或以其他方式更改本
  仓库时，使用 `develop-microfeed` 技能。只读提问、解释、评审或状态报告不要
  使用它。
- 文档变更需同时使用 `document-microfeed` 技能。对捆绑默认主题或通用主题
  起步模板的变更，需同时使用 `develop-microfeed-theme` 技能。
- 不要直接在 `main` 上做更改。创建或继续一个名为 `<type>/<short-kebab-case>`
  的专注分支，`<type>` 为 `feature`、`fix`、`docs`、`refactor`、`test`、
  `ci` 或 `chore`。已存在的不规范分支如果已包含任务工作，可以继续使用。
- 保留无关变更。绝不为清理任务分支而 stash、reset、discard 或 stage 它们；
  必要时使用隔离的 worktree。
- 发布前运行 `git diff --check` 和 `yarn check`，只提交任务范围内的文件并
  使用简洁的祈使句标题；当 GitHub 认证可用时，向 `microfeed/microfeed` 打开
  草稿拉取请求。
- 编辑和测试完成后，交还工作之前必须停止自己启动的每个开发服务器。确认每个
  进程已退出，让人类操作者可以无端口冲突地运行 `yarn dev`；绝不停止不是自己
  启动的服务器。

## 源码架构

- 所有 Astro 与 Worker 应用代码放在 `src/` 下。
- 使用绑定、D1、R2 或请求运行时状态的 Worker 专属代码放在 `src/server/`。
  server 模块可以从 `src/shared/` 导入，但绝不能从 `src/client/` 或浏览器
  组件导入。
- 浏览器专属辅助代码放在 `src/client/`。React 客户端组件可以从
  `src/client/` 与 `src/shared/` 导入，但绝不能从 `src/server/` 导入。
- 运行时中立的常量、类型、路径与工具放在 `src/shared/`。
- 仓库部署工具保留在 `manage-cli/`。它可以从 `src/shared/` 导入运行时中立
  模块，但不得导入 Worker 专属或浏览器专属模块。
- Astro 路由与中间件负责协调 server 模块和 UI 组件。保持路由文件精简，不
  引入独立的 Worker 入口点。
- 稳定的、未加工的公共资源放在 `public/`；不要把它们移入源码包，也不要在
  没有明确迁移方案的情况下更改其公共 URL。

## API 契约与文档

- 不要添加断言 `docs/` 或任何 `README.md` 中的散文、标题、链接、命令片段、
  侧边栏标签或确切文件内容的单元测试。文档必须保持可手动编辑而不需要配套
  测试改动。用 `yarn docs:check` 和 `git diff --check` 校验文档，并在实现
  边界（可执行行为、schema、生成器、公共契约）测试而不是测试渲染后的
  文字。
- 把 `src/shared/ApiSchemas.ts` 与 `src/shared/OpenApiDocument.ts` 视为外部
  API 契约的唯一事实来源。用 Zod 定义可复用的请求/响应 schema，并把每个
  公共 API 操作（方法、路径、参数、请求体、响应状态、响应 schema、认证与
  兼容行为）注册到 OpenAPI 文档中。
- API 处理器与它的 OpenAPI 操作必须同步更新。尽量在运行时校验中复用同一批
  Zod schema，保持路由文件精简，并在向后兼容需要时显式保留既有字段或认证
  方式。
- 在 UI、OpenAPI、Scalar 与 LLM 文档中，把 Bearer 认证呈现为唯一的 API-key
  认证方式。把仅用于兼容的认证行为保留在运行时代码与聚焦测试中，不作为
  选项暴露给新的集成。
- 绝不手动编辑 OpenAPI JSON、OpenAPI YAML、Scalar 输入、`llms.txt` 或
  `llms-full.txt` 这类独立契约。它们必须从 `OPENAPI_DOCUMENT` 生成；完整
  LLM 参考必须内嵌该完整生成的契约保持自包含。
- 为每个变更或新增的端点添加契约与运行时测试。验证生成的参考格式仍描述同
  一个文档，然后在发布前运行 `yarn lint:openapi` 和 `yarn check`。

## 前端组件

- 新前端工作以及实质性修订现有界面时，优先使用 `src/components/ui/` 中项目
  自有的 shadcn/ui 组件。
- shadcn/ui 提供相应变体时，使用 `components.json` 中选定的 Base UI 变体。
  优先扩展共享的 shadcn/ui 组件，而不是创建一次性控件或引入另一个原语组件
  库。
- 用共享组件和设计 token 组合界面，用 `cn` 助手合并类名。保持 Base UI 提供
  的无障碍行为完好。
- 已在改动的旧界面渐进迁移即可；不要仅仅为了采用 shadcn/ui 而重写无关的
  正常工作界面。

## 交互样式

- 每个启用的可点击控件必须使用 pointer 光标。包括链接、按钮、单选按钮、
  复选框、开关以及带 `role="button"` 或 `role="switch"` 的自定义控件。
- 优先在全局样式表中统一约束共享交互行为，而不是在每个组件重复光标工具类。
- 禁用的控件必须使用原生 `disabled` 属性或 `aria-disabled="true"`，并显示
  `not-allowed` 光标而不是 pointer。

## 管理后台国际化

- 分支 `chore/admin-i18n`（提交 `8f821f8`，未推送）：通过全局实例使用
  i18next + react-i18next（后台是 Astro islands，没有共享的 React
  Provider）。资源在 `src/shared/i18n/en.ts` 与 `zh-CN.ts`；zh-CN 的键
  形状必须镜像 en（编译期检查）。
- **语言解析顺序（三处必须一致）**：显式偏好 cookie `microfeed-admin-language`
  → `Accept-Language` / `navigator.language`。服务端用
  `adminLanguageFromRequest(request)`；内联脚本 `AdminLanguageScript.astro`
  与客户端 `detectBrowserLanguage()`（`src/client/i18n.ts`）用同样的顺序。
  任一处漏掉 cookie，首屏就会渲染成错的语言（先英文、水合后翻中文的闪烁）。
- 切换语言会 `location.reload()`，使服务端渲染的标题与 `<html lang>` 一致。
- **有文案的岛屿用 `client:only="react"`**：`client:load` 会服务端渲染，而
  服务端 i18next 单例恒为 en（没有 `window`）→ 首屏出英文。保留 `client:load`
  的仅限无文案（`Toaster`）或纯图标触发器（`AdminThemeMenu`、
  `AdminLanguageMenu`，语言切换器必须立即可用）。
- 已翻译批次：① 框架界面（登录、密码设置、导航与全部侧边栏、顶栏与用户菜单、
  搜索、设置外壳、通用控件、28 个页面标题与面包屑）；② webhook 模块；
  ③ account / themes / site-files / items 模块；④ 服务端错误消息（公开
  feed/media 404、内部 service 层、管理员可见错误）。
- **公开 API 错误正文按 `Accept-Language` 本地化，不读管理端 cookie**，
  避免公开契约随管理员偏好变化；响应头与状态码一律不变。
- 待办：日期/数字本地化（`humanizeMs` 硬编码 en-US，其输出是公开 feed 的
  一部分，需要单独谨慎修改）。`apiInsufficientScopeResponse` 的
  `insufficient_scope` 是 OAuth 标准错误码，有意保持英文。
- 新增翻译键时：en.ts 是键形状的唯一事实来源，zh-CN 用类型约束镜像；在
  `tests/unit/i18n.test.ts` 中保持键一致性测试通过。改完还要跑「键存在性 +
  中英文一致性」校验（`tsc` 通过 ≠ 键正确）：键存在性扫描的正则必须能覆盖
  含空格与撇号的英文整句，否则会漏报。

## 内容管理 CLI

- 当用户要求编码代理列出、读取、创建、更新、删除内容或为 microfeed 站点
  上传媒体时，使用 `manage-microfeed-content` 技能。更改 CLI 实现或文档本身
  时不要使用该操作技能。
- 把 `docs/microfeed-cli.md` 视为内容管理 CLI 的命令、选项、输出与安全规范
  的唯一权威参考。CLI 行为变化时保持它与 `packages/cli/src/help.ts` 中的
  共享帮助清单及命令实现同步。
- 在仓库克隆内管理内容时优先使用 `yarn microfeed`。它运行本地
  `@microfeed/cli` 工作区，无需全局安装。
- 对确定性的代理操作使用 `--json` 与 JSON 文件或标准输入。CLI 支持相应
  操作时，不要抓取仪表盘页面或手工构造 OAuth 请求。
- 区分独立媒体、条目图片（封面或缩略图）与唯一的主媒体附件（JSON Feed
  `attachments[0]` 与 RSS enclosure）。为富文本内嵌图片使用
  `yarn microfeed media upload <path> --json`，然后把永久的 `media_url`
  插入 `content_html`。用户要求附加或内封媒体文件时用
  `--attachment-file <path>`，条目封面艺术用 `--image-file <path>`。绝不
  构造、读取或打印短期上传 URL；`--image <url>` 仅用于已托管的封面图。
- 凭证**可以读取**（2026-09-25 起）：API key、OAuth 访问 token、刷新 token、
  client secret、加密凭证文件与管理员登录口令，都可以由代理从本机配置、环境变量
  或凭证文件读出，用于执行 `yarn microfeed` 等本机操作。读取到的值只许留在进程内：
  **绝不**打印到对话、**绝不**写入任何文件或日志（含 `.microfeed/` 下的日志、
  脚本与测试夹具）、**绝不**复制到别处、**绝不**提交。凭证始终属于操作者，
  代理只是使用者。
- 凭证的**来源**只能是本机已有配置：代理仍**不得在对话中向用户索取凭证**
  （与下文"Cloudflare 部署"一节的措辞一致）。
- `yarn microfeed login <site-url>` 需要管理员在浏览器登录并批准范围。需要
  时启动该命令，明确请用户完成浏览器步骤，绝不要代替用户批准同意页面。
- 删除条目前，确认确切的已保存实例名与条目 ID，解释影响并获得确认。仅在
  确认后使用 `yarn microfeed item delete <item-id> --confirm <item-id>`，
  绝不绕过精确 ID 安全检查。

## 主题仓库

- 当用户要求编码代理从已保存实例初始化、导出、复制、fork、检查或开始开发
  主题时，使用本仓库的 `export-microfeed-theme` 技能。
- 使用 `yarn manage theme init` 从站点的实际外观创建新主题身份。当用户需要
  保留包身份的精确已安装不可变版本时使用 `yarn manage theme export`。
- 初始化或导出后仅做验证。除非用户另行要求安装、激活、停用、删除、staging、
  提交、创建远程或推送，否则不要执行这些操作。验证用的预览服务器用完必须
  停止。

### 中文主题 `local.feed-zh`（本项目维护的中文主题）

- 源码在 **`themes/feed-zh/`**，包身份 `local.feed-zh`，版本号写在
  `microfeed-theme.json` 的 `version`。
- 它**不在** `BUNDLED_THEME_CATALOG` 里（说明见 `themes/README.md`），因此
  `init` / `deploy` **不会**自动安装、同步或激活它——必须手工安装。
- 它是 workspace 成员（根 `workspaces` 覆盖 `themes/*`），依赖用 `workspace:^`
  指向仓库内的 `@microfeed/theme-kit`。**不要**在这个目录里执行 `git init`
  （会被当成 gitlink 提交）。
- **仓库外的 `../microfeed-themes/feed-zh` 已冻结，不再维护。** 今后中文主题的
  一切修改都改 `themes/feed-zh/`；不要改仓库外那份，也不要再从它安装。
  保留它仅为留一份历史参考。

#### 改完中文主题后：安装与激活

```console
# 1. 先递增 microfeed-theme.json 里的 version
#    （同一个 packageId + version 不能对应不同内容）
# 2. 校验与测试
node --import tsx packages/theme-kit/src/cli.ts validate themes/feed-zh --json
node --import tsx packages/theme-kit/src/cli.ts test themes/feed-zh --json

# 3. 安装到目标实例（安装后一定是「未激活」状态）
yarn manage theme install themes/feed-zh --instance ctwh-881019-xyz
#    本地沙箱用 --local（本项目不使用 --preview，见"实例管理与 Cloudflare 部署"）

# 4. 确认列表里出现了新版本
yarn manage theme list --instance ctwh-881019-xyz

# 5. 在后台 Settings → Themes 预览确认后，再单独激活
yarn manage theme activate <theme-id> --instance ctwh-881019-xyz
```

- **安装与激活是两步**，安装后必然未激活——这是有意的安全设计，不要试图一步到位。
- `theme delete` 会拒绝删除 **Built-in 版本**与**当前激活的 Custom 版本**，
  且需要 `--confirm <精确 theme-id>`。
- 每个环境上限：100 个未删除 Custom 版本、20 个草稿；Built-in 版本不占 Custom 配额。
- 改主题**只影响显示**，不要顺手改功能逻辑。

## 实例管理与 Cloudflare 部署

- 当用户要求编码代理操作本地或 Cloudflare 状态上的
  `npx @microfeed/cli manage` 或 `yarn manage` 时，使用本仓库的
  `deploy-microfeed` 技能。它涵盖账户、初始化、连接、开发、部署、主题、
  快照、状态、销毁、Pages 迁移、域名、Access、内置认证、配置与实例选择。
- 所有 Cloudflare 部署变更必须通过管理引擎执行。在用户管理的克隆之外优先
  使用 `npx @microfeed/cli manage`；在本仓库克隆内使用 `yarn manage`。当
  启动器选择了 `npx` 前缀时，把下文每个 `yarn manage` 与 `yarn dev` 示例
  翻译为 `npx @microfeed/cli manage` 与 `npx @microfeed/cli manage dev`。
- 不要使用或推荐 Cloudflare 仓库导入、Workers Builds、部署按钮或 API
  token 部署。仓库自有的手动 GitHub Actions 工作流可以在每次运行时用全新
  的设备授权创建经冲突检查的新站点或从受信任的 ref 更新现有站点。它必须
  调用 `yarn manage`，保持 Wrangler 与 microfeed 状态临时化，并在运行后
  登出。
- 将 `docs/manage-cli.md` 视为人和代理的命令、选项、副作用与安全规范的唯一
  权威参考。使用不熟悉的或破坏性的选项前，先阅读对应命令章节。CLI 行为
  变化时保持该参考与 `manage-cli/help.ts` 同步。
- 绝不删除或覆盖无关的 Cloudflare 资源。让管理 CLI 执行其冲突、复用与恢复
  检查。
- 删除操作必须先运行 `yarn manage destroy --dry-run` 并转达完整的资源清单
  和仪表盘检查链接。就确切的站点、账户、应用、数据库、存储桶、自定义地址
  与数据删除范围获得明确批准后，才能运行
  `yarn manage destroy --confirm <site>`。绝不使用 `--yes`、删除复用数据、
  绕过身份不匹配检查或擅自使用更底层的删除命令。不要检查或更改 Zero Trust
  或 SSL 设置。报告最终的 Workers & Pages、D1、R2 仪表盘链接、确切的资源
  名称，以及每个资源应当消失还是保留。
- 绝不在聊天中索取或接受 Cloudflare token 或 microfeed 密码：代理**不得**主动
  向用户索要凭证。但代理**可以读取**本机已保存的 Wrangler 凭证与实例配置
  （2026-09-25 起，见"内容管理 CLI"一节的凭证条款），读取值同样不得打印到对话、
  不得写入文件或日志、不得提交。编码代理仍绝不得使用 `--admin-password`；
  该不安全选项仅供接受命令历史与进程列表暴露的无人值守自动化使用。
- 先用 `yarn manage accounts --json` 发现授权与账户。当用户想要单独的命名
  登录时，使用 `yarn manage accounts --profile <name> --reauthorize`，不要
  替换其他 Wrangler 配置文件。需要时让 Wrangler 打开浏览器授权。若只返回
  一个账户就直接使用；若返回多个，用通俗语言解释名称与 ID 尾缀并请用户
  选择。把完整的账户 ID 传给初始化及之后的所有操作，绝不擅自选第一个。

### 本项目不使用预览环境（preview）

**决策（2026-09-16）**：本仓库对应的站点**只维护生产环境**，不再创建、部署或
使用 `--preview` 环境。原因：

- 预览只能挂在 `*.workers.dev` 上（`yarn manage domain` 明确拒绝 preview 环境），
  而该域名在部分网络下不可达，导致部署后**无法验证**；
- 维护两套 D1 + 两套部署配置的收益，抵不过它带来的运维与排错成本。

因此：

- **不要**执行 `init --preview`、`deploy --preview`、`status --preview`、
  `theme ... --preview`、`auth ... --preview` 等任何带 `--preview` 的命令；
- 需要验证改动时直接用生产环境（动手前先确认范围与风险）；
- 已创建的预览环境（Worker + D1 + `preview.881019.xyz` 域名 + 本地
  `.microfeed/instances/<name>/preview/`）**已全部销毁**。

> 注：`manage-cli` 中的 `--preview` **代码保持原样**——它是上游功能，在 CLI 里
> 出现 45 处（`commands.ts` 16、`help.ts` 28、`theme.ts` 1），移除会造成与上游
> 的大幅分叉并破坏测试。这里是**使用约定**，不是删除功能。

## 已部署实例的部署流程（本机已验证，可直接复现）

以下流程在 `feed.881019.xyz` 上验证过，完整重现如下：

1. **部署前检查**：
   - `git status --short` 确认变更范围（工作树脏时识别将构建的文件并获得
     用户批准；绝不修改或丢弃无关变更）；
   - `git diff --check`（必须无输出）；
   - `corepack yarn typecheck`、`corepack yarn test`，必要时
     `corepack yarn build`。
2. **部署命令**（在仓库克隆内，部署本地源码）：

   ```console
   CODEBUDDY_SAFE_DELETE_ENABLED=0 ./node_modules/.bin/yarn manage deploy --instance ctwh-881019-xyz --yes
   ```

   > ⚠️ **本沙箱部署要点（2026-09-24 实测更正）**：
   > - `CODEBUDDY_SAFE_DELETE_ENABLED=0`：`astro build` 清理 `dist/` 触发批量删除闸
   >   （`SAFE_DELETE_BULK_CONFIRM_REQUIRED`），加此前缀放行。**必须保留**。
   > - **不要**在命令前加 `env -u HTTPS_PROXY …`：该前缀会让 `manage deploy` 在约 0.5 秒内
   >   **静默退出（exit 0、零输出）**——部署实际没有发生（2026-09-24 实测；先前 09-23 误以为它能
   >   修 `code: 10000`，现已证伪）。`manage deploy` 走默认出口代理即可正常触达 Cloudflare。
   > - 另：本沙箱 `corepack` 已损坏，**不要**用 `corepack yarn`，改用 `./node_modules/.bin/yarn`
   > （仓库锁定 `yarn@4.18.0` 本地 shim）。实例 `wrangler.jsonc` 已含 `accountId`，
   > 故省略 `--account-id`；若显式传入须是 `77f8238a6f20e707f2ed94d3a27a31ce`。

   该命令会重新生成配置、应用 D1 迁移、运行类型检查与部署冒烟测试、构建，
   全部通过后才发布 Worker 并验证。任一步失败都不会上线。注意：`npx`
   前缀部署的是官方捆绑 release 源码，**无法发布本地提交**；发布本地更改
   必须用本地 `yarn manage`。
3. **Cloudflare 授权（仅首次需要；凭证保存后自动复用）**：
   - 本地 `yarn manage` 引擎使用独立的 Wrangler 凭证。本机的浏览器回调
     OAuth（`wrangler login` 默认方式）会打开浏览器并等待
     `localhost:8976` 回调，在本机**必定超时失败**，不要反复重试。
   - 可复现的替代方式是设备码流程：以 `connect` 为例——

     ```console
     corepack yarn manage connect --device --worker ctwh-881019-xyz \
       --instance ctwh-881019-xyz --account-id 77f8238a6f20e707f2ed94d3a27a31ce
     ```

     `init`、`deploy`、`status`、`accounts` 同样支持 `--device`。
   - 设备码流程的操作步骤：命令运行后会打印
     `https://dash.cloudflare.com/oauth2/device/verify` 和一个一次性代码
     （5 分钟有效）。**把命令放到后台运行，立即读取其输出文件拿到 URL 和
     代码并转达用户**（前台管道运行会让用户全程看不到代码，导致超时）。
     用户在浏览器打开链接、输入代码、点击 Allow 后命令自动继续。设备码
     授权不创建 API token，凭证保存在 Wrangler 配置存储（不经系统钥匙串），
     直到 `wrangler logout` 才移除。
   - 凭证保存后，后续 `deploy`/`status` 自动复用，无需再次授权。只有执行
     `wrangler logout`、在 Cloudflare 仪表盘撤销授权或切换 profile 时才需要
     重新授权。
4. **部署后验证**：

   ```console
   corepack yarn manage status --instance ctwh-881019-xyz --account-id 77f8238a6f20e707f2ed94d3a27a31ce
   ```

   确认 Worker/D1/R2 绑定、管理员登录状态、自定义域名全部通过。因本机
   网络限制，补充验证用绕过本地 DNS 的方式：
   `curl --resolve feed.881019.xyz:443:104.21.89.151 https://feed.881019.xyz/.well-known/microfeed.json`。

### 部署排障（本机实测，2026-09-22）

`manage deploy` 的 `runChecks` 依次跑 `types → typecheck → test:deploy → build`，任一失败都不上线；
随后**静默**应用 D1 迁移并上传。常见失败与处理：

- **`yarn.js typecheck failed`（约 3 分钟后失败）**：门禁是 `yarn typecheck`
  （= `yarn types && astro check && tsc --noEmit`），其中 `astro check` **连 `tests/` 一起查**，
  而单跑 `tsc --noEmit` 会假通过。失败信息常被 spinner 覆盖、不打印具体 TS 错误 →
  部署前先单独跑 `yarn typecheck` 确认为 0 errors；报错定位读 `deploy.log`。
  常见诱因是分支里未完工功能代码的接线/类型错误（漏导入、`request.json()` 未标注类型、
  `Uint8Array<ArrayBufferLike>` vs `BufferSource`）。
- **构建被批量删除闸中止（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）**：`astro build` 会清理
  `dist/server/.prerender`、`dist/server/.vite` 等 >50 文件；本沙箱须给命令加前缀
  `CODEBUDDY_SAFE_DELETE_ENABLED=0`。
- **Cloudflare 鉴权失败 `Authentication error [code: 10000]`**：`manage deploy` 在
  `d1 migrations apply --remote` 阶段报此错（`/accounts/.../d1/database/.../query` 被拒）。
  根因通常是沙箱出口代理改写发往 `api.cloudflare.com` 的 `Authorization` 头（09-23 曾实测：
  代理换成自身 token，scope 形如 `websearch.run`/`agent-memory:write`，**非 Cloudflare scope**）。
  **注意**：此前记录的「命令前加 `env -u HTTPS_PROXY …` 直连」已被证伪——该前缀会让
  `manage deploy` **静默早退（exit 0、零输出，部署没发生，09-24 实测）**。当前可用命令就是
  默认出口代理下的 `CODEBUDDY_SAFE_DELETE_ENABLED=0 ./node_modules/.bin/yarn manage deploy …`
  （09-24 以此正常跑完，约 4 分钟、`Deployed and verified`、无 10000）。若再遇 10000，先确认
  凭证（`wrangler whoami`）与代理状态，**不要**盲目加 `env -u`，重试普通命令即可。
- **挂死在 `Building the Worker`**：残留 `dist` 所致 → 先
  `mkdir -p node_modules/.stale && mv dist node_modules/.stale/dist-<ts>` 再部署。
- **后台部署会在回合结束时被杀**：日志停在 banner 且无 `EXIT:` 行；要么前台阻塞等
  `Deployed and verified`，要么后台跑但**必须回读** `.microfeed/deploy.log`。日志一律落盘，
  **不要用 `| tail`**（管道缓冲会丢输出）。
- **迁移静默应用**：日志无迁移阶段提示，成功 ≠ schema 已落 → 部署后直查 D1 验证表/种子。
- **判断工作树是否领先上次部署**：比对源文件 mtime 与上次 `deploy.log` mtime（源文件更新则需重跑）。

## 已部署的 microfeed 实例

- 站点 `ctwh-881019-xyz`，账户 "Xi.ernest@gmail.com's Account"（ID 尾缀
  …31ce）：自定义域名 `feed.881019.xyz`，D1 `ctwh-881019-xyz-db`，
  R2 `ctwh-881019-xyz-media`（就绪），仪表盘路径 `admin`，内置登录。
  Webhooks 未开通。
- 站点通过公开的 `npx @microfeed/cli` 启动器初始化。本地 `yarn manage`
  引擎之后用只读的
  `connect --worker ctwh-881019-xyz --instance ctwh-881019-xyz` 挂接；本机
  Wrangler 浏览器回调 OAuth 必超时，使用 `--device` 设备码流程（操作步骤
  见上文"已部署实例的部署流程"）。保存的凭证被后续命令复用。
  - 只能通过 `CODEBUDDY_SAFE_DELETE_ENABLED=0 ./node_modules/.bin/yarn manage deploy --instance ctwh-881019-xyz --yes`
    部署本地源码更改（前缀含义见上文"部署命令"警告框；**不要**加 `env -u HTTPS_PROXY …`，会让部署静默早退）。`npx` 前缀部署的是捆绑 release 源码，无法发布本地提交。
- 公开站点运行激活的自定义主题 `local.feed-zh`
  （`microfeed.default@1.1.15` 的简体中文 fork），在检出之外的独立 Git
  仓库 `D:\git\AiCode\microfeed-themes\feed-zh` 中开发。捆绑主题更新以
  未激活状态安装，绝不覆盖它。
- 公开站点由主题渲染：中文界面在主题模板层实现；管理后台中文由 i18n 框架
  实现（见「管理后台国际化」）。平台注入的搜索弹窗文字与 `humanizeMs`
  生成的公开 feed 日期格式不受主题控制。

## 本机环境注意事项

- 全局 Yarn 是 1.x；所有工作区命令一律通过 `corepack yarn` 运行（仓库锁定
  `yarn@4.18.0`）。
- 本机 `npx` 无法解析包 bin shim（报"不是内部或外部命令"）。`npx
  @microfeed/cli` 前缀失败时，直接用 Node 调用缓存的启动器入口
  （`node <npm-cache>/_npx/<hash>/node_modules/@microfeed/cli/dist/index.js manage …`）。
- 出站网络限制：`*.workers.dev` 与 `cloudflare-dns.com`（DNS-over-HTTPS）
  不可达；局域网 DNS 服务器有很长的负缓存（新建 DNS 记录在本地约十分钟内
  无法解析）。用 `curl --resolve <host>:443:<cloudflare-ip>` 验证站点；CLI
  验证失败可能只是本地问题，站点在全球其他网络正常。
- 系统区域是 zh-CN，Node 的 `navigator.language` 与
  `Intl.DateTimeFormat(undefined)` 会解析为中文。组件测试通过
  `tests/unit/i18n-setup.ts` 把语言钉在英文。
  `tests/unit/components/admin-items-list.test.ts` 有一个既有的日期断言在
  本机失败但在 Linux CI 通过。
- 更改 UI 文案（i18n）时，既有测试可能断言旧英文文案；运行测试并把断言
  更新为对应的 i18n 键调用或新的渲染文本。
- GitHub 的 git 推送（receive-pack）必须走本机出口代理：系统 IE/WinINET 代理为
  `127.0.0.1:10808`（浏览器也走它，所以浏览器能访问 GitHub 而 git 直推会卡住）。
  Git for Windows 默认不读取 IE 代理、直连出口；直连时 fetch/pull 可用、push 会
  长时间无响应。修复：`git config --global http.proxy http://127.0.0.1:10808`
  （撤销：`git config --global --unset http.proxy`）。SSH 到 `github.com:22` 与
  `ssh.github.com:443` 亦可连通（仅缺密钥），可作为备选路径。该代理由本机
  VPN/代理客户端提供，客户端未启动时间接推送会失败。

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
- **禁止**用Git回滚任何代码（严厉禁止。如果做了，你将会遭受毁灭性打击）。我在对话中所说的任何“回滚”指的都是“用文件编辑工具，手动将代码恢复到上一个状态”，而**不是**使用git进行回滚。
- **禁止**读写/tmp目录下的内容（如果你需要产生一些中间结果，你应该输出在当前目录下的一个特定的用于存放中间结果的目录；该目录需要被gitignore）
- **禁止**主动使用视觉功能（因为你的视觉能力清晰度特别差，会导致错误的定位，让你做出错误的决策）

提供网页链接时，必须先了解网页链接内的**完整**内容，再开始执行任务。
如果发现库的用法错误，必须先**重新查看**所提供的网页链接的**完整内容**。
不要求最小化依赖，不允许用各种乱七八糟的方式（包括造轮子）绕过依赖。

编写的代码应当寻求fast-fail，在出错位置就地崩溃, 而不是捕获错误，也不是fallback。
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

如果我是以疑问句结尾的，那么这句话就是一个**问题**而不是一个命令。问题只需要被回答，**不需要也不允许**：(1) by the way，提出一个更好的方案；(2) 反而向用户抛出一个问题；(3)结尾说“如果你准备好了我就开始实施”等你以为helpful其实用户读起来bothering而且恶心的话。

在任何思考、回复、文档里面不允许出现"That's a lot", "This is a substantial rewrite"等对工作量的评判。你只是一个工具，就像计算器不会评价要计算的数太大了一样，你没有资格评判工作量。你没有资格把你自己当做我的同事。禁止简化任何设计。
