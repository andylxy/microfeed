# ADR-0045: 删除三个零调用兼容端点（replaceToken / GetProjectInfo / GetLoginInfo）

- 状态：Accepted（已实施：删除 3 端点 + 路由登记 + app-auth 凭证分支 + 测试）
- 日期：2026-10-23
- 决策人：用户 + 代码评审
- 关联设计：ADR-0011（D1 读成本与 Token 凭证形态，本 ADR 沿用 `mflc_` 凭证、不移植 AccessKey/HMAC）、ADR-0009（移除 API 权限码，本 ADR 的端点同样走匿名清单而非权限码）；消费端约定：AndroidProject-old 仅调用 login / getPicCaptcha / getAboutInfo

## 背景

对齐审计结论：netcore 旧后端 `vol.api.sqlsugar` 在 `/api/AppBookRequest/` 下提供 6 个接口（GetProjectInfo / GetLoginInfo / getAboutInfo / login / replaceToken / getPicCaptcha）。microfeed 已全量对齐实现，但 App 端（AndroidProject-old）实际只调用其中 3 个：

| 端点 | App 是否调用 | 说明 |
| --- | --- | --- |
| login | 是 | 登录，失败仅 toast 不阻塞 |
| getPicCaptcha | 是（但失败仅 toast 不阻塞） | 本仓无验证码能力，恒返回空 |
| getAboutInfo | 是 | 关于页 4 槽位内容 |
| replaceToken | 否 | App 零引用 |
| GetProjectInfo | 否 | App 零引用 |
| GetLoginInfo | 否 | App 零引用 |

三个零调用端点都是「从 netcore 搬运时一并抄来的兼容层」：replaceToken（用旧 refresh token 换新登录 token）、GetProjectInfo（返回 app 项目信息）、GetLoginInfo（返回当前登录态概要）。它们的存在只增加攻击面与维护负担，无业务价值。

## 决策

### D1｜删除三个端点文件与路由登记

- 删除 `src/pages/api/AppBookRequest/replaceToken.ts`、`GetProjectInfo.ts`、`GetLoginInfo.ts`。
- 匿名清单 `APP_BOOK_REQUEST_ANONYMOUS_ROUTES`（`src/server/api/access.ts:98`）移除三端点，剩余 `login` / `getPicCaptcha` / `getAboutInfo` 三项——App 实际调用的恰好是这三项（见背景表）。
- `src/middleware.ts` 注释同步更新，去掉对三端点的提及。

### D2｜清理 app-auth 中的专属凭证分支

- `src/server/tcm/app-auth.ts` 删除 `appReplaceToken`（旧 refresh 换票逻辑）与 `findAuthUserById`，以及随之失效的 import（`verifyLoginCredentialToken` / `accountIsBlocked` / `isDeviceRevoked`）。
- `src/components/admin/rbac/RbacApp/index.tsx` 的 `ANON_CREDENTIAL_SUFFIXES` 去掉 `replaceToken`——匿名凭证后缀清单与匿名路由清单同源收敛。

### D3｜删测试与告警，避免悬空用例

- `tests/unit/api-permissions.test.ts`、`tests/worker/tcm-app-routes.test.ts`、`tests/worker/tcm-app-auth.test.ts` 移除三端点的相关用例，与代码删除同步，门禁不再对不存在的端点做断言。

## 后果

- App 端调用面从 6 端点收窄到 3 端点，与 AndroidProject-old 实际调用集完全重合——零引用删除不影响任何线上行为。
- 攻击面收窄：旧 refresh-token 换票路径（replaceToken）与两个 info 探测端点不再暴露。
- **无迁移**：纯代码层删除，不涉及数据库结构或存量数据。
- 风险 / 遗留：① 若将来 App 新版本开始调用 replaceToken（用旧 token 续期），需重新评估是否恢复——但 ADR-0011 已拍板 Token 承载 `mflc_` 凭证、走统一鉴权，续期应走既有登录态而非旧 refresh 协议，故不预留；② getPicCaptcha 虽被 App 调用但恒返回空、失败仅 toast，属已知的「握手占位」端点，本次不动。

## 验证

- 单测（定向跑绿，全量由用户手动触发）：`tcm-app-auth` / `tcm-app-routes` / `api-permissions` 不再引用三端点；`scripts/check-endpoint-registration.ts` 与匿名清单同源校验通过。
- 全量门禁（astro check / tsc / endpoints / i18n / migrations / layout / adr）全过。
- 联调：App 模拟器登录、关于页加载均正常（仅依赖剩余 3 端点）。
