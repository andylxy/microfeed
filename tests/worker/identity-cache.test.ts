import {env} from "cloudflare:workers";
import {afterEach, beforeEach, describe, expect, it} from "vitest";

import {readSettingsCategory} from "@/server/feed/settings-store";
import {
  purgeUserAccess,
  purgeUsersAccess,
  cachedUserAccess,
} from "@/server/cache/identity-cache";
import {
  deleteAppCacheControlEntry,
  saveAppCacheControl,
} from "@/server/cache/cache-control";
import {workerCache} from "@/server/cache/worker-cache";
import {
  createRbacRole,
  deleteRbacRole,
  replaceRolePermissions,
  replaceUserRoles,
  setRbacRoleMember,
} from "@/server/admin/rbac-handlers";

/**
 * 角色对象缓存（方案 4.3）：命中不重复查库、清理后回源、`permissions` 还原成
 * `Set`、坏条目按未命中处理。
 *
 * 「命中不重复查库」用删除库里的授权行来证明：第二次调用仍返回第一次的值，
 * 说明它读的是缓存，不是库。
 */

const USER_ID = "u-identity-cache";
const MEMBER_ROLE = "identity_cache_member";
const KEY_ORIGIN = "https://app-identity.microfeed.internal";

function cacheKey(userId: string): URL {
  return new URL(`/identity/access/${encodeURIComponent(userId)}`, KEY_ORIGIN);
}

async function seedUser(id: string): Promise<void> {
  await env.FEED_DB.prepare(
    'INSERT INTO "auth_user" (id, name, email, emailVerified, createdAt, updatedAt, role) ' +
      "VALUES (?, ?, ?, 1, '2024-01-01', '2024-01-01', 'user')",
  ).bind(id, id, `${id}@example.com`).run();
}

async function assignRole(userId: string, roleId: string): Promise<void> {
  await env.FEED_DB.prepare(
    "INSERT OR IGNORE INTO ext_user_roles (user_id, role_id) VALUES (?, ?)",
  ).bind(userId, roleId).run();
}

async function clearState(): Promise<void> {
  await env.FEED_DB.batch([
    env.FEED_DB.prepare("DELETE FROM ext_user_roles WHERE user_id = ?")
      .bind(USER_ID),
    env.FEED_DB.prepare('DELETE FROM "auth_user" WHERE id = ?').bind(USER_ID),
    env.FEED_DB.prepare(
      "DELETE FROM settings WHERE category = 'app_cache_control'",
    ),
    env.FEED_DB.prepare("DELETE FROM ext_roles WHERE code = ?")
      .bind(MEMBER_ROLE),
  ]);
  await deleteAppCacheControlEntry();
  await purgeUsersAccess([USER_ID]);
}

beforeEach(clearState);
afterEach(clearState);

