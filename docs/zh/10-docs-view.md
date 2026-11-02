---
title: 10 文档位置与查看
description: microfeed 项目文档存放位置、本地/线上查看方式，以及「所有规则与文档统一放 ./docs」的约定。
---

# 10 项目文档位置与查看方式

> **用途**：找到项目文档、在本地/线上查看，或产出新文档时确定落点。
> **触发词**：项目文档在哪、怎么看文档、docs 目录、文档站、ADR、规则放哪。
> **加载时机**：需要查文档、看规范、写文档、或定位规则落点时读取本册。

## 1. 文档都在哪里

项目根目录的 `docs/` 是**唯一文档站**（Astro Starlight 项目，`root = docs/`），与源码同仓、可离线查看。

| 子目录 / 文件 | 内容 |
| --- | --- |
| `docs/index.mdx` | 文档站首页 |
| `docs/manage-cli.md` | 管理 CLI 权威命令/选项/安全参考（部署、实例、主题、快照、销毁） |
| `docs/microfeed-cli.md` | 内容管理 CLI 权威参考 |
| `docs/theme-kit-cli.md` | 主题作者 CLI 权威参考 |
| `docs/start-here/` | 安装/部署：`ai-agent` `github-actions` `manual` `install` `concepts` `after-deploy` |
| `docs/dashboard/` | 后台使用：`customize` `edit-channel` `media-and-feeds` `pages-search-and-site-files` `publish` `themes` |
| `docs/manage/` | 运维：`update` `domains-and-access` `multiple-instances` `backups-and-migrations` `troubleshooting` `remove` |
| `docs/api/` | API：`authentication` `build-and-test` `index` |
| `docs/themes/` | 主题开发：`assets` `contract` `index` |
| `docs/webhooks/` | Webhook：`endpoints` `index` `operations` `testing` |
| `docs/automation/` | 自动化：`ai-agents` `cli` `index` |
| `docs/contribute/` | 贡献指南 |
| `docs/reference/` | 术语表 |
| `docs/adr/` | **架构决策记录**（ADR），编号 `NNNN-kebab.md` |
| `docs/src/` | 文档站源码（`content.config.ts`、组件、样式、资源） |
| `docs/zh/` | **中文协作分册**（`01`~`12`，按功能/用途拆分） |

**内容收录**：`docs/src/content.config.ts` 用 `glob` 收录 `index.mdx`、三个 CLI 参考、以及 `start-here/` `dashboard/` `themes/` `manage/` `api/` `automation/` `webhooks/` `reference/` `contribute/` `zh/` 子目录的 md/mdx。**新增文档要进站，必须在此新增 glob 模式**。

## 2. 怎么查看

| 动作 | 命令 | 说明 |
| --- | --- | --- |
| 本地实时预览 | `yarn docs:dev` | `astro dev --root docs`，浏览器打开 localhost |
| 本地构建校验 | `yarn docs:build` | 构建到 `docs/dist` |
| 完整校验 | `yarn docs:check` | `astro check --root docs` + build + `docs/scripts/check-build.mjs` |
| 线上预览环境 | `yarn docs:upload-preview` | 先 `docs:check`，再 `wrangler deploy --strict --env preview` |
| 线上发布 | `yarn docs:deploy` | 先 `docs:check`，再 `wrangler deploy --strict` |
| 公开站 | — | `https://docs.microfeed.org`（权威线上版） |
| 直接读文件 | `Read` 工具 | 任意 `docs/**/*.md|mdx` 可直接读（`docs/zh/` 是中文协作版） |

## 3. 「所有规则与文档统一放 ./docs」的约定

- **本仓库的一切规则、规范、指南**（开发流程、架构边界、API 契约、DB 规范、新建模块指南、触发词路由）**统一收敛在项目根目录 `./docs` 下**，与代码同仓、可随版本演进。
- 本仓库规则统一为**中文**，权威版为根目录 `AGENTS.md`，详细分册在 `docs/zh/`；不保留英文规则版。
- 规则变化时：改 `docs/zh/` 对应分册 + 同步 `AGENTS.md` / 对应领域文档；涉及架构决策补一条 `docs/adr/NNNN-*.md`；CLI 行为变化同步 `manage-cli/help.ts`、`packages/cli/src/help.ts`。
- 文档校验：`yarn docs:check` + `git diff --check`（执行时机归 AGENTS.md「最高指令：门禁仅在手动触发时运行」）；**不要**为文档内容加断言测试。
- 产出文档、分析、指南时，**优先落到 `./docs`**（而不是散落在临时目录），保持「规则与文档一个地方」。
