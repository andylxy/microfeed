# ADR-0056: 限流与一次性台账合并入 ext_rate_limit

- 状态：Accepted（实施于 2026-11-02：迁移 `0166_schema_rate_limit_consolidation` + `src/server/rate-limit/` 三个原语 + 八个调用点改写）
- 日期：2026-11-02
- 关联：ADR-0048（App 读配额）、ADR-0049（写额度）、ADR-0055（上一次「并入上游表」的合并先例）、`CONTEXT.md`（限流与一次性台账）

## 背景

「一段时间内的请求记账」这件事，仓库里有五张自持表和一张上游表在分别表达：

| 表 | 形态 | 键 | 时间列 | 窗口 | 清理方式 |
| --- | --- | --- | --- | --- | --- |
| `ext_auth_throttle`（0059） | 计数器 | `key` PK | `window_start`（秒） | 60s / 24h / 60s 三种 | 无 |
| `ext_app_request_quota`（0147） | 计数器 | `credential_id` PK | `reset_at_ms`（毫秒） | 24h | 无 |
| `ext_login_credential_attempts`（0037） | 计数器 | `key` PK | `reset_at_ms`（毫秒） | 60s | 登录成功即删行 |
| `ext_replay_nonces`（0030） | 一次性台账 | `nonce` PK | `exp_at`（ISO 字符串） | 5 分钟 | 1% 采样删 |
| `ext_captcha_nonce`（0156） | 一次性台账 | `req_no_hash` PK | `used_at_ms`（毫秒） | 24h 保留 | 写入路径删 |
| `auth_rate_limit`（0002） | 计数器 | `id` PK + `key` UNIQUE | `lastRequest`（毫秒） | 60s | better-auth 自删 |

带来的成本与缺陷：

- **三套时间单位**（秒 / 毫秒 / ISO 字符串）、**三套清理策略**（采样删、逐次删、不删）。`ext_auth_throttle` 那张表里同时住着三种窗口（登录端点 5/60s、绑定配额 10/24h、验证码 IP 20/60s），靠键名前缀区分；前缀写错不报错，只会静默多出一行，让那个分类的计数被绕过。
- **一处分类口径冲突**：`ext_app_request_quota` 在快照登记里算 `durable`（`manage-cli/lib/snapshot.ts`），在 d1-sync 里算 `RUNTIME_DRIFT`（`docs/agents/d1-sync.md`）——同一种运行态计数，两处说法相反。
- `ext_captcha_nonce` 在 `tests/` 里零引用，没有覆盖。

## 决策

1. **新建 `ext_rate_limit`，五张自持表全部退役。** 复合主键 `(kind, key)`，列 `count` 与 `expires_at_ms`。`kind` 进主键：分类隔离由 schema 保证，不再依赖键名前缀约定。
2. **合并的依据只有一条不变量：一行在 `expires_at_ms` 之后无意义。** 计数器把它当窗口终点，翻转时原地把 `count` 重置为 1；一次性台账 `count` 恒为 1，把它当保留终点。两条都成立，所以清理只剩一条 `DELETE ... WHERE expires_at_ms < ?`，三套清理策略收敛成一套（写入路径 1% 采样，采样率与 `replay.ts` 原实现一致）。
3. **不并入 `auth_rate_limit`。** better-auth 的 database storage 在窗口翻转分支里执行 `DELETE FROM auth_rate_limit WHERE lastRequest < now - 60s`（`node_modules/better-auth/dist/api/rate-limiter/index.mjs:169-179`，cutoff 取 `max(rateLimit.window, 默认规则窗口)`），这条 DELETE 不带键前缀过滤。24h 配额行与 5 分钟 nonce 行放进去，会在空闲 60 秒后被删：配额退化成「10,000 次 / 分钟空闲」，防重放退化成「61 秒后可重放」。唯一的绕法是把 `lastRequest` 存成过期时刻（反转该列语义），而 better-auth 还拿这一列算 `Retry-After`；上游一旦改清理条件，四个限流点会同时静默失效。`auth_rate_limit` 保持原样，只服务 `/api/auth/*`。
4. **一次性台账与计数器同表。** 两者只差「窗口翻转时重置」与「插入即消费」，`count` 列与 `expires_at_ms` 列足以同时表达；分开的好处是语义更纯，代价是多一张表与两套清理。
5. **原语收敛到 `src/server/rate-limit/`。** `kinds.ts` 是七个分类与窗口参数的唯一真相来源（auth-throttle / app-quota / bind-quota / login-failure / email-otp-ip 五个计数器，replay-nonce / captcha-nonce 两个台账）；`window.ts` 是固定窗口算术；`once.ts` 是插入即消费；`prune.ts` 是清理。`login-throttle.ts` 与 `captcha-nonce.ts` 删除——它们只有存储、没有别的职责。`auth-endpoint-throttle.ts`、`app-quota.ts`、`replay.ts` 保留为 HTTP 与策略层（路径白名单、Cache 标记与 429 信封、请求头解析），计数与去重改为调原语。
6. **快照登记归 `ephemeral`，五张旧表从清单移除。** 整表都是运行态；这条同时修掉决策背景里那处 `durable` / `RUNTIME_DRIFT` 的冲突。`SNAPSHOT_TABLES.ephemeral` 不是「登记清单」而是「恢复时要清空的表」——`buildRestoreFinalizationSql` 会给每个条目生成 `DELETE FROM`，登记一张已 DROP 的表会让恢复直接 `no such table`。分类器只要求「库里存在的表都登记过」，不要求登记的条目都还在，所以移除是安全的；代价是尚未应用 0166 的库建快照会被 fail-fast 拒绝，报错直接提示补登记。
7. **一次性切换（不双写、不双读）。** 这些行都是运行态，切换后第一个窗口内计数从 0 起算、台账从空起算，不需要回灌历史行。

