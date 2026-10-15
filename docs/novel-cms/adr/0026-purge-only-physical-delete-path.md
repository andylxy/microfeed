# ADR-0026: 物理删除收敛为管理端点 purge

- 状态：Accepted
- 日期：2026-10-14
- 决策人：用户 + 设计评审
- 关联设计：AGENTS.md「安装激活后：清理旧版本」与 :262 的端点 purge 唯一合法路径（改写前 :252 的裸 SQL 禁令）、CONTEXT.md「管理后台的删除语义」（本 ADR 产出的词汇）、ADR-0024（读代价量化的报告口径）
- 本 ADR 来源：`.scratch/purge-delete/spec.md`（grill-with-docs 评审定稿，两轮 code-review 闭环）；工单划分见 `.scratch/purge-delete/issues/01..08`

## 背景

用户提出三件事：① 自定义主题只保留激活与上一版，其余全部删除；② 主题的删除按钮目前只是软删除，要增加物理删除；③ 其他软删除 CRUD 页面同样补物理删除。

现状（2026-10-14 勘察）：主题删除全链路都是软删除——后台 DELETE → `ThemeStore.deleteVersion`（写 `deleted_at`）→ CLI 与 well-known 管理端点同路；`items` / `pages` / `channels` 翻 `status` 到删除态，公告用自有机器的状态 4，webhook 端点写 `deleted_at`（另有一个按保留期物理清理的 cron）。全仓没有任何面向用户的物理删除入口，`DELETE FROM themes` 只存在于测试清理与文档禁令中。

关键量化（本地实例 ctwh-881019-xyz 快照实测）：custom 主题 live 2 行 + 墓碑 15 行（`local.feed-zh` 0.1.36–0.1.50）。墓碑行仍占用 `UNIQUE(package_id, version)`，重装同版本直接报 `versionReusedAfterDeletion`（ThemeStore.ts:577-581）——软删除清完一轮，旧版本既不在列表里也装不回来。

AGENTS.md 原 :252（改写后 :262）明令禁止用 `wrangler d1 execute … "DELETE FROM themes"` 绕过：理由是物理删除（当时）不清理 R2 资产、不改 `theme_state`、不可恢复。这条禁的是「绕过」，禁因在带守卫的端点里逐条消除后，物理删除本身有了合法形态。

## 决策

### D1｜常驻功能 + 一次性验收

物理删除做成后台常驻功能（任何实例任何时间可用），并在本地实例实跑一次「清理旧版本」作为验收；AGENTS.md 里「每次安装激活后清理旧版本」的固定收尾动作随之有了界面入口。

### D2｜清理口径为全局 keep 集

keep 集 = {`theme_state.active_theme_id`, `theme_state.previous_theme_id`}，二者之外的自定义主题行全部删除。`previous_theme_id` 为 NULL 时只保留激活行；激活主题是 built-in（`microfeed.*`）时拒绝执行并提示。AGENTS.md 既有的「按 package 保留最新 + 上一版」修剪口径保留为 CLI 侧流程，本 ADR 的清理入口用全局口径。

### D3｜清理范围包含墓碑行，删除一律走 purge

墓碑行（已软删除、仍占着重装位的历史版本）纳入清理范围；live 的非 keep 行与墓碑行都物理删除（purge）。只删 live 行的话，墓碑仍占着重装位，清理不完整。

### D4｜端点内 purge 是唯一合法物理删除路径

管理端点里的 purge 必须同时满足三件事：清 R2 资产（删行后跑 `cleanupAssetOwner`，先删行后清资产——其引用计数只算未删行与草稿，反序会把自己算成引用而跳过清理）、清 `theme_state` 引用（`previous_theme_id` 指向被删行时置 NULL；激活行拒绝删除）、拒绝 bundled 与当前激活行。裸 SQL 绕过仍然禁止；AGENTS.md 的裸 SQL 禁令（原 :252）改写为「裸 SQL 绕过禁止；端点 purge 为唯一合法物理删除路径」两条（终态 :262），只写终态。

### D5｜本期四个资源，深水区显式排除

