/**
 * `auth_user` 建号语句的列清单，全仓只在这里出现一次。
 *
 * 放在 `shared/` 是因为 `manage-cli` 现行只 import `@/shared/*`
 * （`AdminCredentials`、`AdminPath`、`AdminAuth`、`ThemeContract`），没有一处
 * import `@/server/*`。列清单放这一层，服务端四条建号路径与 `manage-cli`
 * 吃同一份，不必为一个常量开出跨层先例。
 *
 * 加列只改这一处：服务端四条路径自动带上，`manage-cli` 那一处不会，
 * 由 `tests/unit/account-insert.test.ts` 的列清单断言兜住。
 */
export const AUTH_USER_COLUMNS = [
  "id",
  "name",
  "email",
  "emailVerified",
  "createdAt",
  "updatedAt",
  "banned",
  "signup_source",
] as const;

/** 用户名两列只在建号时确实有用户名的情况下追加。 */
export const AUTH_USERNAME_COLUMNS = ["username", "displayUsername"] as const;

/** 头像列只有 QQ 建号写，其余路径不出现。 */
export const AUTH_USER_IMAGE_COLUMN = "image" as const;

/**
 * 管理侧建号的固定取值：后台建号与安装引导都没有邮箱验证环节，新号未封禁。
 * 这两项写成 SQL 字面量，不走绑定——它们是路径属性，不是调用方数据。
 */
export const ADMIN_CREATED_DEFAULTS = {banned: 0, emailVerified: 1} as const;

/** 建号语句能写死的两个来源（邮箱注册那一档走 `email-signup.ts` 的 UPDATE）。 */
export type AdminSignupSource = "admin" | "qq";
