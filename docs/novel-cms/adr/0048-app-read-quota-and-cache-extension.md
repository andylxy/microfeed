# ADR-0048: App 读额度防护与缓存扩容（限流 / 章节方剂缓存 / webhook 索引）

- 状态：Accepted（限流随本 ADR 实施；缓存扩容与 webhook 索引随其工单实施；测试只写不跑，验证由用户手动触发门禁）
- 日期：2026-10-24
- 关联：ADR-0016（缓存取舍：「TTL 而非缓存本身」）、ADR-0044（App 会员档与缓存分桶——本 ADR 的 tier 桶语义沿用）、ADR-0043（D8 的「行数 >200 再建 webhook 端点索引」触发条件由本 ADR 提前消除）；参数与数字出处见 `.scratch/sec-hardening/SPEC.md`

## 背景

两个读额度事实与一个遗留扫描：

1. App 内容端点（`/api/AppBookRequest/` 内容路由）无速率限制，单把有效 `mflc_` 凭证可无限调用，直接消耗 D1 每日 5M 行读取额度；其中 `GetChapterContent` 与 `GetBookIdFang` 每请求直连 D1（其余四个端点已有 24h Worker 缓存）。
2. 限流若以「逐条记录被拒事件」实现，攻击者被拒 1 次即消耗 1 行写额度——100 请求/秒持续一天即烧光 100,000 日写额度。
3. webhook 端点清理路径仍 `SCAN webhook_endpoints`（ADR-0043 D8 记录为「行数 >200 再建索引」，当前表 0 行）。

## 决策

### D1｜F3：App 内容端点按凭证限流，拒绝路径零 D1 写

- 参数（唯一定义处 `src/server/rbac/app-quota.ts`）：每凭证固定窗口 **10,000 次 / 24h**；计数范围 = `/api/AppBookRequest/` 内容路由（middleware `isIntegrationApiPath` 门内），匿名端点与 `/api/v1` 不计数；合法重度读者（翻页 < 2,000 次/日）不受影响。
- 表 `ext_app_request_quota(credential_id PK, count, reset_at_ms)`（迁移 0147）：行数 = 活跃凭证数（上界 = 用户数 × 5），窗口翻转原地重置，无清理任务。计数形态沿用 `login-throttle.ts` 固定窗口先例。
- 判定链：① Cache API 标记 `quota-exhausted/<tokenHash>` 命中 → 429，零 D1（标记在首次达上限时写入、TTL 到 reset；`caches.default` 不跨数据中心复制，每 POP 首次触达各 1 行读后自持，攻击读代价 ≤ 2 × POP 数/凭证/日）；② SELECT 见已达上限 → 补标记 + 429（只读不写）；③ 未达上限 → 单条 `UPSERT ... RETURNING` 原子递增（1 读 + 1 写），并发顶过上限的那一次请求放行（边界请求）。
- **被拒请求不计数、不写库**——这是本设计的第一个约束，理由见背景第 2 条。写入上界：每凭证每日 ≤ 10,001 行写（100,000 日写的 10%）。
- middleware 挂载：标记检查在防重放与版本门**之前**（被拒流量零 D1，连 nonce 写都省掉）；计数消费在凭证有效且版本门通过**之后**（无效 token 不建行，表不被随机 token 灌垃圾行）。
- 429 响应：旧后端信封形状 `{code:429, data:null, msg}` + `Retry-After`。
- 可见性：凭证管理面板显示「今日 App 请求 N 次」与重置时刻（一次 IN 查询合并进既有凭证列表响应），不新建页面。

### D2｜F7：GetChapterContent 与 GetBookIdFang 接入 Worker 缓存分桶

- 缓存名 `chapter-content-v1`（键 `<chapterId>:<tier>`）与 `book-fang-v1`（键 `<bookId>:<tier>`）；id 过 `APP_BOOK_ID_PATTERN` 同款白名单后进键。
- tier 桶语义沿用 GetBookChapter（ADR-0044）：member 桶含 note/video 原值，public 桶置空；公开桶对会员书的空响应由书状态变更清桶覆盖。
- 失效分派（条目写路径按 tcm_kind）：`chapter` 清该章两桶；`section` 按 `tcm_parent_id` 清所属章两桶；`fang` 按 pocket `sourceBookId` 清该书方剂两桶。书**状态**变更（会员切换）时按 `items_book_kind` 索引一次查出该书全部章节 id 逐章清两桶并清方剂两桶；标题类变更维持既有 `purgeAppBookCache`。
- TTL 24h，与既有四个缓存端点同一已接受取舍（`app-cache.ts` 头注释：编辑路径显式清桶，陈旧上限 24h）。
- 收益算术（推得值，输入为实测）：改前 `GetChapterContent` 每请求 2 + 该章条文数、`GetBookIdFang` 每请求 1 + 本书方剂数（实测一书 113 行，`.scratch/d1-scan-fix/probe-facts19.stdout.txt:27-28`）；改后每（章|书）× tier × POP × 日未命中 1 次。App 日调用量按 `app-cache.ts` 口径约 400 次/日。
- `GetAllMingCi` 维持不入缓存（返回随调用者权限变化）。

### D3｜F8：webhook 端点 `deleted_at` 索引提前落地

- 迁移 `0149_index_webhook_endpoints_deleted_at.sql`：`ix_webhook_endpoints_deleted_at ON webhook_endpoints(deleted_at)`。
- 表当前 0 行（`.scratch/sec-hardening/probe-rowcounts-2026-10-24.stdout.txt`），空表建索引写额度消耗 0 行；**取代 ADR-0043 D8 的「行数 >200 再建」触发条件**——提前建在空表上消除了条件跟踪，清理语句自动受益，无需改查询。

## 后果

- 读额度攻击上界：单凭证每日内容端点调用从无限收敛到 10,000 次；两个高频端点的 D1 读从每请求直连收敛到每桶每 POP 每日 1 次未命中。
- 限流 429 不写审计行（与「被拒零写」一致；滥用证据就是计数行到 10,000 本身）。
- 新表 `ext_app_request_quota` 加入本地→远程同步核对范围（内容表口径，行数 = 凭证数）。

## 验证

- 测试只写不跑（仓库最高指令）：`tests/worker/app-request-quota.test.ts`（本 ADR D1）、`tests/worker/app-cache.test.ts`（D2 新建）、D3 用只读 EQP 探针（`.scratch/webhook-prune-plan/`）。全量验证由用户手动触发 `.microfeed-gate-subset`。
