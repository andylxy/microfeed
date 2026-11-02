---
title: 03 部署与实例管理
description: microfeed 的 Cloudflare 部署与实例管理：管理 CLI、账号发现、破坏性操作、凭证红线、内置登录。
---

# 03 实例管理与 Cloudflare 部署

> **用途**：操作本地或 Cloudflare 实例状态（部署、初始化、快照、销毁、域名、Access、内置登录）。
> **触发词**：部署、实例、初始化、连接、开发、快照、状态、销毁、域名、Access、内置登录、更新、多实例、备份迁移、备份、快照保留。
> **加载时机**：命中上述触发词、且涉及 `yarn manage` / `npx @microfeed/cli manage` 时读取本册。

- 当用户要求编码智能体对本地或 Cloudflare 状态执行 `npx @microfeed/cli manage` 或 `yarn manage`，使用仓库的 `deploy-microfeed` 技能。它覆盖账号、初始化、连接、开发、部署、主题、快照、状态、销毁、Pages 迁移、域名、Access、内置鉴权、配置、实例选择。
- 每次 Cloudflare 部署变更都走管理引擎。仓库外优先 `npx @microfeed/cli manage`；已在仓库内则用 `yarn manage`。若启动器选了 `npx` 前缀，把每个 `yarn manage` / `yarn dev` 示例改写成 `npx @microfeed/cli manage` / `npx @microfeed/cli manage dev`。
- **不要**使用或推荐 Cloudflare 仓库导入、Workers Builds、部署按钮或 API Token 部署。仓库自有的手动 GitHub Actions 工作流会在每次运行创建/更新站点（带冲突检查、可信 ref、每次全新设备授权），它必须调用 `yarn manage`、保持 Wrangler 与 microfeed 状态临时、运行后登出。
- 把 `docs/manage-cli.md` 当作人和智能体都适用的**权威命令/选项/副作用/安全**参考；用不熟悉或破坏性选项前先读对应章节；CLI 行为变化时保持该参考与 `manage-cli/help.ts` 同步。
- **绝不删除或覆盖无关的 Cloudflare 资源**，让管理 CLI 执行它的冲突/复用/续跑检查。
- 删除前先跑 `yarn manage destroy --dry-run`，转述它给出的完整资源清单与控制台检查链接；在跑 `yarn manage destroy --confirm <site>` 之前，针对**该确切站点、账号、应用、数据库、桶、自定义地址、数据删除范围**取得明确批准。绝不用 `--yes`、不删复用的数据、不绕过身份不匹配、不擅自用更低层的删除命令。不要查看或修改 Zero Trust 或 SSL 设置。最后汇报 Workers & Pages、D1、R2 的控制台链接、确切资源名、以及每个应删除还是保留。
- **绝不在聊天里索要或接受 Cloudflare Token 或 microfeed 密码**。编码智能体**绝不能用** `--admin-password`；该不安全选项只给接受命令历史与进程列表暴露的无人值守自动化使用。
- 先用 `yarn manage accounts --json` 发现授权与账号。用户要单独命名登录时用 `yarn manage accounts --profile <name> --reauthorize`，不要替换另一个 Wrangler profile。需要浏览器授权时让 Wrangler 打开浏览器。若只返回一个账号就用它；若返回多个，用大白话说明它们的名字与 ID 后缀，让用户选；把**完整账号 ID** 传给初始化和后续每个操作，**不要**自动选第一个。
- 内置登录只把注册邮箱传给初始化；转述部署后打印的一次性密码创建链接，让用户在浏览器里自选密码，然后重跑 `yarn manage status`。**不要**让用户把密码或私有链接粘贴回聊天。
- **实例/D1 备份只留 1 个完整**：用 `manage snapshot create` 生成的完整备份只保留**最近 1 份**；**临时性**备份（为验证某功能临时导出的 D1）在**验证完功能后立即删除**，不长期留存。备份含未发布内容与管理员数据，按私有数据对待。
