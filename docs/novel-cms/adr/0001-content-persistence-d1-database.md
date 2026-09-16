# ADR-0001: 内容持久化采用 D1 数据库（非文件）

- 状态：Accepted（已确认）
- 日期：2026-09-16
- 决策人：用户 + 设计评审

## 背景

用户明确约束："书内容、章节、内容数据必须存入 DB，不能靠文件保存。"
需确认 microfeed 的实际存储机制是否满足，并锁定为方案不可动摇的前提。

## 决策

**小说站 CMS 的全部内容（书元数据、章节正文、卷标签、审核留痕、分类、举报）一律持久化到 Cloudflare D1 数据库。** 不使用任何文件系统作为内容存储。

## 事实依据（已核实代码）

1. `migrations/0001_initial.sql`：`items` 表与 `channels` 表均含 `data TEXT` 列。
2. `src/server/feed/FeedDb.ts`：
   - `_putItemToContentStatement`（558–581 行）：`data: JSON.stringify(data)` 写入 `items.data`。
   - `_putChannelToContentStatement`（523–536 行）：同理写入 `channels.data`。
   - 同时派生 `content_text`（正文纯文本）单列存储，供检索。
3. 全仓库 grep 文件读取（`readFileSync`/`loadFromFolder`/`fs.read`）：**无内容从文件读取的代码**。`runFromFolder` 仅出现在 i18n 文案（指 R2 媒体存储设置提示），与内容无关。
4. microfeed 运行于 Cloudflare Worker + D1：Serverless、无持久本地文件系统，内容客观上只能落 D1。

## 影响

- 满足用户"必须进 DB"的硬约束 ✓。
- 扩展表（`ext_category` / `ext_content_audit` / `ext_content_report`）也全部为 D1 表，`TEXT`/表列存储，一并满足。
- 因无文件存储，备份/迁移走 D1 导出（非文件同步），方案 §10 验证方式已覆盖。

## 一致性

- 下游 ADR（审核留痕、分类、角色）均须遵守"只落 D1"的前提，不得引入文件型内容存储。