本期上：themes、announcements、pages、webhook endpoints。明确排除：items / books / TCM 条目（`tcm_parent_id` 父子链、`ext_marker_citations`、FTS 触发器）、devices 与 login credentials（安全吊销语义）、review records（审计留痕）、CLI `theme purge`（规格未要求，列为 follow-up）。无漏网的复核方法三条：migrations 中含 `deleted_at` 列的表只有 themes 与 webhook_endpoints；翻转到删除态的 status 写入点全数枚举；已是物理删除的表（categories / site_files / roles / api_keys 等）无需补。

### D6｜删除对话框二选一 + 输入确认

统一共享对话框 `PurgeConfirmDialog`：归档（软删除，现状行为）/ 永久删除（purge）。永久删除需输入记录标识（themes 为 `package@version`），强度与 `theme delete` 的 `--confirm` 一致。入口形态覆盖两种：行内删除按钮（themes / pages / webhooks）与 announcements 的行内状态按钮。不做回收站视图——软删除行已从列表过滤，重新显示是另一个功能。

### D7｜权限复用，不新增权限码

purge 端点与同资源的 manage 端点同门：themes = `CONTENT_SETTINGS_MANAGE`、announcements = `SYSTEM_ANNOUNCEMENT_MANAGE`、pages = `CONTENT_PAGE_MANAGE`、webhooks = `SYSTEM_WEBHOOK_MANAGE`（经 `withWebhookGuard`）。物理删除是同一动作的加强，单独授权等真有人要分级再立。

## 考虑过的备选

| 备选 | 结论 |
|---|---|
| 回收站视图 + 从回收站 purge | 软删除行已从列表过滤，重新显示是独立功能；本 ADR 只允许对可见行 purge + 批量清理带走墓碑 |
| 抽共享 store helper（守卫 → 删行 → 清派生 的形状已有四份） | 判定为过早抽象：四个资源的派生清理完全不同（R2 引用计数、theme_state、page_paths、webhook 级联），现在只有 UI 对话框一个真实共享点 |
| CLI `theme purge` | 规格未要求，follow-up |
| 批量清理也用软删除 | 墓碑与 live 非 keep 行都还占着重装位，清理不完整（D3） |

## 后果

- 正面：清理后真正释放 `UNIQUE(package_id, version)`，旧版本可回滚重装；删除语义在 UI 上一目了然（归档可逆 / 永久删除不可逆）。
- 负面与处置：purge 不可恢复——输入确认 + destructive 样式 + 对话框内明示代价；webhook 存在两份删除域清单（端点级联 vs cron 保留期），ADR 要求改一处必须对另一处对账，且 purge 用「独占引用」事件删法，保留期内的无投递 explorer 事件归 cron，两边不重叠误删。
- 文档：AGENTS.md 裸 SQL 禁令改写为端点 purge 唯一合法路径（工单 04，已获用户签字；终态 :262）；CONTEXT.md「管理后台的删除语义」词汇节随本方案先行写入。

## 实现状态（2026-10-15）

工单 01–08 全部完成。分工：01 本 ADR；02 themes 单行 purge 端到端（含共享对话框）；03 批量清理 `purgeOldVersions`；04 AGENTS.md 改写；05–07 announcements / pages / webhooks 同款；08 全量门禁与本地实例验收。实跑验收见 `.scratch/purge-delete/acceptance-2026-10-15.md`：门禁全过；本地实例 dryRun 清出 15 行墓碑后正式 purge，keep 集两行完好，同版本重装成功（`UNIQUE(package_id, version)` 重装位确认释放）。

## 局限

- purge 成功但 R2 资产删除失败时，行已删、`asset_cleanup_error` 账目列随行消失，孤儿对象只能靠错误消息暴露；已知接受（软删除路径的账目机制对已删除行无效是既有事实）。
- 墓碑行不可见，逐行 purge 按钮只能对 live 行使用；墓碑的清除只经批量清理入口。
- 深水区实体（items / books / TCM 条目 / devices / credentials / review records）本期没有物理删除，需要各自的级联设计后单独立项。
