# ADR-0044: App 会员档位——角色会员标记、四端点内容门与缓存分桶

- 状态：Accepted（已实施：迁移 0144 角色会员标记、四端点内容门、分类清桶与角色布尔并集口径）
- 日期：2026-10-22（内容门与分类清桶 2026-10-23）
- 决策人：用户 + 代码评审（缓存键白名单、失败不进缓存为既定设计）
- 关联设计：ADR-0040（角色级后台登录开关，本 ADR 复用其端点与弹窗形态）、ADR-0043（读路径扫描修复，本 ADR 的查询走索引口径同源）、迁移 0142/0143（书籍状态字典，「会员」状态行 `code=10`）；消费端约定：AndroidProject-old `docs/architecture/adr/0006-nav-snapshot-refresh.md`（`getNav` 当权威全量快照，空响应与失败都保留旧快照）

## 背景

书籍状态字典（迁移 0142/0143）已有「会员」行（`code=10`，`public_visible=0`），2026-10-22 本地快照 `channels` 12 行 = 8 本「显示」(1) + 4 本「会员」(10)（含容器频道，导航按 `tcmContainer` 过滤）。需要一套口径决定这些书在 App 里对谁可见。三个边界条件：

| 事实 | 数值 | 来源 |
| --- | --- | --- |
| 显示书 section 带注释 / 视频 | 6,819 条中 1,428 条带 `note`、5 条带 `sectionvideo` | 2026-10-22 本地快照 |
| 会员书 section 带注释 / 视频 | 1,247 条中 0 条 | 同上 |
| App 端已有登录凭证的账号 | 1 个（`test@qq.com`，editor 角色） | 本地 `ext_login_credentials` |

附注与视频讲解按调用方会员档下发：现存 1,428 条附注全在显示书上（见上表），按会员档下发使其立即成为会员权益，门控本身无需先搬迁数据。会员书当前 0 条附注 / 视频；若日后要给会员书补附注 / 视频（数据搬迁），属另一独立事项，不搭本 ADR。

## 决策

### D1｜角色会员标记，一趟查询带出

`ext_roles.is_member INTEGER NOT NULL DEFAULT 0`（迁移 0144）。会员判定只认这个**每角色布尔列**，与角色叫什么名字无关（不存在任何「名叫 member 的角色」的特判，也不由迁移种这种角色）；账号持多个角色时取并集——任一角色 `is_member=1` 即会员。鉴权时 `resolveUserAccess` 用一条查询同时取回权限码与会员标记：`JOIN ext_roles` + `LEFT JOIN ext_role_permissions` / `ext_permissions`，没有授权行的角色也参与会员并集。读代价（2026-10-22 本机快照 `EXPLAIN QUERY PLAN`）：四个访问点全走索引，无表扫描；返回行数 = 角色数 × 每角色授权数（本机 4 角色 / 62 条授权，几十行量级）。`resolveUserPermissions` 保留为只要权限码的旧入口。`locals.appMember` 只在 App 登录凭证鉴权路径设置；后台会话路径不设（取不到即公开档）。

### D2｜四端点档位门，附注与视频讲解按会员档下发

档位 `AppNavTier = "member" | "public"`，由 `tierFromAppMember(appMember)` 单点推导（`true` → 会员档，其余含未登录 → 公开档），四个端点各自算一次。

| 端点 | 会员档 | 公开档 |
| --- | --- | --- |
| GetNav | 收录状态 1 与 10 | 只收录状态 1 |
| GetBookChapter | 正常返回章目录 | 会员书返回空目录 |
| GetChapterContent | 正常返回条文，附注 / 视频讲解照发原始值 | 会员书返回空；显示书附注 / 视频讲解置空 |
| GetBookIdFang | 正常返回方剂 | 会员书返回空 |

会员书在 App 目录里对会员可见，点开后再由 App 侧做会员校验；它不进公开站（`ext_book_status.public_visible=0`）。「隐藏」(2) 与「已删除」(3) 任何档位都不收录。两层门判定维度不同：**访问门按书本状态**（会员书只对会员档放行，公开档请求返回空数组），**内容门按调用方会员档**——附注（`note`）与视频讲解（`sectionvideo`）是 App 端会员权益，会员档照发原始值，公开档置空（`null`，与「没有附注」的表示一致）；条文正文一律照发。内容门不看书状态，非 TCM 章节（无 `book_id`）同样适用。

