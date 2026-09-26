import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

import {createAdminRbacUser, readRbacUsers, resetAdminRbacUserPassword, updateAdminRbacUserProfile} from "@/server/admin/rbac-handlers";
import {createMicrofeedAuth} from "@/server/auth/better-auth";
import {handleAdminBootstrap} from "@/server/auth/bootstrap";
import {normalizeAdminEmail} from "@/shared/AdminCredentials";

const ORIGIN = "https://feed.example.com";
const ADMIN = `${ORIGIN}/admin`;
const SETUP_PASSWORD = "Correct horse battery staple";
const CREATE_URL = `${ADMIN}/ajax/rbac/user-create`;
const RESET_URL = `${ADMIN}/ajax/rbac/user-password-reset`;
const PROFILE_URL = `${ADMIN}/ajax/rbac/user-profile`;

/** Minimal `App.Locals` shape the RBAC guard reads. */
function locals(userId: string, permissions: string[] = [], sessionId?: string) {
  return {
    authUser: {id: userId, role: null},
    // Present in production (middleware stores it); handlers read
    // `authSession.id` to keep the performing session on a self-reset.
    ...(sessionId ? {authSession: {id: sessionId, userId}} : {}),
    rbacBanned: false,
    rbacDeviceRevoked: false,
    rbacMustChangePassword: false,
    rbacPermissions: new Set(permissions),
  };
}

/**
 * Bootstrap the deployment's first super-admin and sign in to obtain a session
 * cookie. The RBAC handlers re-invoke Better Auth's admin plugin, which gates on
 * the *session* (not on `locals`), so every authenticated call must carry this
 * cookie — the fake `locals` only satisfies our own `requireRbac` gate.
 */
async function bootstrapAndSignIn(): Promise<{adminId: string; cookie: string}> {
  await handleAdminBootstrap(
    {
      FEED_DB: env.FEED_DB,
      MICROFEED_SETUP_ADMIN_EMAIL: " Admin@Example.com ",
      MICROFEED_SETUP_ADMIN_PASSWORD: SETUP_PASSWORD,
      MICROFEED_SETUP_ADMIN_PASSWORD_CONFIRMATION: SETUP_PASSWORD,
    },
    new Request(`${ORIGIN}/.well-known/microfeed/bootstrap-admin/`, {method: "POST"}),
  );
  const adminId = (await env.FEED_DB.prepare('SELECT id FROM "auth_user"')
    .first<{id: string}>())!.id;
  const signInRequest = new Request(`${ORIGIN}/api/auth/sign-in/email`, {
    body: JSON.stringify({email: "admin@example.com", password: SETUP_PASSWORD}),
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
    },
    method: "POST",
  });
  const signIn = await createMicrofeedAuth(env, signInRequest).handler(signInRequest);
  const cookie = signIn.headers.getSetCookie().map((entry) => entry.split(";")[0])
    .join("; ");
  return {adminId, cookie};
}

function authedRequest(url: string, body: unknown, cookie: string): Request {
  return new Request(url, {
    body: JSON.stringify(body),
    headers: {cookie, "content-type": "application/json", origin: ORIGIN},
    method: "POST",
  });
}

/** Create an account through the handler and return its board row. */
async function createUser(
  account: string,
  name: string,
  password: string,
  cookie: string,
  adminId: string,
): Promise<{id: string; email: string; username?: string}> {
  const created = await createAdminRbacUser({
    locals: locals(adminId, ["system:user:manage"]),
    request: authedRequest(CREATE_URL, {account, name, password, roles: ["readonly"]}, cookie),
  } as never);
  expect(created.status).toBe(200);
  const board = await created.json() as {
    users: {email: string; id: string; username?: string}[];
  };
  const normalized = normalizeAdminEmail(account);
  const user = board.users.find(
    (entry) => entry.username === account.toLowerCase() || entry.email === normalized,
  );
  if (!user) throw new Error("account was not created");
  return user;
}

