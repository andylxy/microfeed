# ADR-0050: App 登录方式配置（settings JSON + caches.default 2h read-through）

- 状态：Accepted（随工单 01–05 分步实施；测试只写不跑，验证由用户手动触发门禁）
- 日期：2026-10-25
- 关联：ADR-0048（App 读缓存桶）、ADR-0049（缓存清理与写预算）、ADR-0011（登录限流）、ADR-0038/0041/0042（权限树与菜单）；设计全文与量化数字见 `.scratch/login-management/方案.md`（v3），票据在 `.scratch/login-management/issues/`

## 背景

后台运营需要一个页面控制 App 登录页展示哪些登录方式（账号密码 / 短信 / 微信 / QQ）与图形验证码是否强制。现状：`appLogin`（`src/server/tcm/app-auth.ts`）恒定要求验证码、恒定受理账号密码；短信 / 微信 / QQ 无后端（预留）。可控面有两个：前端入口显隐（App 渲染）与后端受理（硬门）。

## 决策

### D1｜存储 = settings 表单行 JSON（category=`app_login_methods`）

复用 0001 已建的 `settings` 表，零建表迁移；category 17 字符在 `VARCHAR(20)` 内，登记进 `SETTINGS_CATEGORIES`。定 JSON 的理由：登录方式是开放集，定型列加一种 = 一次 `ALTER` 迁移，JSON 加一个键 = 零迁移；单行整读整写、无按列查询，定型列无收益。读写通道收在 `FeedDb.getSettingsCategory` / `setSettingsCategory` 一处。

### D2｜缺行 / 块值兜底 = DEFAULT（账号密码开、验证码开、其余关）

未配置实例的行为与今天完全一致（要验证码、受理账号密码）——兜底方向与「未配置实例静默不验码」的安全回退相反。字段级归一：显式 true/false 之外（缺失、坏类型）补默认；整行坏 JSON 由 `getSettingsCategory` 归 null 后走整行默认。与 contentReview 的 fail-open 方向互不影响。

### D3｜缓存 = caches.default 单键 2h read-through + 保存本地 delete

- 读：`readLoginMethodsConfigCached` 走通用 `cachedJson`（`app-cache.ts`），键 `/app/login-methods`，TTL 7200s。`appLogin` 与 `getLoginMethods` 共用同一副本；常态 0 D1 行读，回源上限 = 86400/7200 = 12 次/日/机房 × P=3 ≈ ≤36 行读/日（0.0007% 日额度）。
- 写：`saveLoginMethodsConfig` 在 D1 upsert 后 `deleteCachedJson` 清键——保存机房下次请求即新值，其余机房 ≤2h 自然过期。**跨机房生效窗口 ≤2h 是已接受的取舍**（运营改登录方式的频率远低于 2h；窗口内两个方向：开验证码在其他机房延迟生效 ≤2h；App 拉配置与提交登录落不同机房时，显示旧值 + 判定新值的一侧可能让用户遇到「要求验证码但无输入行」，最长 2h，反向无害）。
- 不用 KV（项目零 KV 基础设施，引入需改 wrangler template + manage-cli 生成器，为每天几十行读不值得）；不用 `cache.purge`（2026-10 版 Cloudflare 文档：`caches.default` 与运行时 purge 分属两个独立存储，purge 清不到 `cache.put` 写入的条目）。
- enforcement（`appLogin`）与显示（`getLoginMethods`）走同一缓存而非分级：安全判定与显示读同一份值，同一机房内两者不可能互相矛盾。

### D4｜验证码信号源划分

`getLoginMethods` 响应含 `captchaEnabled`，是登录页全部显隐（四个方式 + 验证码行）的唯一信号源；`getPicCaptcha` 保持零改动、零 D1 读（无状态发码，`IsCode` 恒 true 维持旧后端形状与 golden 测试），显隐与受理都不在它身上——关码时 App 不调用，被直接调用也只是发一张不会被校验的码图，无害。

### D5｜允许全部关闭

不加「至少留一种」守卫；全关时 App 登录页显示「登录暂未开放」空态，不阻断 App 其他功能。账号密码关闭 = 该方式整体下线，爆破面随之消失；`/login` 的 5 次/60s/IP 限流（ADR-0011）与验证码开关正交，关闭验证码不解除限流。

### D7｜登录功能总闸（loginEnabled）

开关矩阵含一个总闸 `loginEnabled`（默认 true，缺行兜底 = 登录可用，与 D2 方向一致）。关闭时：

- `appLogin` 的配置读取提到函数最前，总闸判定先于**一切**检查——不看请求体、不验码、不查用户，直接返回「登录功能开发中,敬请期待」；`getPicCaptcha` 保持零改动（关登录后 App 不进登录页不会拉码，被直接调用也只是发一张不会被校验的图，无害）。
- App「我的 → 登录」入口先调 `getLoginMethods`：`loginEnabled=true` 才进登录页，否则 toast「登录功能开发中，敬请期待」；拉取失败按显示侧 fail-open 放行（硬门在服务端）。进页后总闸再被关掉的兜底：`LoginActivity` 收到 `loginEnabled=false` 直接退出登录页并 toast 同款文案。
- 后台开关矩阵第一行即总闸（可操作，非预留）。

### D6｜登记与菜单

- 端点登记：`getLoginMethods` 同时进 `APP_BOOK_REQUEST_ROUTES`（归一化表，缺它 `api-permissions.test.ts` 与 ENDPOINT-004/005 失败）与 `APP_BOOK_REQUEST_ANONYMOUS_ROUTES`（匿名登记 = 后台 App 接口清单的数据源，先例 `getAboutInfo`）。
- 后台页面挂已有 `group_operations`（0089/0127 所建，不新建组）；节点 sort / `ext_menu` sort 取探针实测的组内下一空位（2026-10-25 本地库实测 609 / 607，`.scratch/login-management/probe-menu-operations.stdout.txt`）；权限码三镜像照 0145 模式（`permissionId()` 公式 id、INSERT OR IGNORE、rollback 块、不写 `ext_role_permissions`）。

## App 对接契约（AndroidProject-old）

- 进登录页时调一次 `GET /api/AppBookRequest/getLoginMethods`（匿名、无限流），按响应渲染：
  ```json
  { "accountPasswordEnabled": true, "smsEnabled": false, "wechatEnabled": false,
    "qqEnabled": false, "captchaEnabled": true, "updatedAtMs": 0 }
  ```
  外层为 App 通道标准信封 `{code, data, msg}`；`updatedAtMs` 仅作观测。
- `accountPasswordEnabled=false`：隐藏账号密码入口；`captchaEnabled=false`：隐藏验证码行且不调 `getPicCaptcha`；短信 / 微信 / QQ 开关只控显隐（后端未接通，开了也登不进去，后台界面标注「预留·未接通」）。
- 五项全 false：登录页渲染「登录暂未开放」空态，不阻断 App 其他功能。
- 不做客户端 TTL 轮询、不强制本地缓存；每次进登录页拉一次即可。
- 关闭的登录方式提交登录时，服务端返回旧后端风格的失败文案「该登录方式已停用」。

## 后续可选

- 完整 diff 审计表（`ext_app_login_audit`）：`updatedBy` + `updatedAtMs` 已答「谁何时改」，审计表 +1 迁移留作后续。
- captcha 关闭不留痕：不加日志。
