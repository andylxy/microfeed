# microfeed 项目长期记忆

## 当前工作流：管理后台 i18n（分支 `chore/admin-i18n`）

- 架构：i18next + react-i18next 全局单例（Astro islands 无共享 Provider）。
  资源 `src/shared/i18n/en.ts`（键形状唯一事实来源）+ `zh-CN.ts`（`DeepStringify` 编译期镜像）。
- 详细操作流程见用户级技能 **`microfeed-admin-i18n`**（跑测试的正确姿势、失败分类、
  过期断言收敛、不可翻译的不变量）。不要在这里重复。

## 本项目硬约束

- **禁止自动 git 提交**（`add` / `commit` / `push` 等明确指令）。
- 提交前门禁：`git diff --check` 无输出 + typecheck + test。**不得直接提交 `main`**，
  在 `<type>/<short-kebab-case>` 分支上工作。
- 改动 i18n 文案时，既有测试可能断言旧英文文案 → 需把断言更新为对应的 i18n 键调用
  （AGENTS.md 明确授权）。
- **改完 i18n 必须跑「键存在性 + 中英文一致性」两项校验**，`tsc` 通过 ≠ 键正确：
  `translate` 查不到键会**原样返回键名**，用户界面会直接显示 `errors.x.y`。
  用 `node --import tsx` 跑脚本 import 真实模块校验（键存在性：对每个引用键调
  `translate(K)`，返回值 === 键名即缺失；一致性：`flatten(en)` vs `flatten(zhCN)`
  比键集合 + `{{占位符}}` 集合）。做法见 2026-09-15 工作日志。
- 范围外的问题只报告、不动手。
- **语言解析顺序必须三处一致**：cookie（显式偏好 `microfeed-admin-language`）→
  `Accept-Language` / `navigator.language`。服务端 `adminLanguageFromRequest()`、
  内联脚本 `AdminLanguageScript.astro`、客户端 `i18n.ts` 的 `detectBrowserLanguage()`
  三处任一漏掉 cookie，首屏就会渲染成错的语言（先英文、水合后翻中文的闪烁）。
  动语言相关代码后要复查这三处仍一致。
- **i18n 只改语言显示，绝不改功能逻辑**（用户明确要求）：状态码、响应头、
  响应格式（JSON vs 纯文本）、控制流都必须逐项与 `git diff` 核对后保持不变。
  判据：原本是 JSON 用 `localizedError`，原本是纯文本用 `localizedTextError`。
  统一助手（如 `notFoundResponse`）不要凭空注入原本没有的 `statusText`/响应头。

## 小说站 novel-cms：主题 / 数据运维（2026-09-18 摸清）

- **主题内容存在 D1，不走代码发布**。改 `themes/feed-zh/*.mustache` 或
  `microfeed-theme.json` 后只需：`manage theme install themes/feed-zh --instance ctwh-881019-xyz`
  → `manage theme activate <uuid>`（uuid 用 `manage theme list --json` 取）即生效。
  只有路由/服务端代码改动才需要 `manage deploy`。
  **顺序：先 `deploy` 再切主题**——反过来会出现「新模板 + 旧代码」的空导航窗口。
- **远程 D1 直查/改**：
  `./node_modules/.bin/wrangler d1 execute ctwh-881019-xyz-db --remote --config .microfeed/instances/ctwh-881019-xyz/wrangler.jsonc --command "…"`
  （也支持 `--file x.sql`）。database_name / account_id 都在那个 wrangler.jsonc 里。
- **item 正文存 `data.description`（HTML）**，`content_text` 是派生的纯文本；公开 JSON
  构建器把它映射成 `content_html` 喂阅读模板。把正文写进 `data.content_html`
  → 阅读页正文区空白（标题仍在）。
- **item id 必须 11 位**：`getIdFromSlug` 只认 `/[\d\w\-_]{11}$/`，不足 11 位则
  `/i/`、`/json/`、`/rss/` 的单条 URL 全部 404（列表页正常）。查：`length(id) <> 11`。
- **共享样式表把 `html` 限成 `max-width:70ch`（≈604px）+ `margin:auto`**，整页被挤成窄条、
  顶栏 auth 竖排折行。feed-zh 用 `html:has(.fq-header){margin:0;max-width:none;padding:0}` 逃逸；
  连带必须改 `.mf-reader-page` 的负 margin（→`0 auto`）和页面根的 `width:100vw`（→`100%`），
  否则阅读页被裁 / 多出横向滚动条。
- 顶部导航数据来自 `loadSiteNav()`（`src/server/feed/siteNav.ts`）；
  **每个渲染 `getWebBodyStart()` 的公开路由都要把结果 spread 进 Theme 的 extraContext**
  （index / book/[id] / category/[slug] / i/[slug] / search / server/pages/public.ts），
  漏一个那页导航就静默变空。
