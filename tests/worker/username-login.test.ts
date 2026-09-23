import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

import {createAdminRbacUser} from "@/server/admin/rbac-handlers";
import {createMicrofeedAuth} from "@/server/auth/better-auth";
import {createLoginSessionCookies} from "@/server/auth/login-session";
import {adminUsernameEmail} from "@/shared/AdminCredentials";

const ORIGIN = "https://feed.example.com";
const CREATE_URL = `${ORIGIN}/admin/ajax/rbac/user-create`;
const ADMIN_ID = "u_username_admin";

/** A real admin session: the endpoint's `createUser` call requires one. */
let adminCookie = "";

/** Minimal `App.Locals` shape the RBAC guard reads. */
function locals(userId: string, permissions: string[] = ["system:user:manage"]) {
  return {
    authUser: {id: userId, role: null},
    rbacBanned: false,
    rbacDeviceRevoked: false,
    rbacMustChangePassword: false,
    rbacPermissions: new Set(permissions),
  };
}

async function seedAdmin(): Promise<void> {
  await env.FEED_DB.prepare(
    'INSERT INTO "auth_user" (id, name, email, emailVerified, createdAt, updatedAt, role, banned) ' +
      "VALUES (?, ?, ?, 1, '2024-01-01', '2024-01-01', 'admin', 0)",
  ).bind(ADMIN_ID, "Admin", "admin@example.com").run();
  const cookies = await createLoginSessionCookies(
    env,
    new Request(`${ORIGIN}/admin/`),
    ADMIN_ID,
  );
  adminCookie = cookies[0]!.split(";")[0]!;
}

async function createAccount(body: Record<string, unknown>): Promise<Response> {
  return createAdminRbacUser({
    locals: locals(ADMIN_ID),
    request: new Request(CREATE_URL, {
      body: JSON.stringify(body),
      headers: {cookie: adminCookie, origin: ORIGIN},
      method: "POST",
    }),
  } as never);
}

function auth() {
  return createMicrofeedAuth(
    env,
    new Request(`${ORIGIN}/api/auth/sign-in/username`),
  );
}

beforeEach(async () => {
  await env.FEED_DB.batch([
    env.FEED_DB.prepare("DELETE FROM auth_account"),
    env.FEED_DB.prepare("DELETE FROM auth_session"),
    env.FEED_DB.prepare("DELETE FROM ext_user_security"),
    env.FEED_DB.prepare("DELETE FROM ext_user_roles"),
    env.FEED_DB.prepare('DELETE FROM "auth_user"'),
  ]);
  await seedAdmin();
});

describe("username accounts", () => {
  it("stores a username alongside its placeholder address", async () => {
    const response = await createAccount({
      account: "Zhang.San",
      name: "Zhang San",
      password: "secret1",
    });
    expect(response.status).toBe(200);

    const row = await env.FEED_DB.prepare(
      "SELECT email, username, displayUsername FROM auth_user WHERE username = ?",
    ).bind("zhang.san").first<{
      displayUsername: string;
      email: string;
      username: string;
    }>();
    // The plugin lowercases the stored username and keeps the typed casing for
    // display; the address is the synthesised placeholder.
    expect(row).toMatchObject({
      displayUsername: "Zhang.San",
      email: adminUsernameEmail("zhang.san"),
      username: "zhang.san",
    });
  });

  it("signs in with the username, ignoring case", async () => {
    await createAccount({
      account: "zhang.san",
      name: "Zhang San",
      password: "secret1",
    });
    const result = await auth().api.signInUsername({
      body: {password: "secret1", username: "ZHANG.SAN"},
    });
    expect(result?.user?.email).toBe(adminUsernameEmail("zhang.san"));
  });

  it("refuses a username that is already taken", async () => {
    await createAccount({account: "taken", name: "First", password: "secret1"});
    const again = await createAccount({
      account: "TAKEN",
      name: "Second",
      password: "secret1",
    });
    expect(again.status).toBe(409);
  });

  it("still creates an address account, and signs in by address", async () => {
    // The legacy `email` key is still accepted, so an older dashboard build
    // keeps working against this endpoint.
    const response = await createAccount({
      email: "Person@Example.com",
      name: "Person",
      password: "secret1",
    });
    expect(response.status).toBe(200);

    const row = await env.FEED_DB.prepare(
      'SELECT id, username FROM "auth_user" WHERE email = ?',
    ).bind("person@example.com").first<{id: string; username: string | null}>();
    expect(row?.username).toBeNull();

    const result = await auth().api.signInEmail({
      body: {email: "person@example.com", password: "secret1"},
    });
    expect(result?.user?.id).toBe(row?.id);
  });

  it("rejects a malformed account or a weak password", async () => {
    const spaced = await createAccount({
      account: "has space",
      name: "X",
      password: "secret1",
    });
    expect(spaced.status).toBe(400);

    const badAddress = await createAccount({
      account: "not-an-address@",
      name: "X",
      password: "secret1",
    });
    expect(badAddress.status).toBe(400);

    const weakPassword = await createAccount({
      account: "valid.name",
      name: "X",
      password: "abc",
    });
    expect(weakPassword.status).toBe(400);
  });
});