describe("cachedUserAccess", () => {
  it("serves a hit without querying the database again", async () => {
    await seedUser(USER_ID);
    await assignRole(USER_ID, "r_editor");

    const first = await cachedUserAccess(env.FEED_DB, USER_ID);
    expect(first.permissions.has("content:book:create")).toBe(true);

    await env.FEED_DB.prepare(
      "DELETE FROM ext_user_roles WHERE user_id = ?",
    ).bind(USER_ID).run();

    const cached = await cachedUserAccess(env.FEED_DB, USER_ID);
    expect(cached.permissions.has("content:book:create")).toBe(true);

    await purgeUserAccess(USER_ID);
    const reloaded = await cachedUserAccess(env.FEED_DB, USER_ID);
    expect(reloaded.permissions.size).toBe(0);
  });

  it("restores permissions as a Set, never a plain array", async () => {
    await seedUser(USER_ID);
    await assignRole(USER_ID, "r_editor");
    await cachedUserAccess(env.FEED_DB, USER_ID);

    const cached = await cachedUserAccess(env.FEED_DB, USER_ID);
    expect(cached.permissions).toBeInstanceOf(Set);
    // 0191 退役 legacy 内容看板后 editor 不再持 content:category:update，
    // 改用仍在 editor 授权里的 book 码验证 Set 还原。
    expect(cached.permissions.has("content:book:update")).toBe(true);
  });

  it("treats a bad cache entry as a miss", async () => {
    await seedUser(USER_ID);
    await assignRole(USER_ID, "r_editor");

    await workerCache().put(
      cacheKey(USER_ID),
      new Response("not json", {headers: {"cache-control": "public, max-age=600"}}),
    );
    const fromBadJson = await cachedUserAccess(env.FEED_DB, USER_ID);
    expect(fromBadJson.permissions.has("content:book:create")).toBe(true);

    await workerCache().put(
      cacheKey(USER_ID),
      new Response(
        JSON.stringify({isMember: false, permissions: "content:book:create"}),
        {headers: {"cache-control": "public, max-age=600"}},
      ),
    );
    const fromBadShape = await cachedUserAccess(env.FEED_DB, USER_ID);
    expect(fromBadShape.permissions.has("content:book:create")).toBe(true);
  });

  it("skips match and put when the master switch is off", async () => {
    await seedUser(USER_ID);
    await assignRole(USER_ID, "r_editor");
    // 预置一份带假权限的条目：总闸关闭后它既不能被读出，也不能被覆盖。
    await workerCache().put(
      cacheKey(USER_ID),
      new Response(
        JSON.stringify({isMember: true, permissions: ["stale:perm"]}),
        {headers: {"cache-control": "public, max-age=600"}},
      ),
    );
    await saveAppCacheControl({enabled: false});

    const before = await cachedUserAccess(env.FEED_DB, USER_ID);
    expect(before.permissions.has("content:book:create")).toBe(true);
    expect(before.permissions.has("stale:perm")).toBe(false);

    await env.FEED_DB.prepare(
      "DELETE FROM ext_user_roles WHERE user_id = ?",
    ).bind(USER_ID).run();

    const after = await cachedUserAccess(env.FEED_DB, USER_ID);
    expect(after.permissions.size).toBe(0);
    expect(await readSettingsCategory(env.FEED_DB, "app_cache_control"))
      .not.toBeNull();
    const kept = await workerCache().match(cacheKey(USER_ID));
    expect(JSON.parse(await kept!.text())).toEqual({
      isMember: true,
      permissions: ["stale:perm"],
    });
  });
});

describe("RBAC write paths purge the role object", () => {
  it("replaceUserRoles drops the cached object", async () => {
    // readonly 与 editor 权限集相同（seed.ts），拿它们对比测不出清理；
    // 用自建空权限角色作起点。
    await createRbacRole(env.FEED_DB, MEMBER_ROLE, "Member cache role");
    await seedUser(USER_ID);
    await assignRole(USER_ID, `r_${MEMBER_ROLE}`);
    const before = await cachedUserAccess(env.FEED_DB, USER_ID);
    expect(before.permissions.has("content:book:create")).toBe(false);

    await replaceUserRoles(env.FEED_DB, USER_ID, ["editor"]);
    const after = await cachedUserAccess(env.FEED_DB, USER_ID);
    expect(after.permissions.has("content:book:create")).toBe(true);
  });

  it("replaceRolePermissions drops the cached object for every holder", async () => {
    await createRbacRole(env.FEED_DB, MEMBER_ROLE, "Member cache role");
    await seedUser(USER_ID);
    await assignRole(USER_ID, `r_${MEMBER_ROLE}`);
    const before = await cachedUserAccess(env.FEED_DB, USER_ID);
    expect(before.permissions.has("content:book:create")).toBe(false);

    const result = await replaceRolePermissions(
      env.FEED_DB,
      MEMBER_ROLE,
      ["content:book:create"],
      "desktop",
    );
    expect(result.ok).toBe(true);
    const after = await cachedUserAccess(env.FEED_DB, USER_ID);
    expect(after.permissions.has("content:book:create")).toBe(true);

    await env.FEED_DB.prepare(
      "DELETE FROM ext_user_roles WHERE user_id = ?",
    ).bind(USER_ID).run();
    await deleteRbacRole(env.FEED_DB, MEMBER_ROLE);
  });

  it("setRbacRoleMember drops the cached object for every holder", async () => {
    await createRbacRole(env.FEED_DB, MEMBER_ROLE, "Member cache role");
    await seedUser(USER_ID);
    await assignRole(USER_ID, `r_${MEMBER_ROLE}`);
    const before = await cachedUserAccess(env.FEED_DB, USER_ID);
    expect(before.isMember).toBe(false);

    await setRbacRoleMember(env.FEED_DB, MEMBER_ROLE, true);
    const after = await cachedUserAccess(env.FEED_DB, USER_ID);
    expect(after.isMember).toBe(true);

    await env.FEED_DB.prepare(
      "DELETE FROM ext_user_roles WHERE user_id = ?",
    ).bind(USER_ID).run();
    await deleteRbacRole(env.FEED_DB, MEMBER_ROLE);
  });
});
