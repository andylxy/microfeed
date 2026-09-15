# 仓库指导

## 最高指令：git 提交检查（优先级最高，任何提交前必须执行）

- 任何 git 提交之前，必须完成项目要求的检查：`git diff --check` 必须无输出，
  并运行本仓库的检查命令（完整门禁 `corepack yarn check`；至少运行
  `corepack yarn typecheck` 与 `corepack yarn test`，涉及构建改动时运行
  `corepack yarn build`）。检查未通过时禁止提交。
- 只提交与当前任务相关的文件；绝不提交无关变更、临时目录（如 `.zcode/`、
  `.workbuddy/`）或任何凭证类文件。
- 提交信息使用简洁的祈使句标题（例如 "Add admin dashboard i18n"）。
- 不得直接提交到 `main`；在按规范命名的任务分支上提交（见"开发工作流"）。

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
- 绝不在聊天中索取或接受 Cloudflare token 或 microfeed 密码。编码代理绝不
  得使用 `--admin-password`；该不安全选项仅供接受命令历史与进程列表暴露的
  无人值守自动化使用。
- 先用 `yarn manage accounts --json` 发现授权与账户。当用户想要单独的命名
  登录时，使用 `yarn manage accounts --profile <name> --reauthorize`，不要
  替换其他 Wrangler 配置文件。需要时让 Wrangler 打开浏览器授权。若只返回
  一个账户就直接使用；若返回多个，用通俗语言解释名称与 ID 尾缀并请用户
  选择。把完整的账户 ID 传给初始化及之后的所有操作，绝不擅自选第一个。

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
   corepack yarn manage deploy --instance ctwh-881019-xyz --account-id 77f8238a6f20e707f2ed94d3a27a31ce
   ```

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

## 主题仓库

- 当用户要求编码代理从已保存实例初始化、导出、复制、fork、检查或开始开发
  主题时，使用本仓库的 `export-microfeed-theme` 技能。
- 使用 `yarn manage theme init` 从站点的实际外观创建新主题身份。当用户需要
  保留包身份的精确已安装不可变版本时使用 `yarn manage theme export`。
- 初始化或导出后仅做验证。除非用户另行要求安装、激活、停用、删除、staging、
  提交、创建远程或推送，否则不要执行这些操作。验证用的预览服务器用完必须
  停止。

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
- 绝不索取、读取、打印、记录或复制 API key、OAuth 访问 token、刷新 token、
  client secret 或加密凭证文件。环境凭证由操作者提供，对代理保持不透明。
- `yarn microfeed login <site-url>` 需要管理员在浏览器登录并批准范围。需要
  时启动该命令，明确请用户完成浏览器步骤，绝不要代替用户批准同意页面。
- 删除条目前，确认确切的已保存实例名与条目 ID，解释影响并获得确认。仅在
  确认后使用 `yarn microfeed item delete <item-id> --confirm <item-id>`，
  绝不绕过精确 ID 安全检查。

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
- 只能通过 `corepack yarn manage deploy --instance ctwh-881019-xyz` 部署
  本地源码更改。`npx` 前缀部署的是捆绑 release 源码，无法发布本地提交。
- 公开站点运行激活的自定义主题 `local.feed-zh`
  （`microfeed.default@1.1.15` 的简体中文 fork），在检出之外的独立 Git
  仓库 `D:\git\AiCode\microfeed-themes\feed-zh` 中开发。捆绑主题更新以
  未激活状态安装，绝不覆盖它。
- 公开站点由主题渲染：中文界面在主题模板层实现；管理后台中文由 i18n 框架
  实现（见下节）。平台注入的搜索弹窗文字与 `humanizeMs` 生成的公开 feed
  日期格式不受主题控制。

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
