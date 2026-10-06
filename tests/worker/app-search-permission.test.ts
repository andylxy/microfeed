import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

import {GET as searchPermissionGet} from "@/pages/api/app/search-permission";
import {createLoginCredential} from "@/server/auth/login-credentials";
import {RBAC_WILDCARD} from "@/server/rbac/resolve";
import {permissionId} from "@/server/rbac/seed";

/**
 * 端点 `GET /api/app/search-permission` 的运行时契约（DESIGN §5.2）。
 *
 * 锁住客户端真正依赖的事：
 * - 角色不命中 = 200 双 false（有效答案，客户端据此禁用且不重试）；
 * - 持 `app:search:global` = 200 {true,false}；
 * - 持 `*` 通配 = 200 {true,true}；
 * - 无效 / 缺失 Bearer = 401（保底，middleware 已挡）；
 * - DB 异常 = 500，**不**伪装成双 false；
 * - 响应 `no-store`。
 */

const db = env.FEED_DB;
const URL_ = "https://app.example.com/api/app/search-permission";

async function seedUser(id: string): Promise<void> {
  await db.prepare(
    'INSERT OR IGNORE INTO "auth_user" (id, name, email, emailVerified, createdAt, updatedAt, role, banned) ' +
      "VALUES (?, ?, ?, 1, '2024-01-01', '2024-01-01', 'user', 0)",
  )
    .bind(id, id.toUpperCase(), `${id}@example.com`)
    .run();
}

// 给账号挂一个合成角色，并授予一组权限码。权限码行不存在时补建（INSERT OR IGNORE），
// 使本测试不依赖 seed 是否已写入这些码。
async function grantCodes(userId: string, codes: string[]): Promise<void> {
  const roleId = `r_test_${userId}`;
  await db.prepare(
    "INSERT OR IGNORE INTO ext_roles (id, code, name) VALUES (?, ?, ?)",
  )
    .bind(roleId, roleId, roleId)
    .run();
  await db.prepare(
    "INSERT OR IGNORE INTO ext_user_roles (user_id, role_id) VALUES (?, ?)",
  )
    .bind(userId, roleId)
    .run();
  for (const code of codes) {
    // 复用 seed 的 id 公式，不在本文件重写第三份 `p_${code.replace(...)}`。
    const permId = permissionId(code);
    await db.prepare(
      "INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES (?, ?, ?)",
    )
      .bind(permId, code, code)
      .run();
    const row = await db
      .prepare("SELECT id FROM ext_permissions WHERE code = ?")
      .bind(code)
      .first<{id: string}>();
    if (!row) throw new Error(`permission row missing for ${code}`);
    await db.prepare(
      "INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id) VALUES (?, ?)",
    )
      .bind(roleId, row.id)
      .run();
  }
}

async function bearerFor(userId: string): Promise<string> {
  const cred = await createLoginCredential(db, {name: "api", userId});
  return cred.secret;
}

async function callWithBearer(secret: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (secret) headers.authorization = `Bearer ${secret}`;
  return searchPermissionGet({
    request: new Request(URL_, {headers}),
  } as never);
}

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM ext_user_roles"),
    db.prepare("DELETE FROM ext_role_permissions"),
    db.prepare("DELETE FROM ext_login_credentials"),
    db.prepare("DELETE FROM ext_permissions"),
    db.prepare("DELETE FROM ext_roles"),
    db.prepare('DELETE FROM "auth_user"'),
  ]);
});

describe("GET /api/app/search-permission", () => {
  it("returns 200 {false,false} for an account with no search codes", async () => {
    // 仅持 `app:mobile:access`（通过 middleware 的门票），无任何搜索码。
    // 这是有效答案，客户端据此禁用搜索且**不**重试。
    await seedUser("u_none");
    await grantCodes("u_none", ["app:mobile:access"]);
    const response = await callWithBearer(await bearerFor("u_none"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({global: false, book: false});
  });

  it("returns 200 {true,false} for an account with only global search", async () => {
    await seedUser("u_global");
    await grantCodes("u_global", ["app:search:global"]);
    const response = await callWithBearer(await bearerFor("u_global"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({global: true, book: false});
  });

  it("returns 200 {true,true} for a wildcard account", async () => {
    await seedUser("u_wild");
    await grantCodes("u_wild", [RBAC_WILDCARD]);
    const response = await callWithBearer(await bearerFor("u_wild"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({global: true, book: true});
  });

  it("returns 401 for a missing bearer", async () => {
    const response = await callWithBearer(null);
    expect(response.status).toBe(401);
  });

  it("returns 401 for an invalid (mflc_-prefixed but unknown) bearer", async () => {
    const response = await callWithBearer("mflc_this_token_does_not_exist");
    expect(response.status).toBe(401);
  });

  it("is no-store so a cold start never reads a stale permission", async () => {
    await seedUser("u_store");
    await grantCodes("u_store", ["app:search:book"]);
    const response = await callWithBearer(await bearerFor("u_store"));
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("reports a resolve failure as 500 rather than two false", async () => {
    // 客户端对 500 与双 false 都是静默，但运维必须能区分「服务端炸了」和「没权限」。
    // 临时改名 ext_permissions 制造 DB 错误，`finally` 保证复原。
    await seedUser("u_db");
    await grantCodes("u_db", ["app:search:global"]);
    const secret = await bearerFor("u_db");
    await db
      .prepare("ALTER TABLE ext_permissions RENAME TO ext_permissions_hidden")
      .run();
    try {
      const response = await callWithBearer(secret);
      expect(response.status).toBe(500);
    } finally {
      await db
        .prepare(
          "ALTER TABLE ext_permissions_hidden RENAME TO ext_permissions",
        )
        .run();
    }
  });
});