读代价：`getAppNav` 的 `status IN (1,10)` 即两次索引 seek，`ORDER BY` 走临时 B 树、行数是收录书目数（2026-10-22 实测 12 行 channels）；会员门多出的 `channels` 主键查与 `LEFT JOIN` 取回书状态都不增加往返（同一条语句内）。

### D3｜缓存分桶与键卫生

- 目录缓存名 `nav-v3`（收录范围变了必须换键：24h 共享缓存不随部署失效，旧键自然过期、无需清理）；章节目录缓存名 `book-chapters`，键后缀 `<bookId>:<tier>`。两处写与清共用 `appCacheKey` / `bookChaptersKeySuffix` 一处拼法。
- bookId 是查询参数，进缓存键前过白名单 `[A-Za-z0-9_-]{1,64}`（本机 channel id 为 11 位字母数字）：含 `/` `\` `?` `#` `:` 的一律 400。URL 归一化会把 `a/../b` 改写成的写法与 `b` 相同，放行即允许用一个键换掉另一本书的缓存条目。
- 键后缀不做百分号编码：档位与 bookId 都不需要，编码后键既难读也没法跟测试里按字面量拼的键一致。
- 书变更（含状态在「显示」与「会员」之间切换）调 `purgeAppBookCache` 清四只键：目录两桶 + 该书章节表两桶。公开桶里旧的会员书条目必须立刻消失，否则非会员最多还能看 24h。调用点收在 `extBook.ts` 的四个写函数（建 / 改 / 软删 / 物理删），端点不再各自调用。
- 分类变更（改名 / 排序 / 删除）同样改目录的收录与顺序（删分类会把该分类下全部书的 `genre` 置空，书从目录消失）：调 `purgeAppNavCache` 清两只目录桶，不碰书章节表。调用点收在 `extCategory.ts` 的改 / 删 / 排序三个写函数。
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
- 附注与视频讲解只对会员档下发：非会员在显示书上不再收到它们。
- **App 本地缓存穿透**：App 按 `signatureId` 把章节正文存进 GreenDAO 且下载后永不重拉（`isDownload` 无置回路径，无下拉刷新 / 登录态变化 / 签名校验；源码 AndroidProject-old `ChapterContentManager` / `DataRepository`）——公开档缓存过的空附注版本，用户开通会员后不会自动刷新；内容门上线前已下载的版本也会继续带附注。服务端只保证新下载正确门控；彻底刷新需 App 发版支持会员变更时清章节缓存。同类穿透已存在于会员书访问门，接受，不阻塞服务端正确性。
- 负面 / 风险：① 档位门让公开档对会员书返回空数组而非 403，App 需要把空目录当「无此书」处理（ADR-0006 的快照语义兼容）；② 缓存键白名单把非常规 id 的请求挡在 400，真实 id 生成规则若引入白名单外字符需同步放宽；③ 会员书当前 0 条附注 / 视频，给会员书补附注 / 视频的数据搬迁是独立事项（门控本身不依赖它），需另立单项跟进。

## 验证

- 单测（只写不跑，门禁由用户手动触发）：`tests/worker/tcm-app-reads.test.ts` 锁四端点档位门与附注 / 视频的会员档内容门；`tests/worker/app-public-cache.test.ts` 锁分桶键、非法 bookId 400、失败不进缓存、清桶；`tests/worker/rbac.test.ts` 锁端点守卫 / 非布尔体 400 / 未知角色 404 / 新角色两个默认值；`tests/unit/components/rbac-role-manager.test.ts` 锁开关文案与禁用态。
- 联调（2026-10-22 / 10-23，本地 dev + 模拟器）：公开档只见显示书；会员档见显示 + 会员书；公开档点会员书三端点全空；附注 / 视频会员档照发、公开档置空；摘 / 恢复会员角色后 App 书架随之 12 → 8 → 12 本（`TAB_NAV_BODY` 实证，快照同步标志行确认每轮都重新拉取）；书状态切换后清桶立即生效。