/** Try to sign in; returns whether the password was accepted. */
async function trySignIn(identifier: string, password: string): Promise<boolean> {
  const path = identifier.includes("@")
    ? "/api/auth/sign-in/email"
    : "/api/auth/sign-in/username";
  const body = identifier.includes("@")
    ? {email: identifier, password}
    : {username: identifier, password};
  const request = new Request(`${ORIGIN}${path}`, {
    body: JSON.stringify(body),
    headers: {"content-type": "application/json", origin: ORIGIN},
    method: "POST",
  });
  try {
    const response = await createMicrofeedAuth(env, request).handler(request);
    return response.status === 200;
  } catch {
    return false;
  }
}

/** Sign in and return the session cookie, or null if it failed. */
async function signInCookie(identifier: string, password: string): Promise<string | null> {
  const path = identifier.includes("@")
    ? "/api/auth/sign-in/email"
    : "/api/auth/sign-in/username";
  const body = identifier.includes("@")
    ? {email: identifier, password}
    : {username: identifier, password};
  const request = new Request(`${ORIGIN}${path}`, {
    body: JSON.stringify(body),
    headers: {"content-type": "application/json", origin: ORIGIN},
    method: "POST",
  });
  const response = await createMicrofeedAuth(env, request).handler(request);
  if (response.status !== 200) return null;
  return response.headers.getSetCookie().map((entry) => entry.split(";")[0]).join("; ");
}

/** True when the session cookie still resolves a valid Better Auth session. */
async function sessionValid(cookie: string): Promise<boolean> {
  const request = new Request(`${ORIGIN}/api/auth/get-session`, {
    headers: {cookie, origin: ORIGIN},
    method: "GET",
  });
  const response = await createMicrofeedAuth(env, request).handler(request);
  if (response.status !== 200) return false;
  // `/get-session` returns 200 whether or not a session exists; a revoked
  // session yields an empty body (or `session: null`), so read the body.
  const text = await response.text();
  if (!text) return false;
  try {
    const json = JSON.parse(text) as {session?: unknown};
    return json.session != null;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  await env.FEED_DB.batch([
    env.FEED_DB.prepare('DELETE FROM "auth_rate_limit"'),
    env.FEED_DB.prepare('DELETE FROM "auth_session"'),
    env.FEED_DB.prepare('DELETE FROM "auth_account"'),
    env.FEED_DB.prepare('DELETE FROM "auth_user"'),
    env.FEED_DB.prepare("DELETE FROM ext_user_roles"),
    env.FEED_DB.prepare("DELETE FROM ext_user_devices"),
    env.FEED_DB.prepare("DELETE FROM ext_user_security"),
    env.FEED_DB.prepare("DELETE FROM ext_replay_nonces"),
    // Children before the parent `oauth_client` so the cleanup order is safe
    // even if foreign-key enforcement is on.
    env.FEED_DB.prepare('DELETE FROM "oauth_access_token"'),
    env.FEED_DB.prepare('DELETE FROM "oauth_refresh_token"'),
    env.FEED_DB.prepare('DELETE FROM "oauth_consent"'),
    env.FEED_DB.prepare('DELETE FROM "oauth_connection"'),
    env.FEED_DB.prepare('DELETE FROM "ext_login_credentials"'),
    env.FEED_DB.prepare('DELETE FROM "oauth_client"'),
  ]);
});

/** Count rows in a derived-credential table owned by `userId`. */
async function countUserRows(table: string, column: string, userId: string): Promise<number> {
  const row = await env.FEED_DB.prepare(
    `SELECT COUNT(*) AS n FROM "${table}" WHERE "${column}" = ?`,
  ).bind(userId).first<{n: number}>();
  return row?.n ?? 0;
}