## 范围之外

- `ext_email_otp` 不并入：它带 `(email, purpose)` 复合语义与「只认最新未过期行」的规则，离限流更远。
- `auth_rate_limit` 不删、不改结构，better-auth 的 `rateLimit` 配置一行不动（红线文件 `src/server/auth/better-auth.ts`）。
- 快照与 d1-sync 的表清单改为从 `sqlite_master` 派生，本轮不做。触发条件：`ext_rate_limit` 稳定一版之后、且再有第二张新表要登记时。

## 后果

- 表少四张（五张旧表删、一张新表建），模块少两个（`login-throttle.ts`、`captcha-nonce.ts`），窗口 UPSERT 从三份（`auth-endpoint-throttle` 的 SELECT + INSERT + UPDATE、`login-throttle` 的 SELECT + UPSERT + DELETE、`app-quota` 的 SELECT + UPSERT）收敛成一份。
- 顺带修掉三处缺陷：`ext_auth_throttle` 里三种窗口共表、`ext_app_request_quota` 的快照归类与 d1-sync 相反、`ext_captcha_nonce` 零测试覆盖（新增 `tests/worker/rate-limit.test.ts`）。
- **部署不可回滚。** 0166 应用后，回滚到旧版 Worker 的代码会查询已删除的表：登录、App 内容端点与防重放全部 `no such table` 500。迁移先于 deploy 执行是 `deploySupport` 的既有约定；本迁移使「只回滚代码、保留迁移」不再可行，回滚必须重建五张表并回灌未过期行。
- 时间单位统一为毫秒；`ext_rate_limit_expires_idx` 一条索引同时服务清理与「取最早过期行」。
- **实测代价（2026-11-02，Miniflare D1 沙箱，19,950 行 / 7 个 kind / 半数已过期）**：`kind + key` 点查与按键删除各 **1** 行读；UPSERT 已存在键 **2 读 1 写**，新键 **1 读 3 写**（行 + 主键索引 + 过期索引）；50 键批量读 **99** 行读（≈2/键）；清理 9,975 行过期数据读 **9,976** 行——按过期行数增长，不随表大小增长。对照：漏掉 `kind` 的同一条读退化为裸 `SCAN ext_rate_limit`，所以五条语句都必须带 `kind`（原语把 `kind` 做成必填参数，调用方无从省略）。
- 计数器表的行数上界由「不同键数」变成「不同键数，且过期行会被采样清理」——旧实现里 `login-throttle.ts` 头部注释承认的「一次性键永不消失」不再成立。

## 被否决的替代方案

- **合进 `auth_rate_limit`（用户最初的想法）。** 零新表，但要与 better-auth 的全局清理抢同一张表，只能靠反转 `lastRequest` 语义硬扛；上游改一行清理条件就会静默破坏四个限流点，而 `better-auth.ts` 是仓库明令不碰的红线文件。
- **给 better-auth 配 `rateLimit.customStorage`，连 `auth_rate_limit` 一起删。** 这是「真正一张表」的唯一干净实现（`customStorage` 会收到 `consume(key, rule)`，我们自己实现原子 UPSERT），代价是要改 `better-auth.ts` 的 `rateLimit` 块并自己复刻路径规则解析——ADR-0008 与 ADR-0055 都回避过这个文件，为省一张表不值得。
- **只换表名、不收敛模块。** 表少了，认知负担不变：五个文件各写一套窗口 SQL，读代码仍要跳五处。
- **保留五张表不动。** 三套时间单位、三套清理、一处分类冲突会长期存在；而合并的风险集中在一次可验证的迁移里。
