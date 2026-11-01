import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

import {
  replaceRolePermissions,
  replaceUserRoles,
  setRbacRoleAdminLogin,
  setRbacRoleMember,
} from "@/server/admin/rbac-handlers";
import {resolveRbacContext} from "@/server/rbac/resolve";

/**
 * 权限快照的重算在真实 D1 上的行为（ADR-0053）。
 *
 * 单元测试守的是「每个写入点都调了重算」，这里守的是「调了之后数据真的对」：
 * 改角色授权、改用户角色、改角色开关之后，快照行必须跟着变；清空角色之后，
 * 快照行必须消失（不是留着旧权限）。
 */

const ORIGIN = "https://feed.example.com";

async function clearRows(): Promise<void> {
  await env.FEED_DB.batch([
    env.FEED_DB.prepare("DELETE FROM ext_user_permissions"),
    env.FEED_DB.prepare("DELETE FROM ext_user_security"),
    env.FEED_DB.prepare("DELETE FROM ext_user_roles"),
    env.FEED_DB.prepare("DELETE FROM ext_role_permissions WHERE role_id = 'r_snapshot_probe'"),
    env.FEED_DB.prepare("DELETE FROM ext_roles WHERE id = 'r_snapshot_probe'"),
    env.FEED_DB.prepare('DELETE FROM "auth_user"'),
  ]);
}

async function seedUser(id: string): Promise<void> {
  await env.FEED_DB.prepare(
    'INSERT INTO "auth_user" (id, name, email, emailVerified, createdAt, updatedAt, role) ' +
      "VALUES (?, ?, ?, 1, '2024-01-01', '2024-01-01', 'user')",
  )
    .bind(id, id.toUpperCase(), `${id}@example.com`)
    .run();
}

/** 建一个空角色（不带任何授权），返回它的**角色码**（`replaceRolePermissions` 收的是码）。 */
async function seedRole(): Promise<string> {
  await env.FEED_DB.prepare(
    "INSERT INTO ext_roles (id, code, name, allow_admin_login, is_member) " +
      "VALUES ('r_snapshot_probe', 'snapshot_probe', 'Snapshot probe', 1, 0)",
  ).run();
  return "snapshot_probe";
}

async function readSnapshot(userId: string): Promise<{
  adminLoginAllowed: number;
  codes: string;
  isMember: number;
} | null> {
  return env.FEED_DB.prepare(
    `SELECT codes, is_member AS isMember, admin_login_allowed AS adminLoginAllowed
       FROM ext_user_permissions WHERE user_id = ?`,
  ).bind(userId).first();
}

function adminRequest(): Request {
  return new Request(`${ORIGIN}/admin/`);
}

beforeEach(clearRows);

describe("权限快照随真源重算", () => {
  it("改角色授权后，持有该角色的账号快照跟着变", async () => {
    const roleCode = await seedRole();
    await seedUser("u-snap-a");
    await replaceUserRoles(env.FEED_DB, "u-snap-a", ["snapshot_probe"]);

    // 刚分配到一个空角色：有快照行，权限为空。
    let row = await readSnapshot("u-snap-a");
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.codes)).toEqual([]);

    const granted = await replaceRolePermissions(
      env.FEED_DB,
      roleCode,
      ["content:book:read"],
      "desktop",
    );
    expect(granted).toEqual({ok: true});

    row = await readSnapshot("u-snap-a");
    expect(JSON.parse(row!.codes)).toEqual(["content:book:read"]);

    // 读路径拿到的是同一份权限。
    const resolved = await resolveRbacContext(
      env.FEED_DB, "u-snap-a", adminRequest(),
    );
    expect(resolved.permissions.has("content:book:read")).toBe(true);
    expect(resolved.adminLoginAllowed).toBe(true);
  });

  it("清空账号角色后快照行消失，该账号读不到任何权限", async () => {
    await seedRole();
    await seedUser("u-snap-b");
    await replaceUserRoles(env.FEED_DB, "u-snap-b", ["snapshot_probe"]);
    expect(await readSnapshot("u-snap-b")).not.toBeNull();

    await replaceUserRoles(env.FEED_DB, "u-snap-b", []);

    // 关键：INSERT…SELECT 命中 0 行时会留下旧行，那等于继续持旧权限，比 403 更危险。
    expect(await readSnapshot("u-snap-b")).toBeNull();
    const resolved = await resolveRbacContext(
      env.FEED_DB, "u-snap-b", adminRequest(),
    );
    expect(resolved.permissions.size).toBe(0);
    expect(resolved.adminLoginAllowed).toBe(false);
  });

  it("改角色的会员标记后快照跟着变", async () => {
    await seedRole();
    await seedUser("u-snap-c");
    await replaceUserRoles(env.FEED_DB, "u-snap-c", ["snapshot_probe"]);
    expect((await readSnapshot("u-snap-c"))!.isMember).toBe(0);

    expect(await setRbacRoleMember(env.FEED_DB, "snapshot_probe", true))
      .toEqual({ok: true});
    expect((await readSnapshot("u-snap-c"))!.isMember).toBe(1);
  });

  it("关掉「允许登录后台」后快照拒绝该账号进后台", async () => {
    await seedRole();
    await seedUser("u-snap-d");
    await replaceUserRoles(env.FEED_DB, "u-snap-d", ["snapshot_probe"]);
    expect((await readSnapshot("u-snap-d"))!.adminLoginAllowed).toBe(1);

    expect(await setRbacRoleAdminLogin(env.FEED_DB, "snapshot_probe", false))
      .toEqual({ok: true});

    expect((await readSnapshot("u-snap-d"))!.adminLoginAllowed).toBe(0);
    const resolved = await resolveRbacContext(
      env.FEED_DB, "u-snap-d", adminRequest(),
    );
    expect(resolved.adminLoginAllowed).toBe(false);
    // 权限码不受「登录后台」开关影响，只影响入口。
    expect(resolved.banned).toBe(false);
  });

  it("零角色账号没有快照行，后台准入与权限都为空", async () => {
    await seedUser("u-snap-e");
    expect(await readSnapshot("u-snap-e")).toBeNull();

    const resolved = await resolveRbacContext(
      env.FEED_DB, "u-snap-e", adminRequest(),
    );
    expect(resolved.permissions.size).toBe(0);
    expect(resolved.adminLoginAllowed).toBe(false);
  });

  it("超管快照只存通配，不展开成全量权限码", async () => {
    await seedUser("u-snap-f");
    await replaceUserRoles(env.FEED_DB, "u-snap-f", ["super_admin"]);

    const row = await readSnapshot("u-snap-f");
    expect(JSON.parse(row!.codes)).toEqual(["*"]);
    const resolved = await resolveRbacContext(
      env.FEED_DB, "u-snap-f", adminRequest(),
    );
    // 通配由 permissionsInclude 短路，快照不需要展开。
    expect(resolved.permissions.has("*")).toBe(true);
  });
});