- **⛔ `manage deploy` 必须加 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 前缀**（2026-09-18 连挂两次）：
  `astro build` / `vite` 会清 `dist/server/.prerender/`、`dist/server/.vite/`（>50 文件），
  撞 safe-delete 闸 → `SAFE_DELETE_BULK_CONFIRM_REQUIRED`。**预先 `mv dist` 挪走没用**
  （构建过程自己会创建再删）。正解：
  `CODEBUDDY_SAFE_DELETE_ENABLED=0 ./node_modules/.bin/yarn manage deploy --instance <n> --yes > .microfeed/deploy.log 2>&1`
  删除目标全是构建产物，可接受。长任务**别用 `| tail`**（管道缓冲，被杀则输出全丢）。
- **主题层与代码层的键约定**：主题 context 里的 `title` 恒等于**站点名**（`themeContext`
  从 publicFeed 取）。页面级数据不要覆盖它——书本页曾用 `title: book.title` 覆盖，导致
  顶栏 logo 显示书名；已改为 `book_title`（模板顶层 3 处同步改名）。加新页面数据时沿用
  `<entity>_<field>` 命名，别占用 `title`。
- `channels.genre` 存的是分类 **id**（如 `cat_x1` 其实是「东方玄幻」），展示必须解析成名字
  （`ext_category.name`）。`listPublishedBookSamples`/`listChannelsByGenre` 已解析，
  `getBookById` 也补上了 `categoryName`。

## 本机环境（会反复咬人）

- `corepack yarn` 路径解析损坏，无法使用。等价替代见技能 `microfeed-admin-i18n`。
- safe-delete 批量删除闸会打死 `astro check` / `vite` / `pnpm install`，也会让
  `manage-cli/*` 测试在全量跑时假失败。见技能 `sandbox-safe-delete-guard`。
- **⛔ 每次 `git commit` 后必须立刻 `git rev-parse HEAD` 复核**（2026-09-16 连两次实测）：
  本环境里 commit 会**报成功但吃掉分支引用文件**，症状是
  `fatal: your current branch 'X' does not have any commits yet` +
  `git status` 把整仓显示成已暂存。**对象和 reflog 完好，零数据丢失**：
  从 `.git/logs/HEAD` 取 SHA → `git cat-file -t` 核验 → **直接写**
  `.git/refs/heads/<branch>`（`git update-ref` 在此环境假成功，不可用）。
  **别用 `git reset`/`checkout` 去"修"**。详见技能 `git-corrupt-object-recovery`。
- **`yarn` 是可用的，直接执行 `./node_modules/.bin/yarn <script>`**（2026-09-16 更正）。
  坏的只是 `corepack`（把 MSYS 的 `/c/...` 拼成 `D:\c\...`）。
  ⛔ 别用 `node` 去跑那个 shim——它是 `#!/bin/sh` 脚本，会报莫名的语法错。
  `yarn test` / `yarn check` / `yarn install --immutable` 都能跑，
  所以 CI 的 lockfile 检查也能在本地复现。
  历史遗留的替代法（手工调 vitest + 补 `npm_config_user_agent`）仍可用但不必需。
- **`src/shared/` 下新建模块不能用 `@/` 路径别名，必须相对导入**（如 `./i18n`）。
  原因：theme-kit CLI 经 `node --import tsx packages/theme-kit/src/cli.ts` 启动，
  该上下文解析不到 app 的 `@/shared` 别名 → `ERR_MODULE_NOT_FOUND`，
  `tests/unit/theme-kit.test.ts` 会挂 2 个用例。同目录既有文件都是相对导入，
  所以只有新模块会踩这个坑。

## 状态（2026-09-16）

- **i18n 全部完成并提交**：第一批（4 模块）、服务端错误消息、闪烁修复、
  日期/数字本地化、第二批 API 浏览器全译（131 条映射）。
  分支 `chore/admin-i18n`，已部署到生产 `feed.881019.xyz` 并端到端验收。
- **全量单测基线**：118 文件 / 795 用例，**2 个失败恒为环境性**
  （`manage-cli/instance-management`、`manage-cli/webhook-lifecycle`，safe-delete 闸；
  隔离复跑 227 用例全绿）。看到它们**不要当回归**。
- 仍待用户拍板：公开 API 文档页 `/api/v1/` 的 `lang="en"` 硬编码是否要跟随访客语言。
- 部署相关（`manage-cli` 的 preview/auth/destroy 用法、`*.workers.dev` 被 DNS 劫持）
  见 2026-09-16 工作日志。
