/**
 * `auth_user` / `auth_account` 建号语句的唯一构建入口。
 *
 * 五条建号路径的差异在语句形态与输出，不在列清单：
 * - 直接给值：`authUserInsertSql`（安装引导、后台建号、QQ 建号）
 * - 从 `auth_password_setup` 条件插入：`authUserInsertFromSetupSql`（安装流程）
 * - 凭证行：`credentialAccountStatement`（三条直接给值的路径）
 * - 带令牌校验的凭证行：`credentialAccountFromSetupStatement`（安装流程）
 *
 * `manage-cli` 只取 `@/shared/AdminAccountColumns` 的常量自行拼字符串：它的输出
 * 是给终端打印的 SQL 文本，不是 `D1PreparedStatement`，硬塞进同一签名会让返回值
 * 变成联合类型。
 *
 * 安装流程的两条语句把一次性令牌的校验（`tokenHash` + `expiresAt`）写在语句自身
 * 里。先查后写会开出「令牌被并发消费」的窗口，`tests/worker/password-setup.test.ts`
 * 的「并发只成功一次」用例依赖这个原子性，抽函数时形态必须保留。
 */

import {
  ADMIN_CREATED_DEFAULTS,
  AUTH_USERNAME_COLUMNS,
  AUTH_USER_COLUMNS,
  AUTH_USER_IMAGE_COLUMN,
  type AdminSignupSource,
} from "@/shared/AdminAccountColumns";

/** 账号口令行的输入。`accountId` 是 `auth_account.id`，不是 `auth_user.id`。 */
export interface CredentialAccountInput {
  accountId: string;
  passwordHash: string;
  timestamp: string;
  userId: string;
}

/** 安装流程的凭证行额外带一次性令牌三元组。 */
export interface SetupCredentialAccountInput extends CredentialAccountInput {
  purpose: string;
  setupId: string;
  tokenHash: string;
}

export interface AuthUserInsertOptions {
  /** 追加 `image` 列。只有 QQ 建号写头像。 */
  withImage?: boolean;
  /** 追加用户名两列。 */
  withUsername?: boolean;
  /** 追加 `OR IGNORE`。QQ 建号靠 `changes = 0` 判并发冲突，必须能开。 */
  orIgnore?: boolean;
  /** `signup_source` 的取值，写成 SQL 字面量。 */
  signupSource: AdminSignupSource;
}

interface ColumnPlan {
  columns: string[];
  values: string[];
}

/**
 * `auth_account` 的列清单。四条路径形态完全一致，只在这里出现一次。
 * `providerId` 恒为 `'credential'`，写成字面量。
 */
const AUTH_ACCOUNT_COLUMNS_SQL =
  '("id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt")';

function quoted(columns: readonly string[]): string {
  return columns.map((column) => `"${column}"`).join(", ");
}

/**
 * 按 `AUTH_USER_COLUMNS` 的顺序铺开列名，`valueFor` 决定每列写成什么：
 * 绑定占位 `?`、另一列的引用（安装流程从 `auth_password_setup` 取 email），
 * 或字面量。
 */
function planColumns(
  options: {withImage?: boolean; withUsername?: boolean},
  valueFor: (column: string) => string,
): ColumnPlan {
  const columns: string[] = [];
  const values: string[] = [];
  for (const column of AUTH_USER_COLUMNS) {
    columns.push(column);
    values.push(valueFor(column));
    if (column === "emailVerified" && options.withImage === true) {
      columns.push(AUTH_USER_IMAGE_COLUMN);
      values.push("?");
    }
  }
  if (options.withUsername === true) {
    columns.push(...AUTH_USERNAME_COLUMNS);
    values.push("?", "?");
  }
  return {columns, values};
}

/**
 * 直接给值的建号：安装引导 / 后台建号 / QQ 建号。
 *
 * 绑定顺序（与列顺序一致，跳过字面量列）：
 * `id`、`name`、`email`、可选 `image`、`createdAt`、`updatedAt`、
 * 可选 `username`、`displayUsername`。
 */
export function authUserInsertSql(options: AuthUserInsertOptions): string {
  const {columns, values} = planColumns(options, (column) => {
    if (column === "emailVerified") {
      return String(ADMIN_CREATED_DEFAULTS.emailVerified);
    }
    if (column === "banned") {
      return String(ADMIN_CREATED_DEFAULTS.banned);
    }
    if (column === "signup_source") {
      return `'${options.signupSource}'`;
    }
    return "?";
  });
  const head = options.orIgnore === true
    ? "INSERT OR IGNORE INTO"
    : "INSERT INTO";
  return `${head} "auth_user" (${quoted(columns)}) VALUES (${values.join(", ")})`;
}

/**
 * 从 `auth_password_setup` 条件式插入（安装流程专用）。
 *
 * `name` / `email` 取自 setup 行本身，不绑定；末尾四个 `?` 依次是
 * `setupId`、`purpose`、`tokenHash`、`expiresAt`，`EXISTS` 另有一个只读占位。
 * 绑定顺序：`id`、`createdAt`、`updatedAt`，再接 WHERE 的四项。
 */
export function authUserInsertFromSetupSql(options: {
  withUsername?: boolean;
}): string {
  const {columns, values} = planColumns(options, (column) => {
    if (column === "name" || column === "email") {
      return '"email"';
    }
    if (column === "emailVerified") {
      return String(ADMIN_CREATED_DEFAULTS.emailVerified);
    }
    if (column === "banned") {
      return String(ADMIN_CREATED_DEFAULTS.banned);
    }
    if (column === "signup_source") {
      return "'admin'";
    }
    return "?";
  });
  return `INSERT INTO "auth_user" (${quoted(columns)}) ` +
    `SELECT ${values.join(", ")} FROM "auth_password_setup" ` +
    'WHERE "id" = ? AND "purpose" = ? AND "tokenHash" = ? ' +
    'AND "expiresAt" > ? AND NOT EXISTS (SELECT 1 FROM "auth_user")';
}

/**
 * `auth_account` 的凭证行。三条直接给值的路径（安装引导、后台建号、QQ 建号）
 * 形态完全一致，全部走它。
 */
export function credentialAccountStatement(
  db: D1Database,
  input: CredentialAccountInput,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO "auth_account" ${AUTH_ACCOUNT_COLUMNS_SQL} ` +
        "VALUES (?, ?, 'credential', ?, ?, ?, ?)",
    )
    .bind(
      input.accountId,
      input.userId,
      input.userId,
      input.passwordHash,
      input.timestamp,
      input.timestamp,
    );
}

/**
 * 安装流程的凭证行：与上一条同形，但带令牌校验，并确认 `auth_user` 行已在
 * 同一批次的前一条写入。校验留在语句内，令牌被并发消费时本条返回 0 changes。
 */
export function credentialAccountFromSetupStatement(
  db: D1Database,
  input: SetupCredentialAccountInput,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO "auth_account" ${AUTH_ACCOUNT_COLUMNS_SQL} ` +
        "SELECT ?, ?, 'credential', ?, ?, ?, ? FROM \"auth_password_setup\" " +
        'WHERE "id" = ? AND "purpose" = ? AND "tokenHash" = ? ' +
        'AND "expiresAt" > ? AND EXISTS (SELECT 1 FROM "auth_user" WHERE "id" = ?)',
    )
    .bind(
      input.accountId,
      input.userId,
      input.userId,
      input.passwordHash,
      input.timestamp,
      input.timestamp,
      input.setupId,
      input.purpose,
      input.tokenHash,
      input.timestamp,
      input.userId,
    );
}
