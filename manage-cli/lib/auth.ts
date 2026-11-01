import {randomUUID} from "node:crypto";

import {hashPassword} from "better-auth/crypto";

import {
  ADMIN_CREATED_DEFAULTS,
  AUTH_USER_COLUMNS,
} from "@/shared/AdminAccountColumns";
import {normalizeAdminEmail} from "@/shared/AdminCredentials";

export {
  MAX_ADMIN_PASSWORD_LENGTH as MAX_PASSWORD_LENGTH,
  MIN_ADMIN_PASSWORD_LENGTH as MIN_PASSWORD_LENGTH,
  normalizeAdminEmail as normalizeOwnerEmail,
  validateAdminEmail as validateOwnerEmail,
  validateAdminPassword as validateOwnerPassword,
} from "@/shared/AdminCredentials";

export interface AuthOwner {
  email: string;
  id: string;
}

export interface AuthPasswordSetup {
  createdAt: string;
  email: string;
  expiresAt: string;
  purpose: "initial" | "reset";
  userId: string | null;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export async function ownerInsertSql(
  emailInput: string,
  password: string,
): Promise<string> {
  const email = normalizeAdminEmail(emailInput);
  const passwordHash = await hashPassword(password);
  const userId = randomUUID();
  const accountId = randomUUID();
  const timestamp = new Date().toISOString();
  // 按列名取值：`AUTH_USER_COLUMNS` 增列时这里会编译失败，逼调用方补出新列的
  // 取值，不会静默少写一列。
  const userValues: Record<(typeof AUTH_USER_COLUMNS)[number], string> = {
    id: sqlString(userId),
    name: sqlString(email),
    email: sqlString(email),
    emailVerified: String(ADMIN_CREATED_DEFAULTS.emailVerified),
    createdAt: sqlString(timestamp),
    updatedAt: sqlString(timestamp),
    banned: String(ADMIN_CREATED_DEFAULTS.banned),
    signup_source: sqlString("admin"),
  };
  return [
    "INSERT INTO \"auth_user\" (" +
      AUTH_USER_COLUMNS.map((column) => `"${column}"`).join(", ") +
      ") VALUES (" +
      AUTH_USER_COLUMNS.map((column) => userValues[column]).join(", ") +
      ");",
    "INSERT INTO \"auth_account\" (" +
      "\"id\", \"accountId\", \"providerId\", \"userId\", \"password\", " +
      "\"createdAt\", \"updatedAt\"" +
      ") VALUES (" +
      [
        sqlString(accountId),
        sqlString(userId),
        sqlString("credential"),
        sqlString(userId),
        sqlString(passwordHash),
        sqlString(timestamp),
        sqlString(timestamp),
      ].join(", ") +
      ");",
  ].join("\n");
}

export function clearPasswordSetupSql(): string {
  return 'DELETE FROM "auth_password_setup" WHERE "id" = \'owner\';';
}

export function passwordSetupSql(input: {
  email: string;
  expiresAt: string;
  purpose: "initial" | "reset";
  tokenHash: string;
  userId: string | null;
}): string {
  const timestamp = new Date().toISOString();
  return [
    'INSERT INTO "auth_password_setup" (' +
      '"id", "purpose", "email", "userId", "tokenHash", "createdAt", ' +
      '"expiresAt") VALUES (' +
      [
        sqlString("owner"),
        sqlString(input.purpose),
        sqlString(normalizeAdminEmail(input.email)),
        input.userId === null ? "NULL" : sqlString(input.userId),
        sqlString(input.tokenHash),
        sqlString(timestamp),
        sqlString(input.expiresAt),
      ].join(", ") +
      ") ON CONFLICT(\"id\") DO UPDATE SET " +
      '"purpose" = excluded."purpose", ' +
      '"email" = excluded."email", ' +
      '"userId" = excluded."userId", ' +
      '"tokenHash" = excluded."tokenHash", ' +
      '"createdAt" = excluded."createdAt", ' +
      '"expiresAt" = excluded."expiresAt";',
  ].join("\n");
}

export async function passwordResetSql(
  owner: AuthOwner,
  password: string,
): Promise<string> {
  const passwordHash = await hashPassword(password);
  const timestamp = new Date().toISOString();
  return [
    "UPDATE \"auth_account\" SET " +
      `"password\" = ${sqlString(passwordHash)}, ` +
      `"updatedAt\" = ${sqlString(timestamp)} ` +
      `WHERE \"userId\" = ${sqlString(owner.id)} ` +
      "AND \"providerId\" = 'credential';",
    `DELETE FROM "oauth_access_token" WHERE "userId" = ${sqlString(owner.id)};`,
    `DELETE FROM "oauth_refresh_token" WHERE "userId" = ${sqlString(owner.id)};`,
    `DELETE FROM "oauth_consent" WHERE "userId" = ${sqlString(owner.id)};`,
    `DELETE FROM "oauth_connection" WHERE "userId" = ${sqlString(owner.id)};`,
    `DELETE FROM "auth_session" WHERE "userId" = ${sqlString(owner.id)};`,
  ].join("\n");
}

export function revokeOwnerOAuthSql(owner: AuthOwner): string {
  return [
    `DELETE FROM "oauth_access_token" WHERE "userId" = ${sqlString(owner.id)};`,
    `DELETE FROM "oauth_refresh_token" WHERE "userId" = ${sqlString(owner.id)};`,
    `DELETE FROM "oauth_consent" WHERE "userId" = ${sqlString(owner.id)};`,
    `DELETE FROM "oauth_connection" WHERE "userId" = ${sqlString(owner.id)};`,
  ].join("\n");
}

export function ownerEmailUpdateSql(
  owner: AuthOwner,
  emailInput: string,
): string {
  const email = normalizeAdminEmail(emailInput);
  const timestamp = new Date().toISOString();
  return [
    "UPDATE \"auth_user\" SET " +
      `"email\" = ${sqlString(email)}, ` +
      `"name\" = ${sqlString(email)}, ` +
      `"updatedAt\" = ${sqlString(timestamp)} ` +
      `WHERE \"id\" = ${sqlString(owner.id)};`,
    `DELETE FROM "auth_session" WHERE "userId" = ${sqlString(owner.id)};`,
  ].join("\n");
}
