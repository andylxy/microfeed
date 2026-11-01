import {describe, expect, it} from "vitest";

import {
  ADMIN_CREATED_DEFAULTS,
  AUTH_USERNAME_COLUMNS,
  AUTH_USER_COLUMNS,
} from "@/shared/AdminAccountColumns";
import {
  authUserInsertFromSetupSql,
  authUserInsertSql,
  credentialAccountFromSetupStatement,
  credentialAccountStatement,
} from "@/server/auth/account-insert";

describe("auth_user 建号列清单", () => {
  it("恰好 8 列，且不含已停用的 role 列", () => {
    expect(AUTH_USER_COLUMNS).toHaveLength(8);
    expect(AUTH_USER_COLUMNS).not.toContain("role");
    expect(AUTH_USER_COLUMNS).toContain("banned");
    expect(AUTH_USER_COLUMNS).toContain("signup_source");
    expect(AUTH_USERNAME_COLUMNS).toEqual(["username", "displayUsername"]);
  });

  it("管理侧默认值是字面量，不走绑定", () => {
    expect(ADMIN_CREATED_DEFAULTS).toEqual({banned: 0, emailVerified: 1});
  });
});

describe("authUserInsertSql", () => {
  it("默认形态：emailVerified 与 banned 写成字面量，signup_source 跟参数走", () => {
    const sql = authUserInsertSql({signupSource: "admin"});
    expect(sql).toContain('INSERT INTO "auth_user"');
    expect(sql).not.toContain("OR IGNORE");
    expect(sql).toContain('"banned", "signup_source"');
    expect(sql).toContain("VALUES (?, ?, ?, 1, ?, ?, 0, 'admin')");
  });

  it("withUsername 在末尾追加用户名两列", () => {
    const sql = authUserInsertSql({signupSource: "admin", withUsername: true});
    expect(sql).toContain('"username", "displayUsername")');
    expect(sql).toMatch(/, \?, \?\)$/u);
  });

  it("orIgnore 与 image 只在 QQ 建号打开", () => {
    const sql = authUserInsertSql({
      orIgnore: true,
      signupSource: "qq",
      withImage: true,
      withUsername: true,
    });
    expect(sql).toContain('INSERT OR IGNORE INTO "auth_user"');
    expect(sql).toContain('"image"');
    expect(sql).toContain("'qq'");
  });

  it("任何形态都不写 role", () => {
    for (const options of [
      {signupSource: "admin"} as const,
      {signupSource: "admin", withUsername: true} as const,
      {orIgnore: true, signupSource: "qq", withImage: true, withUsername: true} as const,
    ]) {
      expect(authUserInsertSql(options)).not.toMatch(/"role"/u);
    }
  });
});

describe("authUserInsertFromSetupSql", () => {
  it("保留 SELECT 形态与令牌校验，name/email 取自 setup 行", () => {
    const sql = authUserInsertFromSetupSql({});
    expect(sql).toContain(`SELECT ?, "email", "email", 1, ?, ?, 0, 'admin'`);
    expect(sql).toContain('FROM "auth_password_setup"');
    expect(sql).toContain('"tokenHash" = ?');
    expect(sql).toContain('"expiresAt" > ?');
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM "auth_user")');
  });
});

/** 只记下传给 `prepare` / `bind` 的内容，不执行任何 SQL。 */
function captureStatement(): {
  db: D1Database;
  captured: {sql?: string; values?: unknown[]};
} {
  const captured: {sql?: string; values?: unknown[]} = {};
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          captured.sql = sql;
          captured.values = values;
          return captured;
        },
      };
    },
  } as unknown as D1Database;
  return {db, captured};
}

describe("auth_account 凭证行", () => {
  it("providerId 写死 credential，accountId 与 userId 落同值", () => {
    const {db, captured} = captureStatement();
    credentialAccountStatement(db, {
      accountId: "account-row",
      passwordHash: "hash",
      timestamp: "2026-01-01T00:00:00.000Z",
      userId: "user-row",
    });
    expect(captured.sql).toContain("'credential'");
    expect(captured.values).toEqual([
      "account-row",
      "user-row",
      "user-row",
      "hash",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ]);
  });

  it("安装流程那条带令牌校验与 EXISTS 收尾", () => {
    const {db, captured} = captureStatement();
    credentialAccountFromSetupStatement(db, {
      accountId: "account-row",
      passwordHash: "hash",
      purpose: "initial",
      setupId: "owner",
      timestamp: "2026-01-01T00:00:00.000Z",
      tokenHash: "token",
      userId: "user-row",
    });
    expect(captured.sql).toContain('FROM "auth_password_setup"');
    expect(captured.sql).toContain('"tokenHash" = ?');
    expect(captured.sql).toContain('EXISTS (SELECT 1 FROM "auth_user" WHERE "id" = ?)');
    // 6 个列占位 + WHERE 四项 + EXISTS 一项
    expect(captured.values).toHaveLength(11);
  });
});
