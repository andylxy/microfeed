/**
 * 删号时随账号一起清理的从属表清单。
 *
 * 单独成文件是为了让 `tests/unit/user-delete-coverage.test.ts` 能直接引用它：
 * 放在 `rbac-handlers.ts` 里会连带引入 `cloudflare:workers`，单元测试环境跑不起来。
 *
 * 新增按 userId 引用的表时必须补进 `USER_OWNED_TABLES`，否则留下孤儿行。清单由
 * `tests/unit/user-delete-coverage.test.ts` 兜住：它从迁移文件里枚举 `auth_user` 的
 * 引用表，逐张核对这两份清单。
 */

/**
 * 列名两种写法并存（camelCase 的 `userId` 与下划线的 `user_id`），照各表实际
 * 定义写，不做统一。
 */
export const USER_OWNED_TABLES = [
  {column: "userId", table: "auth_account"},
  {column: "userId", table: "auth_password_setup"},
  {column: "userId", table: "auth_session"},
  {column: "userId", table: "oauth_access_token"},
  {column: "userId", table: "oauth_client"},
  {column: "userId", table: "oauth_connection"},
  {column: "userId", table: "oauth_consent"},
  {column: "userId", table: "oauth_refresh_token"},
  {column: "userId", table: "passkey"},
  {column: "user_id", table: "ext_api_key_owners"},
  {column: "user_id", table: "ext_app_login_log"},
  {column: "user_id", table: "ext_login_credentials"},
  {column: "user_id", table: "ext_user_devices"},
  {column: "user_id", table: "ext_user_oauth"},
  {column: "user_id", table: "ext_user_permissions"},
  {column: "user_id", table: "ext_user_roles"},
  {column: "user_id", table: "ext_user_security"},
] as const;

/**
 * 账号删除后仍需保留的表：审计流水独立于账号生命周期。
 *
 * 这张表记的是 API 调用流水（本机 13,068 行），账号消失后仍需可查。不要因为
 * 「补全清单」把它一起清掉。
 */
export const USER_DELETE_EXEMPT = ["ext_api_access_log"] as const;
