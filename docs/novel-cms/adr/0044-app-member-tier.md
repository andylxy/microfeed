# ADR-0044: App 会员档位——角色会员标记、四端点内容门与缓存分桶

- 状态：Accepted（已实施；迁移 0144 与代码在工作树，待用户提交）
- 日期：2026-10-22
- 决策人：用户 + 代码评审（2026-10-22 双轴评审后修订：注释与视频恢复照发、缓存键加白名单、失败不进缓存）
- 关联设计：ADR-0040（角色级后台登录开关，本 ADR 复用其端点与弹窗形态）、ADR-0043（读路径扫描修复，本 ADR 的查询走索引口径同源）、迁移 0142/0143（书籍状态字典，「会员」状态行 `code=10`）；消费端约定：AndroidProject-old `docs/architecture/adr/0006-nav-snapshot-refresh.md`（`getNav` 当权威全量快照，空响应与失败都保留旧快照）

## 背景

书籍状态字典（迁移 0142/0143）已有「会员」行（`code=10`，`public_visible=0`），2026-10-22 本地快照 `channels` 12 行 = 8 本「显示」(1) + 4 本「会员」(10)（含容器频道，导航按 `tcmContainer` 过滤）。需要一套口径决定这些书在 App 里对谁可见。评审同时确认三个边界条件：

| 事实 | 数值 | 来源 |
| --- | --- | --- |
| 显示书 section 带注释 / 视频 | 6,819 条中 1,428 条带 `note`、5 条带 `sectionvideo` | 2026-10-22 本地快照 |
| 会员书 section 带注释 / 视频 | 1,247 条中 0 条 | 同上 |
| App 端已有登录凭证的账号 | 1 个（`test@qq.com`，editor 角色） | 本地 `ext_login_credentials` |

「注释与视频只随会员书下发」的中间版本会把 1,428 条显示书注释放空，而会员书当前一条注释都没有——净效果是全部用户（含会员读公开书）立刻失去注释与视频，且无任何规格来源要求此条。本 ADR 记录该条被回退后的最终口径。

## 决策

### D1｜角色会员标记，一趟查询带出

`ext_roles.is_member INTEGER NOT NULL DEFAULT 0`（迁移 0144）。鉴权时 `resolveUserAccess` 用一条查询同时取回权限码与会员标记（多角色取并集）：`JOIN ext_roles` + `LEFT JOIN ext_role_permissions` / `ext_permissions`，没有授权行的角色也参与会员并集。读代价（2026-10-22 本机快照 `EXPLAIN QUERY PLAN`）：四个访问点全走索引，无表扫描；返回行数 = 角色数 × 每角色授权数（本机 4 角色 / 62 条授权，几十行量级）。`resolveUserPermissions` 保留为只要权限码的旧入口。`locals.appMember` 只在 App 登录凭证鉴权路径设置；后台会话路径不设（取不到即公开档）。

### D2｜四端点档位门，注释与视频照发

档位 `AppNavTier = "member" | "public"`，由 `tierFromAppMember(appMember)` 单点推导（`true` → 会员档，其余含未登录 → 公开档），四个端点各自算一次。

| 端点 | 会员档 | 公开档 |
| --- | --- | --- |
| GetNav | 收录状态 1 与 10 | 只收录状态 1 |
| GetBookChapter | 正常返回章目录 | 会员书返回空目录 |
| GetChapterContent | 正常返回条文 | 会员书返回空 |
| GetBookIdFang | 正常返回方剂 | 会员书返回空 |

会员书在 App 目录里对会员可见，点开后再由 App 侧做会员校验；它不进公开站（`ext_book_status.public_visible=0`）。「隐藏」(2) 与「已删除」(3) 任何档位都不收录。条文正文、注释（`note`）与视频讲解（`sectionvideo`）一律照发原始值，不随档位或书状态变化——注释与视频的搬迁单独立项，不搭本 ADR 的车。

读代价：`getAppNav` 的 `status IN (1,10)` 即两次索引 seek，`ORDER BY` 走临时 B 树、行数是收录书目数（2026-10-22 实测 12 行 channels）；会员门多出的 `channels` 主键查与 `LEFT JOIN` 取回书状态都不增加往返（同一条语句内）。

