# 12 — App 登录（复用现有鉴权，不移植 AccessKey 体系）

**What to build:** App 能用账号口令登录并拿到可用的凭证，之后的请求能通过鉴权。

⚠️ 旧后端是"登录下发 `AccessKeyId/AccessKeySecret` → 每请求 HMAC 五段签名 + nonce 防重放"的**第三方开放接口**体系。**本项目已有等价能力，按用户拍板直接复用、不照抄**：

- 口令校验复用本项目的账号体系（better-auth）
- 凭证**签发现有 API Key 机制**（Bearer 形式，已有 scopes 与归属），App 带 `Authorization: Bearer <key>` 访问
- **防重放复用现成的 nonce 表**（迁移 0030 已在用），零 schema 变更
- **不做** HMAC 五段签名——除非后续确认有第三方接入需求
- 刷新令牌复用现有会话体系
- **不新建任何表**；不动现有 API Key 的数据结构

**Blocked by:** None — can start immediately

**Status:** done（2026-09-28，worker 测试 9 例 + dev server 实测）

- [x] 源端登录入参已读清：`LoginInfo{UserName, Password, VerificationCode?, Uuid?, TenantId?, Device?}`
- [x] 登录端点：better-auth 校验（邮箱或用户名，按是否含 `@` 分派查 `auth_user`）→ 签发 `content:read` API Key，返回 `{Token, Account, Name, Img, UserName, DefaultModule, ModuleList}`（**无 ak/sk 对**，Token 承载 Bearer 钥匙）
- [x] Bearer 凭证可过现有鉴权（`apiKeyScopes` 验证 scope 含 `content:read`，单测断言）
- [x] 刷新令牌端点可用：API Key 无过期语义 ⇒ replaceToken 校验 Bearer 后**保形返回当前凭证**（不轮换，实现注释已说明）
- [x] 失败各有清晰文案（沿用旧后端字符串形状，HTTP 200）：空入参「请检查账号密码」/ 账号或口令错误「登录失败,请检查账号密码」（不区分两者，防账号枚举）/ 无 Bearer「请先登录」/ 无效凭证「凭证无效或已过期」
- [x] 登录路径已加入 `THROTTLED_AUTH_PATHS`（与后台登录同一限流窗口，`ext_auth_throttle`）
- [x] 单测：用户名登录签发 / 邮箱登录 / 错误口令 / 未知账号 / 缺字段 / replaceToken 三态
- [x] dev server 实测：错误口令 → 200+`"登录失败,请检查账号密码"`；无凭证 replaceToken → `"请先登录"`
