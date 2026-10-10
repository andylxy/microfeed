import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {env} from "cloudflare:workers";

import * as GetAllMingCi from "@/pages/api/AppBookRequest/GetAllMingCi";
import {createLoginCredential} from "@/server/auth/login-credentials";
import {permissionId} from "@/server/rbac/seed";

/**
 * `GET /api/AppBookRequest/GetAllMingCi` 服务端纵深防御（T04 / R1 两者都做之一）。
 *
 * 锁定：
 * - 持 `app:mingci:view`（或 `*` 通配）→ 200 + 满数组 + `public, max-age=300`；
 * - 不持码 / 无凭证 → 200 + `appEnvelope([])`（空数组，**非 403**）+ `no-store`；
 * - 这是内容端点，fail-closed 必须静默空数据，不能抛错破坏信封约定。
 *
 * 不依赖 DOMAIN_RULES（本路由不挂 `app:mingci:view` 规则，否则缺码会返 403）。
 */

const db = env.FEED_DB;
const ORIGIN = "https://app.example.com";
const TERM = "rtterm001";

async function seedUser(id: string): Promise<void> {
  await db.prepare(
    'INSERT OR IGNORE INTO "auth_user" (id, name, email, emailVerified, createdAt, updatedAt, role, banned) ' +
      "VALUES (?, ?, ?, 1, '2024-01-01', '2024-01-01', 'user', 0)",
  )
    .bind(id, id.toUpperCase(), `${id}@example.com`)
    .run();
}

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

async function seedTerm(): Promise<void> {
  await db
    .prepare(
      "INSERT OR REPLACE INTO items (id, status, data, pub_date, created_at, updated_at, " +
        "content_text, content_text_updated_at, content_text_revision, review_status, book_id, " +
        "tcm_kind, tcm_parent_id) VALUES (?, 1, ?, '2024-09-17T00:57:25.000Z', " +
        "'2024-09-17T00:57:25.000Z', '2024-09-17T00:57:25.000Z', '', " +
        "'2024-09-17T00:57:25.000Z', 1, NULL, NULL, 'term', NULL)",
    )
    .bind(TERM, JSON.stringify({title: "桂枝", content: "<p>解表药</p>"}))
    .run();
}

async function callGetAllMingCi(secret: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (secret) headers.authorization = `Bearer ${secret}`;
  return GetAllMingCi.GET({
    request: new Request(`${ORIGIN}/api/AppBookRequest/GetAllMingCi`, {headers}),
  } as never);
}

beforeEach(async () => {
  await seedTerm();
});

afterEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM items WHERE id = ?").bind(TERM),
    db.prepare("DELETE FROM ext_user_roles"),
    db.prepare("DELETE FROM ext_role_permissions"),
    db.prepare("DELETE FROM ext_login_credentials"),
    db.prepare("DELETE FROM ext_permissions"),
    db.prepare("DELETE FROM ext_roles"),
    db.prepare('DELETE FROM "auth_user"'),
  ]);
});

describe("GET /api/AppBookRequest/GetAllMingCi (server-side defense)", () => {
  it("returns the full term array + public cache when the account holds app:mingci:view", async () => {
    await seedUser("u_mingci");
    await grantCodes("u_mingci", ["app:mingci:view"]);
    const res = await callGetAllMingCi(await bearerFor("u_mingci"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {code: number; data: unknown[]};
    expect(body.code).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.headers.get("cache-control")).toContain("max-age=300");
  });

  it("returns an empty envelope + no-store when the account lacks the code", async () => {
    await seedUser("u_none");
    await grantCodes("u_none", ["app:mobile:access"]);
    const res = await callGetAllMingCi(await bearerFor("u_none"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {code: number; data: unknown[]};
    expect(body.code).toBe(200);
    expect(body.data).toEqual([]);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("fails closed (empty + no-store) when no bearer is presented", async () => {
    const res = await callGetAllMingCi(null);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {code: number; data: unknown[]};
    expect(body.data).toEqual([]);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
