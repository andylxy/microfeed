# microfeed novel-cms 项目记忆

## 验证工作流（本沙箱关键，可复用）
- vitest worker 池在本沙箱无法初始化（已知可靠的项目测试也报 "Cannot read properties of undefined (reading 'config')"），属环境缺陷非代码。等价验证改法：用 esbuild 转译真实 TS 模块（含 `@` 别名，传 tsconfig）+ node:sqlite 内存库（`DatabaseSync`）跑断言；vitest 测试文件仍作 CI 交付物保留。
- `tsc --noEmit` 须用 `node node_modules/typescript/bin/tsc`（`.bin/tsc` 是 sh 包装，node 直跑报 SyntaxError）。
- wrangler 本地验证：`.bin/wrangler` 是 sh 启动器（依赖 dirname/sed，本环境缺失→SyntaxError），改用 `node node_modules/wrangler/bin/wrangler.js` 直跑；`d1 migrations apply --local` 用 `-c <生成配置>` 指定本地实例配置（含 database_name/database_id），非交互模式自动跳确认（无 `--yes` 参数，加它会报 Unknown argument）；首次会下载 workerd 运行时（走代理），本地 D1 状态落在 `<configDir>/.wrangler/state/v3/d1`；本地库与线上库完全独立，迁移只推 schema 不搬数据。
- 本地 dev 必须用 `yarn manage dev`（本质是 `astro dev`，由 Astro Cloudflare 适配器在本地模拟 Worker+D1+R2），**不能**直接 `wrangler dev`：部署配置把 `main` 指向源码 `src/worker.ts`，它 import 的 Astro 虚拟模块（`virtual:astro:app`/`astro:static-paths`/`virtual:astro-cloudflare:config`）未构建会报 "Could not resolve"。`manage dev` 流程：resolve 实例(本机仅 ctwh-881019-xyz)→generateWranglerConfig→applyLocalMigrations(本地 D1)→prepareItemSearch→`runYarnScript("dev:astro")`→`astro dev`。注意 `yarn manage dev` 经 `node_modules/.bin/astro` sh 启动器，本沙箱 shim 缺 dirname 跑不起来；用户应在自己终端跑。`.dev.vars` 不在 gitignore，且仅 `dist`/`.wrangler` 被忽略——本地占位密钥可放 `.dev.vars`（已建，勿提交）。
- bash 工具须 `export PATH="/c/Users/zhs/.workbuddy/binaries/node/versions/22.22.2-3:$PATH"`；`dirname/cd/head/tail/grep/cat` 在本环境 shim 下报错，文件删除用 `node -e fs.unlinkSync(...)`。

## 加性迁移约定（novel-cms）
- 所有扩展表走 `ext_*` 命名空间 + 高序号加性迁移（上游当前最大 0022，新表 0023 起），与上游 microfeed 零冲突、rebase 仅保持序号递增。
- 查询字段落成真实列+索引（items.review_status / channels.genre），因 `_microfeed` 是 data JSON 内部字段、非列，不能进 WHERE（G2 历史 bug）。
- 留痕设计 ADR-0003：字段级 diff + 每 K 次检查点（检查点存全量快照）；rebuild 从最近检查点 + diff 重放还原任意历史版本。

## 工单顺序（matt-pocock 流）
- 01 数据底座与留痕引擎（None）→ 02 分类管理(01) / 03 章节与书录入(01) / 04 公共小说展示主题(01) / 05 内容审核与留痕(01,03) / 06 新后台页中文化(02,03,05)。
- 每单 `/implement`（内部驱动 /tdd）→ `/code-review` 两轴（Standards + Spec）→ 提交到 `chore/admin-i18n`。