### D3｜缓存分桶与键卫生

- 目录缓存名 `nav-v3`（收录范围变了必须换键：24h 共享缓存不随部署失效，旧键自然过期、无需清理）；章节目录缓存名 `book-chapters`，键后缀 `<bookId>:<tier>`。两处写与清共用 `appCacheKey` / `bookChaptersKeySuffix` 一处拼法。
- bookId 是查询参数，进缓存键前过白名单 `[A-Za-z0-9_-]{1,64}`（本机 channel id 为 11 位字母数字）：含 `/` `\` `?` `#` `:` 的一律 400。URL 归一化会把 `a/../b` 改写成的写法与 `b` 相同，放行即允许用一个键换掉另一本书的缓存条目。
- 键后缀不做百分号编码：档位与 bookId 都不需要，编码后键既难读也没法跟测试里按字面量拼的键一致。
- 书变更（含状态在「显示」与「会员」之间切换）调 `purgeAppBookCache` 清四只键：目录两桶 + 该书章节表两桶。公开桶里旧的会员书条目必须立刻消失，否则非会员最多还能看 24h。
- 角色会员标记变更不碰缓存：键只含档位不含身份，鉴权时重算档位，下一次请求即走对的桶。

### D4｜失败不进缓存

走共享缓存的 `getAppNav` / `getAppBookChapters` 改用 `withRethrow`：D1 读取失败留痕后抛出，由 Astro 管线转成 500 回给 App（App 按 ADR-0006 的失败路径保留旧快照）。`withEmpty` 的降级空值保留给不走缓存的读函数——空值被 `cachedAppResponse` 当成成功响应写进 24h 缓存，一次瞬时故障会让整只桶持续吐空。

### D5｜后台开关与审计

- 端点 `POST /ajax/rbac/role-member`（`updateAdminRbacRoleMember`）：与其他角色改动同一道门（`system:role:manage`），只认布尔体（字符串 `"false"` 是真值，放过会把「非会员」静默存成会员），未知角色 404，返回 PC 板子供前端整表刷新。
- 角色管理弹窗（`RoleManagerDialog`）在「登录后台」开关下方加「会员」开关，`aria-label` 与文案走 i18n（`rbac.member` / `memberEnabled` / `memberDisabled` / `memberHint`），禁用态用原生 `disabled`。
- 审计动作 `role.member` 登记进 `RBAC_AUDIT_ACTIONS` 与双语文案。
- `setRbacRoleMember` 对 `super_admin` 不锁定：会员标记没有一个必须固定的取值（与 `role-login` 锁定 `super_admin` 为允许的理由不同——那里有一条「超级管理员必须能进后台」的不变量）。
- `createRbacRole` 的 INSERT 显式写 `allow_admin_login=0, is_member=0`：列默认值 1 是 0132 给种子角色留的，不在表上改（SQLite 改列默认值要重建表，牵连两张子表）；种子角色不受影响。

## 后果

- 会员可见性由角色标记单点决定，App 四端点与后台开关同一口径；角色变更下一次请求生效，不被 24h 缓存挡。
- 负面 / 风险：① 会员书当前无注释与视频，会员档的「增值内容」为空，等数据搬迁（见 D2，单独立项）；② 档位门让公开档对会员书返回空数组而非 403，App 需要把空目录当「无此书」处理（ADR-0006 的快照语义兼容）；③ 缓存键白名单把非常规 id 的请求挡在 400，真实 id 生成规则若引入白名单外字符需同步放宽。

## 验证

- 单测（只写不跑，门禁由用户手动触发）：`tests/worker/tcm-app-reads.test.ts` 锁四端点档位门与注释照发；`tests/worker/app-public-cache.test.ts` 锁分桶键、非法 bookId 400、失败不进缓存、清桶；`tests/worker/rbac.test.ts` 锁端点守卫 / 非布尔体 400 / 未知角色 404 / 新角色两个默认值；`tests/unit/components/rbac-role-manager.test.ts` 锁开关文案与禁用态。
- 联调（2026-10-22，本地 dev + 模拟器）：公开档只见 8 本显示书；会员档 12 本；公开档点会员书三端点全空；会员档正常；缓存分桶不串味；书状态切换后清桶立即生效。