/** Stand up a minimal OAuth client and grant it to `userId` (one connection + token). */
async function grantOAuthApp(userId: string, clientId: string): Promise<void> {
  const now = new Date().toISOString();
  await env.FEED_DB.batch([
    env.FEED_DB.prepare(
      'INSERT INTO "oauth_client" ("id", "clientId", "redirectUris") VALUES (?, ?, ?)',
    ).bind(clientId, clientId, "https://app.example.com/callback"),
    env.FEED_DB.prepare(
      'INSERT INTO "oauth_connection" ("id", "clientId", "userId", "name", "createdAt", ' +
      '"updatedAt") VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(`conn_${clientId}`, clientId, userId, "Test App", now, now),
    env.FEED_DB.prepare(
      'INSERT INTO "oauth_access_token" ("id", "token", "clientId", "userId", ' +
      '"expiresAt", "createdAt", "scopes") VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      `tok_${clientId}`,
      `secret_${clientId}`,
      clientId,
      userId,
      new Date(Date.now() + 3_600_000).toISOString(),
      now,
      "read",
    ),
  ]);
}

/** Issue an `mflc_` login credential (API key) for `userId`. */
async function issueLoginCredential(userId: string, secretHash: string): Promise<void> {
  await env.FEED_DB.prepare(
    'INSERT INTO "ext_login_credentials" ("id", "user_id", "name", "secret", ' +
    '"secret_hash", "created_at_ms") VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(`lc_${secretHash}`, userId, "API Key", "mflc_test", secretHash, Date.now()).run();
}

describe("readRbacUsers exposes username", () => {
  it("returns the username for username accounts and nothing for email accounts", async () => {
    const {adminId, cookie} = await bootstrapAndSignIn();
    const byName = await createUser("alice", "Alice", "Pass1234", cookie, adminId);
    expect(byName.username).toBe("alice");

    const byEmail = await createUser("bob@example.com", "Bob", "Pass1234", cookie, adminId);
    expect(byEmail.username).toBeUndefined();

    const board = await readRbacUsers(env.FEED_DB);
    const alice = board.users.find((entry) => entry.id === byName.id);
    const bob = board.users.find((entry) => entry.id === byEmail.id);
    expect(alice?.username).toBe("alice");
    expect(bob?.username).toBeUndefined();
  });
});

describe("password reset (admin-set)", () => {
  it("resets the password and rejects the old one afterwards", async () => {
    const {adminId, cookie} = await bootstrapAndSignIn();
    const user = await createUser("pw@example.com", "PW", "OldPass123", cookie, adminId);
    expect(await trySignIn("pw@example.com", "OldPass123")).toBe(true);

    const response = await resetAdminRbacUserPassword({
      locals: locals(adminId, ["system:user:manage"]),
      request: authedRequest(RESET_URL, {newPassword: "NewPass456", userId: user.id}, cookie),
    } as never);
    expect(response.status).toBe(200);

    expect(await trySignIn("pw@example.com", "NewPass456")).toBe(true);
    expect(await trySignIn("pw@example.com", "OldPass123")).toBe(false);
  });

  it("rejects a password that fails the combination policy", async () => {
    const {adminId, cookie} = await bootstrapAndSignIn();
    const user = await createUser("weak@example.com", "Weak", "Pass1234", cookie, adminId);
    const response = await resetAdminRbacUserPassword({
      locals: locals(adminId, ["system:user:manage"]),
      request: authedRequest(RESET_URL, {newPassword: "abc", userId: user.id}, cookie),
    } as never);
    expect(response.status).toBe(400);
  });

  it("resets a username-only account and rejects the old password", async () => {
    const {adminId, cookie} = await bootstrapAndSignIn();
    const user = await createUser("dave", "Dave", "OldPass123", cookie, adminId);
    expect(user.username).toBe("dave");
    expect(await trySignIn("dave", "OldPass123")).toBe(true);

    const response = await resetAdminRbacUserPassword({
      locals: locals(adminId, ["system:user:manage"]),
      request: authedRequest(RESET_URL, {newPassword: "NewPass456", userId: user.id}, cookie),
    } as never);
    expect(response.status).toBe(200);

    expect(await trySignIn("dave", "NewPass456")).toBe(true);
    expect(await trySignIn("dave", "OldPass123")).toBe(false);
  });

  it("revokes the target's existing session on reset", async () => {
    const {adminId, cookie} = await bootstrapAndSignIn();
    const user = await createUser("revoke@example.com", "Revoke", "OldPass123", cookie, adminId);
    const targetCookie = await signInCookie("revoke@example.com", "OldPass123");
    expect(targetCookie).toBeTruthy();
    expect(await sessionValid(targetCookie!)).toBe(true);

    const response = await resetAdminRbacUserPassword({
      locals: locals(adminId, ["system:user:manage"]),
      request: authedRequest(RESET_URL, {newPassword: "NewPass456", userId: user.id}, cookie),
    } as never);
    expect(response.status).toBe(200);

    expect(await sessionValid(targetCookie!)).toBe(false);
  });

  it("returns 404 for an unknown user", async () => {
    const {adminId, cookie} = await bootstrapAndSignIn();
    const response = await resetAdminRbacUserPassword({
      locals: locals(adminId, ["system:user:manage"]),
      request: authedRequest(RESET_URL, {newPassword: "NewPass456", userId: "ghost"}, cookie),
    } as never);
    expect(response.status).toBe(404);
  });

  it("revokes the target's OAuth app access on reset", async () => {
    const {adminId, cookie} = await bootstrapAndSignIn();
    const user = await createUser("oauth@example.com", "OAuth", "OldPass123", cookie, adminId);
    await grantOAuthApp(user.id, "client_rev");
    expect(await countUserRows("oauth_connection", "userId", user.id)).toBe(1);
    expect(await countUserRows("oauth_access_token", "userId", user.id)).toBe(1);

    const response = await resetAdminRbacUserPassword({
      locals: locals(adminId, ["system:user:manage"]),
      request: authedRequest(RESET_URL, {newPassword: "NewPass456", userId: user.id}, cookie),
    } as never);
    expect(response.status).toBe(200);

    // The grant and its token are gone, but the account itself still signs in.
    expect(await countUserRows("oauth_connection", "userId", user.id)).toBe(0);
    expect(await countUserRows("oauth_access_token", "userId", user.id)).toBe(0);
    expect(await trySignIn("oauth@example.com", "NewPass456")).toBe(true);
  });

  it("revokes the target's login credentials on reset", async () => {
    const {adminId, cookie} = await bootstrapAndSignIn();
    const user = await createUser("lc@example.com", "LC", "OldPass123", cookie, adminId);
    await issueLoginCredential(user.id, "hash_rev");
    expect(await countUserRows("ext_login_credentials", "user_id", user.id)).toBe(1);

    const response = await resetAdminRbacUserPassword({
      locals: locals(adminId, ["system:user:manage"]),
      request: authedRequest(RESET_URL, {newPassword: "NewPass456", userId: user.id}, cookie),
    } as never);
    expect(response.status).toBe(200);

    expect(await countUserRows("ext_login_credentials", "user_id", user.id)).toBe(0);
  });

  it("keeps the performing session when the admin resets their own account", async () => {
    const {adminId, cookie} = await bootstrapAndSignIn();
    await grantOAuthApp(adminId, "client_self");
    await issueLoginCredential(adminId, "hash_self");
    const session = await env.FEED_DB.prepare(
      'SELECT id FROM "auth_session" WHERE "userId" = ?',
    ).bind(adminId).first<{id: string}>();
    expect(session).toBeTruthy();

    const response = await resetAdminRbacUserPassword({
      locals: locals(adminId, ["system:user:manage"], session!.id),
      request: authedRequest(RESET_URL, {newPassword: "NewPass456", userId: adminId}, cookie),
    } as never);
    expect(response.status).toBe(200);

    // The request's own session survives the reset; every other derived
    // credential (other sessions, OAuth grants, login credentials) is gone.
    expect(await sessionValid(cookie)).toBe(true);
    expect(await countUserRows("oauth_connection", "userId", adminId)).toBe(0);
    expect(await countUserRows("oauth_access_token", "userId", adminId)).toBe(0);
    expect(await countUserRows("ext_login_credentials", "user_id", adminId)).toBe(0);
  });
});

describe("profile edit (name / email)", () => {
  it("updates the display name and reflects it in the board", async () => {
    const {adminId, cookie} = await bootstrapAndSignIn();
    const user = await createUser("name@example.com", "Old", "Pass1234", cookie, adminId);
    const response = await updateAdminRbacUserProfile({
      locals: locals(adminId, ["system:user:manage"]),
      request: authedRequest(PROFILE_URL, {name: "New Name", userId: user.id}, cookie),
    } as never);
    expect(response.status).toBe(200);
    const board = await response.json() as {users: {id: string; name: string}[]};
    expect(board.users.find((entry) => entry.id === user.id)?.name).toBe("New Name");
  });

  it("changes an email account's address", async () => {
    const {adminId, cookie} = await bootstrapAndSignIn();
    const user = await createUser("mail@example.com", "Mail", "Pass1234", cookie, adminId);
    const response = await updateAdminRbacUserProfile({
      locals: locals(adminId, ["system:user:manage"]),
      request: authedRequest(PROFILE_URL, {email: "mail2@example.com", userId: user.id}, cookie),
    } as never);
    expect(response.status).toBe(200);
    const board = await response.json() as {users: {id: string; email: string}[]};
    expect(board.users.find((entry) => entry.id === user.id)?.email).toBe(
      "mail2@example.com",
    );
  });

  it("rejects a duplicate email with 409", async () => {
    const {adminId, cookie} = await bootstrapAndSignIn();
    await createUser("dup1@example.com", "One", "Pass1234", cookie, adminId);
    const dup2 = await createUser("dup2@example.com", "Two", "Pass1234", cookie, adminId);
    const response = await updateAdminRbacUserProfile({
      locals: locals(adminId, ["system:user:manage"]),
      request: authedRequest(PROFILE_URL, {email: "dup1@example.com", userId: dup2.id}, cookie),
    } as never);
    expect(response.status).toBe(409);
  });

  it("rejects a duplicate email regardless of case with 409", async () => {
    const {adminId, cookie} = await bootstrapAndSignIn();
    await createUser("case1@example.com", "One", "Pass1234", cookie, adminId);
    const other = await createUser("case2@example.com", "Two", "Pass1234", cookie, adminId);
    const response = await updateAdminRbacUserProfile({
      locals: locals(adminId, ["system:user:manage"]),
      request: authedRequest(PROFILE_URL, {email: "CASE1@example.com", userId: other.id}, cookie),
    } as never);
    expect(response.status).toBe(409);
  });

  it("rejects an invalid email with 400", async () => {
    const {adminId, cookie} = await bootstrapAndSignIn();
    const user = await createUser("valid@example.com", "Valid", "Pass1234", cookie, adminId);
    const response = await updateAdminRbacUserProfile({
      locals: locals(adminId, ["system:user:manage"]),
      request: authedRequest(PROFILE_URL, {email: "not-an-email", userId: user.id}, cookie),
    } as never);
    expect(response.status).toBe(400);
  });

  it("rejects an empty display name with 400", async () => {
    const {adminId, cookie} = await bootstrapAndSignIn();
    const user = await createUser("empty@example.com", "Empty", "Pass1234", cookie, adminId);
    const response = await updateAdminRbacUserProfile({
      locals: locals(adminId, ["system:user:manage"]),
      request: authedRequest(PROFILE_URL, {name: "", userId: user.id}, cookie),
    } as never);
    expect(response.status).toBe(400);
  });

  it("returns 404 for an unknown user", async () => {
    const {adminId, cookie} = await bootstrapAndSignIn();
    const response = await updateAdminRbacUserProfile({
      locals: locals(adminId, ["system:user:manage"]),
      request: authedRequest(PROFILE_URL, {name: "x", userId: "ghost"}, cookie),
    } as never);
    expect(response.status).toBe(404);
  });
});

/**
 * Create an account through the split `username` / `email` fields (the shape
 * the form now sends), and return the raw response.
 */
async function createUserSplit(
  fields: {email?: string; name: string; password: string; username: string},
  cookie: string,
  adminId: string,
): Promise<Response> {
  return createAdminRbacUser({
    locals: locals(adminId, ["system:user:manage"]),
    request: authedRequest(CREATE_URL, {...fields, roles: ["readonly"]}, cookie),
  } as never);
}

/** The board row for a newly created account, matched on its username. */
async function boardUserByUsername(
  response: Response,
  username: string,
): Promise<{email: string; id: string; username?: string}> {
  const board = await response.json() as {
    users: {email: string; id: string; username?: string}[];
  };
  const entry = board.users.find((row) => row.username === username);
  if (!entry) throw new Error("account was not created");
  return entry;
}

describe("create with separate username and email fields", () => {
  it("creates a username-only account with a placeholder address", async () => {
    const {adminId, cookie} = await bootstrapAndSignIn();
    const response = await createUserSplit(
      {name: "Solo", password: "Pass1234", username: "solo"},
      cookie,
      adminId,
    );
    expect(response.status).toBe(200);
    const created = await boardUserByUsername(response, "solo");
    expect(created.email).toBe("solo@users.microfeed.local");
    expect(await trySignIn("solo", "Pass1234")).toBe(true);
  });

  it("creates an account with both and signs in either way", async () => {
    const {adminId, cookie} = await bootstrapAndSignIn();
    const response = await createUserSplit(
      {email: "both@example.com", name: "Both", password: "Pass1234", username: "both"},
      cookie,
      adminId,
    );
    expect(response.status).toBe(200);
    const created = await boardUserByUsername(response, "both");
    expect(created.email).toBe("both@example.com");
    expect(await trySignIn("both", "Pass1234")).toBe(true);
    expect(await trySignIn("both@example.com", "Pass1234")).toBe(true);
  });

  it("rejects an address in the reserved placeholder domain", async () => {
    const {adminId, cookie} = await bootstrapAndSignIn();
    const response = await createUserSplit(
      {
        email: "claim@users.microfeed.local",
        name: "Claim",
        password: "Pass1234",
        username: "claim",
      },
      cookie,
      adminId,
    );
    expect(response.status).toBe(400);
  });

  it("rejects a duplicate username regardless of case", async () => {
    const {adminId, cookie} = await bootstrapAndSignIn();
    const first = await createUserSplit(
      {name: "One", password: "Pass1234", username: "dupname"},
      cookie,
      adminId,
    );
    expect(first.status).toBe(200);
    const second = await createUserSplit(
      {name: "Two", password: "Pass1234", username: "DUPNAME"},
      cookie,
      adminId,
    );
    expect(second.status).toBe(409);
  });

  it("rejects a duplicate email", async () => {
    const {adminId, cookie} = await bootstrapAndSignIn();
    const first = await createUserSplit(
      {email: "clash@example.com", name: "One", password: "Pass1234", username: "one1"},
      cookie,
      adminId,
    );
    expect(first.status).toBe(200);
    const second = await createUserSplit(
      {email: "CLASH@example.com", name: "Two", password: "Pass1234", username: "two2"},
      cookie,
      adminId,
    );
    expect(second.status).toBe(409);
  });

  it("keeps the legacy address-only field working (older dashboard builds)", async () => {
    const {adminId, cookie} = await bootstrapAndSignIn();
    const response = await createAdminRbacUser({
      locals: locals(adminId, ["system:user:manage"]),
      request: authedRequest(CREATE_URL, {
        email: "legacyonly@example.com",
        name: "LegacyOnly",
        password: "Pass1234",
        roles: ["readonly"],
      }, cookie),
    } as never);
    expect(response.status).toBe(200);
    const board = await response.json() as {
      users: {email: string; username?: string}[];
    };
    const created = board.users.find(
      (entry) => entry.email === "legacyonly@example.com",
    );
    expect(created).toBeTruthy();
    // No username was sent, so none is stored: the account signs in by address.
    expect(created?.username).toBeUndefined();
  });

  it("rejects a legacy address-only create that reuses an address", async () => {
    const {adminId, cookie} = await bootstrapAndSignIn();
    await createUser("takenlegacy@example.com", "First", "Pass1234", cookie, adminId);
    // The legacy shape (no `username`) must be refused with the same precise
    // 409, not left to the write to fail on the UNIQUE constraint.
    const response = await createAdminRbacUser({
      locals: locals(adminId, ["system:user:manage"]),
      request: authedRequest(CREATE_URL, {
        email: "TAKENLEGACY@example.com",
        name: "Second",
        password: "Pass1234",
        roles: ["readonly"],
      }, cookie),
    } as never);
    expect(response.status).toBe(409);
  });

  it("rejects a create reusing an address a username-only account holds", async () => {
    const {adminId, cookie} = await bootstrapAndSignIn();
    await createUserSplit({name: "Holder", password: "Pass1234", username: "slot"}, cookie, adminId);
    // `slot@users.microfeed.local` is that account's placeholder address, so
    // handing it to another account would silently steal its login slot.
    const response = await createUserSplit(
      {email: "slot@users.microfeed.local", name: "Thief", password: "Pass1234", username: "thief"},
      cookie,
      adminId,
    );
    expect(response.status).toBe(400);
  });

  it("rejects a create with neither a username nor an address", async () => {
    const {adminId, cookie} = await bootstrapAndSignIn();
    const response = await createAdminRbacUser({
      locals: locals(adminId, ["system:user:manage"]),
      request: authedRequest(CREATE_URL, {
        name: "Nothing",
        password: "Pass1234",
        roles: ["readonly"],
      }, cookie),
    } as never);
    expect(response.status).toBe(400);
  });
});

describe("setting a username on an address-only account", () => {
  it("sets it once, then locks it", async () => {
    const {adminId, cookie} = await bootstrapAndSignIn();
    const user = await createUser("legacy@example.com", "Legacy", "Pass1234", cookie, adminId);
    expect(user.username).toBeUndefined();

    const response = await updateAdminRbacUserProfile({
      locals: locals(adminId, ["system:user:manage"]),
      request: authedRequest(PROFILE_URL, {userId: user.id, username: "legacyuser"}, cookie),
    } as never);
    expect(response.status).toBe(200);
    const board = await response.json() as {
      users: {id: string; username?: string}[];
    };
    expect(board.users.find((entry) => entry.id === user.id)?.username).toBe(
      "legacyuser",
    );
    expect(await trySignIn("legacyuser", "Pass1234")).toBe(true);

    // A second attempt is refused: the username is the login identifier, so it
    // is not silently swapped out from under existing sessions.
    const locked = await updateAdminRbacUserProfile({
      locals: locals(adminId, ["system:user:manage"]),
      request: authedRequest(PROFILE_URL, {userId: user.id, username: "replaced"}, cookie),
    } as never);
    expect(locked.status).toBe(400);
  });

  it("rejects a username another account already holds", async () => {
    const {adminId, cookie} = await bootstrapAndSignIn();
    await createUserSplit({name: "Holder", password: "Pass1234", username: "holder"}, cookie, adminId);
    const legacy = await createUser("older@example.com", "Older", "Pass1234", cookie, adminId);
    const response = await updateAdminRbacUserProfile({
      locals: locals(adminId, ["system:user:manage"]),
      request: authedRequest(PROFILE_URL, {userId: legacy.id, username: "Holder"}, cookie),
    } as never);
    expect(response.status).toBe(409);
  });

  it("rejects a username that differs only by case from a taken one", async () => {
    const {adminId, cookie} = await bootstrapAndSignIn();
    await createUserSplit({name: "Holder", password: "Pass1234", username: "casesens"}, cookie, adminId);
    const legacy = await createUser("older2@example.com", "Older2", "Pass1234", cookie, adminId);
    const response = await updateAdminRbacUserProfile({
      locals: locals(adminId, ["system:user:manage"]),
      request: authedRequest(PROFILE_URL, {userId: legacy.id, username: "CASESENS"}, cookie),
    } as never);
    expect(response.status).toBe(409);
  });

  it("rejects moving an address into the reserved domain", async () => {
    const {adminId, cookie} = await bootstrapAndSignIn();
    const user = await createUser("move@example.com", "Move", "Pass1234", cookie, adminId);
    const response = await updateAdminRbacUserProfile({
      locals: locals(adminId, ["system:user:manage"]),
      request: authedRequest(
        PROFILE_URL,
        {email: "move@users.microfeed.local", userId: user.id},
        cookie,
      ),
    } as never);
    expect(response.status).toBe(400);
  });
});

describe("authorization", () => {
  it("forbids profile edits without system:user:manage", async () => {
    const {adminId, cookie} = await bootstrapAndSignIn();
    const user = await createUser("perm@example.com", "Perm", "Pass1234", cookie, adminId);
    // No `system:user:manage` in the locals => the gate refuses before Better Auth.
    const denied = await updateAdminRbacUserProfile({
      locals: locals("someone"),
      request: authedRequest(PROFILE_URL, {name: "x", userId: user.id}, cookie),
    } as never);
    expect(denied.status).toBe(403);
  });
});
