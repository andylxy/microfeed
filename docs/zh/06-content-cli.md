---
title: 06 内容管理 CLI
description: microfeed 内容管理 CLI 的使用规范：yarn microfeed、媒体区分、删除保护、凭证红线。
---

# 06 内容管理 CLI
> **用途**：对 microfeed 站点的内容做列出/读取/创建/更新/删除，或上传媒体。
> **触发词**：内容管理、发布内容、创建/更新/删除条目、上传媒体、图片/音频/视频、CLI。
> **加载时机**：命中上述触发词、且要通过 `yarn microfeed` / `npx @microfeed/cli` 操作内容时读取本册。

- 当用户要求编码智能体对 microfeed 站点的内容做列出、读取、创建、更新、删除、或上传媒体，使用 `manage-microfeed-content` 技能。改动 CLI 实现或文档本身时不要用这个操作型技能。
- 把 `docs/microfeed-cli.md` 当作内容管理 CLI 的**权威命令/选项/输出/安全**参考；CLI 行为变化时让它跟 `packages/cli/src/help.ts` 的共享帮助清单和命令实现保持同步。
- 在仓库克隆里管理内容优先用 `yarn microfeed`，它跑本地 `@microfeed/cli` workspace，无需全局安装。
- 对确定性智能体操作使用 `--json` 以及 JSON 文件或标准输入；CLI 支持该操作时不要去爬取控制台页面或手搓 OAuth 请求。
- 区分独立媒体、条目图片（封面/缩略图）、以及一个主媒体附件（JSON Feed `attachments[0]` 与 RSS enclosure）。富文本内联图片用 `yarn microfeed media upload <path> --json`，再把永久 `media_url` 插入 `content_html`；用户要附加或封装媒体文件用 `--attachment-file <path>`，仅条目封面图用 `--image-file <path>`；不要构造/读取/打印短寿命上传 URL，已托管的封面图才用 `--image <url>`。
- **绝不**索要、读取、打印、记录或复制 API Key、OAuth access token、refresh token、client secret 或加密凭据文件。环境凭据由操作员提供，对智能体必须保持不透明。
- `yarn microfeed login <site-url>` 需要管理员在浏览器里登录并批准 scope。需要时启动命令，清楚请用户完成浏览器步骤，**不要**替用户批准同意。
- 删除条目前，确认确切的已保存实例名与条目 ID，说明影响，取得确认。确认后只用 `yarn microfeed item delete <item-id> --confirm <item-id>`，**绝不**绕过这个精确 ID 保护。
