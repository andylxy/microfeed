# ADR-0049: 缓存正确性与写预算收束批次（T01–T15）

- 状态：Accepted（随工单 01–15 分步实施；测试只写不跑，验证由用户手动触发门禁）
- 日期：2026-10-24
- 关联：ADR-0048（缓存桶语义——本 ADR 修正其错误处理缺口与清理缺口）、ADR-0016（缓存取舍）、ADR-0027（卷看板按需读取）；参数出处见 `.scratch/module-hardening/SPEC.md`

## 背景

2026-10-24 九模块深度分析确认四条正确性缺陷与一条写额度放大：

1. 进 24h 共享桶的四个读取函数（getAppChapterContent / getAppBookFang / getAppAllYao / getAppYaoAliases）仍用 `withEmpty` 把 D1 故障降级为空数组——一次抖动让整只桶吐空 24h（ADR-0048 扩容时只迁移了 GetNav/GetBookChapter 两处）。
2. zhongyao / yao-aliases 两桶没有清理路径（中药/别名板写端点不 purge）。
3. 评审批准 / 纠错定稿的写回不清任何缓存。
4. items/service 的 collect 模式下，缓存清理发生在数据批次提交之前（读到提交前状态）。
5. 已授权 App 请求每请求 5–6 行 D1 写（last_used UPDATE、设备 upsert、nonce 清理、配额、审计），满额凭证 ≈5 万行/日。

## 决策

### D1｜进桶读取一律 withRethrow

凡结果进 `cachedAppResponse` 24h 共享桶的读取函数，失败就地抛出（端点 5xx、不写桶、App 端保留旧快照重试）；`withEmpty` 仅保留给不进桶的读取（GetAllMingCi / 后台别名板）。改动位置：reads.ts 七个进桶函数（`getAppStyleConfig` 随样式目录进桶并入）。

### D2｜yao / 别名桶清理归属

`purgeAppYaoCache()` 删 zhongyao 与 yao-aliases 两键；挂接 tcm-entry（yao/term）写端点、alias 写端点、以及 FeedCrudManager 的 section 分派（经疏正文变更触发）。

### D3｜评审定稿写回清缓存

实施时核实的缺口比分析报告更窄：`ajax/review/index.ts` 与纠错路由**已有 CDN tag 清理**，真正缺的是 App 章节正文桶（CDN tag 不覆盖）与 tcm-entry `writeItemContent` 路径的 CDN 清理。改动：新模块 `writeback-cache.ts` 的 `purgeWritebackCaches(env, request, itemId)` 统一清 CDN `[PUBLIC, ITEMS, CHANNEL_PRIMARY, item(id)]` + App 章桶（chapter 直清、section 清 parent），三处写回（评审批准、纠错定稿、中药/术语重写）换用；reject 不推进公开内容，无需清。

### D4｜热路径写节流参数

- 凭证 last_used：条件更新，仅 `last_used_at_ms < now − 60s` 才写（≤1,440 写/日/凭证）；
- 设备心跳：upsert 加 `last_seen_at < now − 5min` 守卫（间隔内 0 写，revoked 语义保留）；
- 防重放过期清理：1% 采样发 DELETE，INSERT 与清理不合批。

效果：已授权请求常态写 5–6 行 → 2 行（配额 + 审计）；非安全方法（POST/PUT/PATCH/DELETE）另加 1 行 nonce INSERT，合计 3 行。nonce INSERT 未节流——去重要求每个非安全方法请求写一行，被节流的只有 1% 采样的过期行 DELETE。满额凭证（10,000 请求/日）日写 ≈5 万 → ≈2–3 万。

### D5｜collect 模式清缓存时序规则

**缓存清理必须发生在数据批次提交之后。** items/service 的 collect 路径由 service 层在 batch 成功后调用导出的分派入口；FeedCrudManager 不再在 putContent 返回后自动清（直接模式调用方 patchChapters 自带 post-batch 清理，无双清）。

## 后果

- 缓存正确性闭环：错误不再入桶；全部桶（nav/chapters/chapter-content/fang/zhongyao/yao-aliases）都有显式清理归属。
- 写预算：App 满额场景总写 ≤3.2 万行/日/凭证（配额、审计、nonce 各 1 万为上限，节流后设备与最近使用 1,728，1% 采样清理 ≤100），占 10 万日写额度的 32%。
- 语义变化：进桶端点在 D1 故障时返回 5xx（此前 200 + 空数组）——App 端按既有失败路径保留旧快照，属预期改进。

## 验证

- 测试只写不跑；断言位置：tcm-app-routes（5xx 不写桶）、app-cache（清桶）、login-credential（节流不写）、audit-handlers 假 D1（collect 时序）。全量验证由用户手动触发 `.microfeed-gate-subset`。
