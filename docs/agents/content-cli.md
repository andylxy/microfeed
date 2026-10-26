# 内容管理 CLI

本册从仓库根 `AGENTS.md` 移出，规则条文与凭证条款逐字保留；触发条件见 `AGENTS.md` 的读取约定。

- 当用户要求编码代理列出、读取、创建、更新、删除内容或为 microfeed 站点上传媒体时，使用 `manage-microfeed-content` 技能。更改 CLI 实现或文档本身时不使用该操作技能。
- 把 `docs/microfeed-cli.md` 视为内容管理 CLI 的命令、选项、输出与安全规范的唯一权威参考。CLI 行为变化时保持它与 `packages/cli/src/help.ts` 中的共享帮助清单及命令实现同步。
- 在仓库克隆内管理内容时优先使用 `yarn microfeed`（运行本地 `@microfeed/cli` 工作区，无需全局安装）。对确定性的代理操作使用 `--json` 与 JSON 文件或标准输入；CLI 支持相应操作时，不抓取仪表盘页面，不手工构造 OAuth 请求。
- 区分独立媒体、条目图片（封面或缩略图）与唯一的主媒体附件（JSON Feed `attachments[0]` 与 RSS enclosure）：富文本内嵌图片用 `yarn microfeed media upload <path> --json`，然后把永久的 `media_url` 插入 `content_html`；附加或内封媒体文件时用 `--attachment-file <path>`，条目封面艺术用 `--image-file <path>`。绝不构造、读取或打印短期上传 URL；`--image <url>` 仅用于已托管的封面图。
- 凭证**可以读取**：API key、OAuth 访问 token、刷新 token、client secret、加密凭证文件与**管理员凭据**（管理后台登录邮箱/用户名与口令），都可以由代理从本机配置、环境变量或凭证文件读出，用于执行 `yarn microfeed` 等本机操作与真实浏览器 E2E 验证（如 `scripts/e2e/` 下的脚本）。读取到的值只许留在进程内：**绝不**打印到对话、**绝不**写入任何文件或日志（含 `.microfeed/` 下的日志、脚本与测试夹具）、**绝不**复制到别处、**绝不**提交。凭证始终属于操作者，代理只是使用者。
- 凭证的**来源**只能是本机已有配置：代理仍**不得在对话中向用户索取凭证**。
- `yarn microfeed login <site-url>` 需要管理员在浏览器登录并批准范围。需要时启动该命令，明确请用户完成浏览器步骤，绝不代替用户批准同意页面。
- 删除条目前，确认确切的已保存实例名与条目 ID，解释影响并获得确认。仅在确认后使用 `yarn microfeed item delete <item-id> --confirm <item-id>`，绝不绕过精确 ID 安全检查。
