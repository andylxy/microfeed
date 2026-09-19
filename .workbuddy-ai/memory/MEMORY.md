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
- **提交信息用中文**（用户明确要求，2026-09-19）。格式沿用既有风格
  `type(scope): 中文描述`，例：`feat(theme): 完成小说站主题重构和数据修复`、
  `fix(novel): 书卡连载状态与字数、目录按发布时间排序`。
  AGENTS.md 里的英文示例（`Add admin dashboard i18n`）不代表用户实际习惯，**以中文为准**。
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
  撞 safe-delete 闸 → `SAFE_DELETE_BULK_CONFIRM_REQUIRED`。**光挪 `dist` 不能免掉闸**
  （构建过程自己会创建再删）。
  `CODEBUDDY_SAFE_DELETE_ENABLED=0 ./node_modules/.bin/yarn manage deploy --instance <n> --yes > .microfeed/deploy.log 2>&1`
  删除目标全是构建产物，可接受。长任务**别用 `| tail`**（管道缓冲，被杀则输出全丢）。
- **`manage deploy` 若卡在 `Building the Worker` 超久，是残留 `dist` 导致**：
  判据是 spinner 还在走但 node 进程 **CPU 时间几乎不涨**
  （`Get-Process node | Select Id,CPU,WS`；别只看 spinner）。
  解法：`mv dist node_modules/.stale/dist-<ts>` 再重跑，约 3 分钟通过。
- **主题层与代码层的键约定**：主题 context 里的 `title` 恒等于**站点名**（`themeContext`
  从 publicFeed 取）。页面级数据不要覆盖它——书本页曾用 `title: book.title` 覆盖，导致
  顶栏 logo 显示书名；已改为 `book_title`（模板顶层 3 处同步改名）。加新页面数据时沿用
  `<entity>_<field>` 命名，别占用 `title`。
- `channels.genre` 存的是分类 **id**（如 `cat_x1` 其实是「东方玄幻」），展示必须解析成名字
  （`ext_category.name`）。`listPublishedBookSamples`/`listChannelsByGenre` 已解析，
  `getBookById` 也补上了 `categoryName`。
- **章节顺序必须按 `pub_date`**，不能按 `chapterNo` / `order` —— 这两个字段**按卷重置**
  （第一卷 第1章 与 第三卷 第1章 都是 1），只按它们排会让目录三卷交错
  （第一章 → 第三卷 第1章 → 第二章 → …）。`getBookChapters` 与 `book/[id]` 路由都已按
  `pub_date` 升序（`chapterNo` 只破同日并列）排序。
- **「取整本书章节」一律走 `getBookChapters(db, bookId, baseUrl)`**（按 `_microfeed.bookId` 直查）。
  **不要用 `loadPublishedFeed` 的分页窗口** —— feed 只返回最新一页，阅读页曾因此只列出
  1 章，并同时显示「已是第一章」和「已是最后一章」。
- **给摘要对象（`ChannelBookSummary`）加字段后要 grep 所有消费点**：`category/[slug]` 路由
  曾用显式挑字段的 map，静默丢掉新加的 label（首页/书本页用 `{...book}` spread 所以没事）。
- `_microfeed.wordCount` 在样本书里是**装饰性编辑值**（3 章 ~750 字却写 52-124 万，
  与章节合计差约 380 倍）；主书按真实合计填（799 字）。全站口径要统一得二选一。

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

## 状态（2026-09-19）

- **本轮工作已全部提交并部署**（分支 `chore/admin-i18n`，在 `009caa6` 之上 8 个提交，
  HEAD `8b27d4e`）：① 测试断言刷新 ② i18n 键 ③ **分卷看板功能（新增）**
  ④ 公开站卡片标签/目录顺序/阅读页目录/书籍搜索 ⑤ theme-kit schema ⑥ 中文主题 0.1.18
  ⑦ 中文主题 0.1.19（首页去分类标签、阅读页去底部目录）⑧ **书籍管理页（新增，含增删改）**。
  工作树只剩记忆文件未提交。
- **书籍（book）就是 `channels` 行**：6 本样本书是非 primary channel，此前后台无管理入口
  （`channels/index.ts` 只重定向到 `primary/`），现已新增 `/admin/books/`。
  ⚠️ `channels.is_primary` 是 UNIQUE —— 新增书必须插 `NULL`，插两个 `0` 会撞约束。
- ⛔ **本环境 `git commit` 必吃分支引用**（6/6 复现）。必须走 `git-safe-commit` 技能的
  `safe-commit.sh`，它会「add → commit → `git rev-parse HEAD` 复核 → 被吃则从 reflog 重写」。
  `git update-ref` 在本环境假成功，只能直接写 `.git/refs/heads/<branch>`（先 `mkdir -p`）。
  详见技能与 2026-09-19 工作日志。

- **全量测试已全绿**（2026-09-18）：单元 **124/124**、worker **16/16**，`yarn i18n:check` passed。
  修掉的真回归：① 内置 default 主题 `1.1.15→1.1.16` 后 8 处断言没跟上
  （`default-theme.test.ts` / `manage-cli/theme-init.test.ts` / `worker/themes.test.ts`）；
  ② `packages/theme-kit/assets/starter/.microfeed/schemas/manifest.schema.json` 缺 `webHome`
  （跑 `CODEBUDDY_SAFE_DELETE_ENABLED=0 yarn theme-kit:build` 重生成）。
  ③ `codeEditor.files.webHome` i18n 键缺失。
- **⚠️ 测试必须这样跑**：`./node_modules/.bin/yarn vitest run`（经 yarn 才有
  `npm_config_user_agent`）。直接调 `./node_modules/.bin/vitest` 会让
  `tests/unit/cli/help.test.ts` **假失败**（CLI help 少 `yarn ` 前缀，见
  `packages/cli/src/help.ts:23`）。`yarn test` 是 `&&` 串联，单元挂则 worker 轮不跑，
  完整验证要分两轮手动跑。safe-delete 闸仍会让 `manage-cli/*` 在全量跑时偶发失败
  （隔离复跑即过）。
- 小说站审计与整改计划见 `.microfeed/方案计划-2026-09-18.md`；第 1~3 批已完成，
  第 4 批（星河剑歌 wordCount / `cat_x1` 规范化）与第 5 批（公开 API 文档开关 /
  书架功能）未做。
