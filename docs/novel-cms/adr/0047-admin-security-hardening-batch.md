# ADR-0047: 管理域安全加固批次（XSS 消毒 / 安全响应头 / key 哈希 / legacy 审计 / 登录时序）

- 状态：Accepted（随工单 01–06 分步实施；测试只写不跑，验证由用户手动触发门禁）
- 日期：2026-10-24
- 关联：ADR-0008（移除 API 签名调用路径，`api_keys.secret_hash` 的历史来源）、ADR-0011（`mflc_` 凭证形态，哈希查表模式来源）、ADR-0045（AppBookRequest 端点收敛）；参数与数字出处见 `.scratch/sec-hardening/SPEC.md`

## 背景

2026-10-24 全仓安全审查确认管理域五项弱点：

1. 审核记录页把编辑提交的富文本 `description`（`ext_content_review.proposed_data`）原样写入 `dangerouslySetInnerHTML`，无消毒——持 `content:chapter:create/update` 的编辑可对审核员执行任意脚本（存储型 XSS）。
2. 全仓无 CSP / X-Frame-Options / HSTS / 全局 nosniff，仅 4 处局部设置。
3. `mf_` API key 明文存储并明文比对（`api_keys.api_key` 列）；D1 数据面泄露即全部 key 可用。
4. legacy bearer 调用不写 `ext_api_access_log`（attribution 恒空），越权尝试无痕迹。
5. App 登录在账号不存在时跳过口令校验直接返回统一文案（时序可枚举账号），且不查封禁（封禁账号能换到有效凭证，靠后续逐请求 401 兜住）。

## 决策

### D1｜F1：审核记录读取时消毒（sanitize-html）

- `contentHtml` 唯一生产点在 `listReviewRecordsHandler`（`src/server/admin/audit-handlers.ts`），读取时经 `sanitize-html` 白名单消毒，组件照常渲染已消毒 HTML。
- 白名单（唯一定义处，SPEC D2）：标签 `p br h1-h6 ul ol li blockquote pre code em strong a img table thead tbody tr td th hr span div`；属性 `a: href/title/rel`、`img: src/alt/title`；`a` 经 `simpleTransform` 强制 `rel="noopener noreferrer"`（`rel` 必须同时在 `allowedAttributes` 内，否则 transform 加上后又被过滤器剥离——实现时实测确认）。
- 选服务端消毒而非浏览器端 DOMPurify：组件测试以 `renderToStaticMarkup` 在 Node 运行，浏览器端方案在该环境不可执行；服务端消毒使 Workers 与 Node 测试行为一致。新增运行依赖 `sanitize-html`（纯 JS，Workers 兼容）与 `@types/sanitize-html`。

### D2｜F2：中间件出口统一附加安全响应头

- middleware 改包裹式：现主体收进内部函数，导出层对任意出口响应（含 308/404/426/429 早退）应用安全头。
- 取值（唯一定义处，SPEC D3）：全部响应 `X-Content-Type-Options: nosniff`（已存在跳过）、`Referrer-Policy: strict-origin-when-cross-origin`、`X-Frame-Options: SAMEORIGIN`（主题预览为同源 iframe 用法，故取 SAMEORIGIN 而非 DENY）、`Strict-Transport-Security: max-age=31536000`（仅 https）；admin 路径追加 CSP `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'`。`'unsafe-inline'` 依据：语言脚本与后台壳为内联 `<script>`。
- 已自带 CSP 的响应（主题预览）跳过 CSP 追加、仅补其余头。`public/` 静态资产经 ASSETS 直出不经过 middleware，不在覆盖范围。

### D3｜F4：`mf_` API key 改哈希存储，删除明文列

- 迁移为建表重造（`api_key` 在 0006 建表带内联 `NOT NULL UNIQUE`，隐式自动索引删不掉，SQLite 拒绝 DROP 处于 UNIQUE 约束内的列——2026-10-24 本地启动实测报 `cannot drop UNIQUE column`）：删两个旧索引 → 建无明文列的新表（`secret_hash`、`api_key_hint` = key 后 4 位，name 的 `COLLATE NOCASE UNIQUE` 保留）→ 拷行 → 删旧表 → 改名 → 重建 `api_keys_secret_hash` 唯一索引与 `api_keys_created_at_ms`。
- 查表/写入改按 `sha256Hex(明文)` 查 `secret_hash`（与 `mflc_` 同源模式，`src/server/auth/login-credentials.ts`）；创建/轮换响应一次性返回完整 key，列表投影只取 hint。
- 单步切换依据：本地 `api_keys` 0 行（`.scratch/sec-hardening/probe-rowcounts-2026-10-24.stdout.txt`）。若远程表非 0 行，迁移在部署时应用会因回填缺失失败（天然安全阀），届时按 SPEC D6 两阶段执行。
- key 熵充足（随机生成），无盐 SHA-256 查表无彩虹表风险。

### D4｜F5：legacy bearer 调用写入访问审计

- attribution 构造：`{apiKeyId: 匹配行 id, credentialId: null, userId: owner ?? "apikey:" + id, permissionCode: "__unmapped__"}`；owner 从 `ext_api_key_owners` 主键点查；allow 与 deny 两路都写既有 `writeApiAccessLog`（真实响应状态码）。

### D5｜F6：App 登录时序抹平与封禁前置

- 未命中用户分支先执行 `verifyPassword(password, DUMMY_PASSWORD_HASH)`（better-auth/crypto 导出）再返回统一文案——两条路径口令校验次数恒为 1；假哈希由 `hashPassword(固定随机串)` 一次性预生成嵌入。
- 命中用户后先做封禁判定（复用后台凭证登录的判定函数），封禁返回同一文案且不签发凭证。

## 后果

- 攻击面量化收敛：审核页可注入内容从任意 HTML/JS 收敛到白名单标签；D1 数据面泄露后可用 key 数从全部降为 0；legacy 调用留痕从 0 行/次变为 1 行/次；账号枚举时序差归零。
- `mflc_` 登录凭证的明文 `secret` 列**保留**（「随时重新显示」为有意产品功能，另有吊销主控）——与 D3 的差异是产品决策，见 SPEC Out of Scope。
- 新增运行依赖 `sanitize-html`；`api_keys` 表结构变更需随部署应用迁移。

## 验证

- 测试只写不跑（仓库最高指令）：`tests/unit/server/audit-handlers.test.ts`（消毒断言）、`tests/unit/server/security-headers.test.ts`（纯函数接缝，middleware 接线为结构性保证）、`tests/worker/api-foundation.test.ts`（增哈希化断言：列表无明文、hint 形状、明文列不存在）、`tests/unit/components/admin-api-foundation.test.ts`（掩码与粘贴输入断言更新）、`tests/worker/api-access-log.test.ts`（新建）、`tests/worker/tcm-app-auth.test.ts`（增断言）。全量验证由用户手动触发 `.microfeed-gate-subset`。
- 库级行为实现时已用 node 直跑核对（`onclick`/`<script>`/`javascript:` 剥离、`rel` 注入），断言与真实输出逐字一致。
