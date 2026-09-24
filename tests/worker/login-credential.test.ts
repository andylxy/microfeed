import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

import {
  createAdminRbacUserCredential,
  getAdminRbacUserCredentials,
  revokeAdminRbacUserCredential,
} from "@/server/admin/rbac-handlers";
import {writeApiAccessLog} from "@/server/api/access";
import {decideLoginCredentialApiRequest} from "@/server/api/credential-bearer";
import {createMicrofeedAuth} from "@/server/auth/better-auth";
import {
  handleCredentialLogin,
  isAdminCredentialLoginPath,
} from "@/server/auth/credential-login";
import {
  countLoginCredentialsForUser,
  createLoginCredential,
  listLoginCredentialsForUser,
  markLoginCredentialUsed,
  revokeLoginCredential,
  verifyLoginCredentialToken,
} from "@/server/auth/login-credentials";
import {createLoginSessionCookies} from "@/server/auth/login-session";
import {LOGIN_THROTTLE_MAX_ATTEMPTS} from "@/server/auth/login-throttle";
import {MAX_LOGIN_CREDENTIALS_PER_USER} from "@/shared/LoginCredential";

const ORIGIN = "https://feed.example.com";
const ADMIN = `${ORIGIN}/admin`;
const LOGIN_URL = `${ADMIN}/ajax/auth/credential-login`;
const CREDS_URL = `${ADMIN}/ajax/rbac/user-credentials`;
const CREATE_URL = `${ADMIN}/ajax/rbac/user-credential-create`;
const REVOKE_URL = `${ADMIN}/ajax/rbac/user-credential-revoke`;

/** Minimal `App.Locals` shape the RBAC guard reads. */
function locals(userId: string, permissions: string[] = []) {
  return {
    authUser: {id: userId, role: null},
    rbacBanned: false,
    rbacDeviceRevoked: false,
    rbacMustChangePassword: false,
    rbacPermissions: new Set(permissions),
  };
}

async function seedUser(id: string, role = "user", banned = 0): Promise<void> {
  await env.FEED_DB.prepare(
    'INSERT INTO "auth_user" (id, name, email, emailVerified, createdAt, updatedAt, role, banned) ' +
      "VALUES (?, ?, ?, 1, '2024-01-01', '2024-01-01', ?, ?)",
  ).bind(id, id.toUpperCase(), `${id}@example.com`, role, banned).run();
}

async function grantRole(userId: string, roleId: string): Promise<void> {
  await env.FEED_DB.prepare(
    "INSERT OR IGNORE INTO ext_user_roles (user_id, role_id) VALUES (?, ?)",
  ).bind(userId, roleId).run();
}

beforeEach(async () => {
  await env.FEED_DB.batch([
    env.FEED_DB.prepare("DELETE FROM ext_api_access_log"),
    env.FEED_DB.prepare("DELETE FROM ext_login_credential_attempts"),
    env.FEED_DB.prepare("DELETE FROM ext_login_credentials"),
    env.FEED_DB.prepare("DELETE FROM ext_user_roles"),
    env.FEED_DB.prepare("DELETE FROM ext_replay_nonces"),
    env.FEED_DB.prepare('DELETE FROM "auth_session"'),
    env.FEED_DB.prepare('DELETE FROM "auth_user"'),
  ]);
});

describe("login credential storage", () => {
  it("issues a re-displayable token and lists it", async () => {
    await seedUser("u1");
    const created = await createLoginCredential(env.FEED_DB, {
      name: "CI deploy",
      userId: "u1",
    });
    expect(created.secret.startsWith("mflc_")).toBe(true);
    expect(created.revoked).toBe(false);
    expect(created.expiresAtMs).toBeNull();

    const list = await listLoginCredentialsForUser(env.FEED_DB, "u1");
    expect(list).toHaveLength(1);
    // The token is re-readable by design, not shown-once.
    expect(list[0]?.secret).toBe(created.secret);
  });

  it("verifies a live token and rejects revoked / expired / unknown", async () => {
    await seedUser("u1");
    const live = await createLoginCredential(env.FEED_DB, {
      name: "live",
      userId: "u1",
    });
    await expect(verifyLoginCredentialToken(env.FEED_DB, live.secret))
      .resolves.toEqual({credentialId: live.id, userId: "u1"});

    const revoked = await createLoginCredential(env.FEED_DB, {
      name: "revoked",
      userId: "u1",
    });
    await revokeLoginCredential(env.FEED_DB, "u1", revoked.id);
    await expect(verifyLoginCredentialToken(env.FEED_DB, revoked.secret))
      .resolves.toBeNull();

    const expired = await createLoginCredential(env.FEED_DB, {
      expiresAtMs: Date.now() - 1_000,
      name: "expired",
      userId: "u1",
    });
    await expect(verifyLoginCredentialToken(env.FEED_DB, expired.secret))
      .resolves.toBeNull();

    await expect(verifyLoginCredentialToken(env.FEED_DB, "mflc_deadbeef"))
      .resolves.toBeNull();
    // A plain API key is not a login credential.
    await expect(verifyLoginCredentialToken(env.FEED_DB, "mf_abc"))
      .resolves.toBeNull();
  });

  it("caps a user at the configured maximum and frees a slot on revoke", async () => {
    await seedUser("u1");
    const issued = [];
    for (let index = 0; index < MAX_LOGIN_CREDENTIALS_PER_USER; index += 1) {
      issued.push(
        await createLoginCredential(env.FEED_DB, {
          name: `c${index}`,
          userId: "u1",
        }),
      );
    }
    await expect(
      createLoginCredential(env.FEED_DB, {name: "over", userId: "u1"}),
    ).rejects.toThrow();
    expect(await countLoginCredentialsForUser(env.FEED_DB, "u1")).toBe(
      MAX_LOGIN_CREDENTIALS_PER_USER,
    );

    await revokeLoginCredential(env.FEED_DB, "u1", issued[0]!.id);
    await expect(
      createLoginCredential(env.FEED_DB, {name: "after revoke", userId: "u1"}),
    ).resolves.toBeTruthy();
  });
});

describe("login session cookie", () => {
  it("is accepted back by better-auth getSession", async () => {
    await seedUser("u_cookie");
    const cookies = await createLoginSessionCookies(
      env,
      new Request(LOGIN_URL),
      "u_cookie",
    );
    expect(cookies).toHaveLength(1);
    const cookiePair = cookies[0]!.split(";")[0]!;
    const auth = createMicrofeedAuth(env, new Request(LOGIN_URL));
    const session = await auth.api.getSession({
      headers: new Headers({cookie: cookiePair}),
    });
    expect(session?.user?.id).toBe("u_cookie");
  });
});

describe("user-credential endpoints", () => {
  it("lets a caller manage their own credentials without the manage grant", async () => {
    await seedUser("u_self");
    const response = await createAdminRbacUserCredential({
      locals: locals("u_self"),
      request: new Request(CREATE_URL, {
        body: JSON.stringify({name: "self"}),
        headers: {origin: ORIGIN},
        method: "POST",
      }),
    } as never);
    expect(response.status).toBe(201);
    const board = await response.json() as {
      credentials: unknown[];
      userId: string;
    };
    expect(board.userId).toBe("u_self");
    expect(board.credentials).toHaveLength(1);
  });

  it("requires system:user:manage to manage another account", async () => {
    await seedUser("u_admin");
    await seedUser("u_other");
    const payload = {name: "x", userId: "u_other"};

    const denied = await createAdminRbacUserCredential({
      locals: locals("u_admin"),
      request: new Request(CREATE_URL, {
        body: JSON.stringify(payload),
        method: "POST",
      }),
    } as never);
    expect(denied.status).toBe(403);

    const allowed = await createAdminRbacUserCredential({
      locals: locals("u_admin", ["system:user:manage"]),
      request: new Request(CREATE_URL, {
        body: JSON.stringify(payload),
        method: "POST",
      }),
    } as never);
    expect(allowed.status).toBe(201);
  });

  it("lists and revokes through the endpoints", async () => {
    await seedUser("u_admin");
    const perms = ["system:user:manage"];
    await createAdminRbacUserCredential({
      locals: locals("u_admin", perms),
      request: new Request(CREATE_URL, {
        body: JSON.stringify({name: "k"}),
        method: "POST",
      }),
    } as never);

    const listed = await getAdminRbacUserCredentials({
      locals: locals("u_admin", perms),
      request: new Request(CREDS_URL, {method: "GET"}),
      url: new URL(CREDS_URL),
    } as never);
    const board = await listed.json() as {
      credentials: {id: string; revoked: boolean}[];
    };
    expect(board.credentials).toHaveLength(1);

    const revoked = await revokeAdminRbacUserCredential({
      locals: locals("u_admin", perms),
      request: new Request(REVOKE_URL, {
        body: JSON.stringify({credentialId: board.credentials[0]!.id}),
        method: "POST",
      }),
    } as never);
    const after = await revoked.json() as {credentials: {revoked: boolean}[]};
    expect(after.credentials[0]?.revoked).toBe(true);
  });
});

describe("credential sign-in endpoint", () => {
  it("recognizes its own path", () => {
    // `adminUrl` always adds a trailing slash, so the real pathname has one.
    expect(
      isAdminCredentialLoginPath("/admin/ajax/auth/credential-login/", "admin"),
    ).toBe(true);
    expect(isAdminCredentialLoginPath("/admin/ajax/rbac/users/", "admin")).toBe(
      false,
    );
  });

  it("exchanges a body token for a cookie better-auth accepts", async () => {
    await seedUser("u_login");
    const credential = await createLoginCredential(env.FEED_DB, {
      name: "login",
      userId: "u_login",
    });
    const response = await handleCredentialLogin(
      new Request(LOGIN_URL, {
        body: JSON.stringify({token: credential.secret}),
        headers: {origin: ORIGIN},
        method: "POST",
      }),
    );
    expect(response.status).toBe(200);
    const cookies = response.headers.getSetCookie();
    expect(cookies.length).toBeGreaterThan(0);

    const auth = createMicrofeedAuth(env, new Request(LOGIN_URL));
    const session = await auth.api.getSession({
      headers: new Headers({cookie: cookies[0]!.split(";")[0]!}),
    });
    expect(session?.user?.id).toBe("u_login");
  });

  it("accepts a header bearer without an Origin (programmatic sign-in)", async () => {
    await seedUser("u_header");
    const credential = await createLoginCredential(env.FEED_DB, {
      name: "hdr",
      userId: "u_header",
    });
    const response = await handleCredentialLogin(
      new Request(LOGIN_URL, {
        headers: {authorization: `Bearer ${credential.secret}`},
        method: "POST",
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().length).toBeGreaterThan(0);
  });

  it("rejects a cross-origin body post", async () => {
    await seedUser("u_x");
    const credential = await createLoginCredential(env.FEED_DB, {
      name: "x",
      userId: "u_x",
    });
    const response = await handleCredentialLogin(
      new Request(LOGIN_URL, {
        body: JSON.stringify({token: credential.secret}),
        headers: {origin: "https://evil.example.com"},
        method: "POST",
      }),
    );
    expect(response.status).toBe(403);
  });

  it("rejects unknown, revoked, and expired tokens", async () => {
    await seedUser("u_bad");
    const revoked = await createLoginCredential(env.FEED_DB, {
      name: "r",
      userId: "u_bad",
    });
    await revokeLoginCredential(env.FEED_DB, "u_bad", revoked.id);
    const expired = await createLoginCredential(env.FEED_DB, {
      expiresAtMs: Date.now() - 1,
      name: "e",
      userId: "u_bad",
    });

    for (const token of ["mflc_nope", revoked.secret, expired.secret]) {
      const response = await handleCredentialLogin(
        new Request(LOGIN_URL, {
          body: JSON.stringify({token}),
          headers: {origin: ORIGIN},
          method: "POST",
        }),
      );
      expect(response.status).toBe(401);
    }
  });

  it("refuses a banned account", async () => {
    await seedUser("u_banned", "user", 1);
    const credential = await createLoginCredential(env.FEED_DB, {
      name: "b",
      userId: "u_banned",
    });
    const response = await handleCredentialLogin(
      new Request(LOGIN_URL, {
        body: JSON.stringify({token: credential.secret}),
        headers: {origin: ORIGIN},
        method: "POST",
      }),
    );
    expect(response.status).toBe(401);
  });

  it("throttles repeated failures", async () => {
    await seedUser("u_t");
    let status = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await handleCredentialLogin(
        new Request(LOGIN_URL, {
          body: JSON.stringify({token: "mflc_wrong"}),
          headers: {"cf-connecting-ip": "203.0.113.9", origin: ORIGIN},
          method: "POST",
        }),
      );
      status = response.status;
    }
    expect(status).toBe(429);
  });
});

describe("sessionless API bearer", () => {
  it("allows a read the account is permitted to make", async () => {
    await seedUser("u_editor");
    await grantRole("u_editor", "r_editor");
    const credential = await createLoginCredential(env.FEED_DB, {
      name: "api",
      userId: "u_editor",
    });
    const result = await decideLoginCredentialApiRequest(
      env.FEED_DB,
      new Request(`${ORIGIN}/api/v1/items/`, {
        headers: {authorization: `Bearer ${credential.secret}`},
      }),
      "/api/v1/items/",
    );
    expect(result.kind).toBe("allow");
  });

  it("forbids a write the account's role withholds", async () => {
    // The editor role holds content:chapter:create / update but deliberately not
    // content:chapter:delete, so the per-method split must keep the delete
    // denied instead of letting any write through (ADR-0009).
    await seedUser("u_editor_delete");
    await grantRole("u_editor_delete", "r_editor");
    const credential = await createLoginCredential(env.FEED_DB, {
      name: "api",
      userId: "u_editor_delete",
    });
    const result = await decideLoginCredentialApiRequest(
      env.FEED_DB,
      new Request(`${ORIGIN}/api/v1/items/abc123/`, {
        method: "DELETE",
        headers: {authorization: `Bearer ${credential.secret}`},
      }),
      "/api/v1/items/abc123/",
    );
    expect(result.kind).toBe("forbidden");
  });

  it("requires no RBAC code for upstream-owned domains", async () => {
    // pages / site-files / media keep the upstream OAuth-scope model, so a
    // credential whose account holds no content grants is still allowed here.
    await seedUser("u_no_grants");
    const credential = await createLoginCredential(env.FEED_DB, {
      name: "api",
      userId: "u_no_grants",
    });
    const result = await decideLoginCredentialApiRequest(
      env.FEED_DB,
      new Request(`${ORIGIN}/api/v1/pages/`, {
        headers: {authorization: `Bearer ${credential.secret}`},
      }),
      "/api/v1/pages/",
    );
    expect(result.kind).toBe("allow");
  });

  it("forbids a resource the account has no grant for", async () => {
    await seedUser("u_plain");
    const credential = await createLoginCredential(env.FEED_DB, {
      name: "api",
      userId: "u_plain",
    });
    const result = await decideLoginCredentialApiRequest(
      env.FEED_DB,
      new Request(`${ORIGIN}/api/v1/items/`, {
        headers: {authorization: `Bearer ${credential.secret}`},
      }),
      "/api/v1/items/",
    );
    expect(result.kind).toBe("forbidden");
  });

  it("rejects a revoked token and reports an unknown path", async () => {
    await seedUser("u_rev");
    const credential = await createLoginCredential(env.FEED_DB, {
      name: "api",
      userId: "u_rev",
    });
    await revokeLoginCredential(env.FEED_DB, "u_rev", credential.id);

    const revoked = await decideLoginCredentialApiRequest(
      env.FEED_DB,
      new Request(`${ORIGIN}/api/v1/items/`, {
        headers: {authorization: `Bearer ${credential.secret}`},
      }),
      "/api/v1/items/",
    );
    expect(revoked.kind).toBe("unauthorized");

    const missing = await decideLoginCredentialApiRequest(
      env.FEED_DB,
      new Request(`${ORIGIN}/api/v1/nope/`, {
        headers: {authorization: `Bearer ${credential.secret}`},
      }),
      "/api/v1/nope/",
    );
    expect(missing.kind).toBe("notFound");
  });
});

describe("login credential usage tracking", () => {
  it("records usage only once a call is authorized", async () => {
    await seedUser("u_used");
    await grantRole("u_used", "r_editor");
    const credential = await createLoginCredential(env.FEED_DB, {
      name: "used",
      userId: "u_used",
    });

    // Verifying a token is not using it: the dashboard's "last used" column
    // must not light up for a call that was never authorized.
    await verifyLoginCredentialToken(env.FEED_DB, credential.secret);
    const before = await listLoginCredentialsForUser(env.FEED_DB, "u_used");
    expect(before[0]?.lastUsedAtMs).toBeNull();

    const allowed = await decideLoginCredentialApiRequest(
      env.FEED_DB,
      new Request(`${ORIGIN}/api/v1/items/`, {
        headers: {authorization: `Bearer ${credential.secret}`},
      }),
      "/api/v1/items/",
    );
    if (allowed.kind !== "allow") {
      throw new Error(`expected allow, got ${allowed.kind}`);
    }
    // The decision carries what the audit trail needs.
    expect(allowed.attribution).toMatchObject({
      apiKeyId: null,
      credentialId: credential.id,
      userId: "u_used",
    });
    const after = await listLoginCredentialsForUser(env.FEED_DB, "u_used");
    expect(typeof after[0]?.lastUsedAtMs).toBe("number");
  });

  it("leaves usage unrecorded when authorization denies the call", async () => {
    await seedUser("u_denied");
    const credential = await createLoginCredential(env.FEED_DB, {
      name: "denied",
      userId: "u_denied",
    });
    const denied = await decideLoginCredentialApiRequest(
      env.FEED_DB,
      new Request(`${ORIGIN}/api/v1/items/`, {
        headers: {authorization: `Bearer ${credential.secret}`},
      }),
      "/api/v1/items/",
    );
    if (denied.kind !== "forbidden") {
      throw new Error(`expected forbidden, got ${denied.kind}`);
    }
    expect(denied.attribution).toMatchObject({
      credentialId: credential.id,
      userId: "u_denied",
    });
    const list = await listLoginCredentialsForUser(env.FEED_DB, "u_denied");
    expect(list[0]?.lastUsedAtMs).toBeNull();
  });

  it("stamps an explicit mark with the current time", async () => {
    await seedUser("u_mark");
    const credential = await createLoginCredential(env.FEED_DB, {
      name: "mark",
      userId: "u_mark",
    });
    await markLoginCredentialUsed(env.FEED_DB, credential.id);
    const list = await listLoginCredentialsForUser(env.FEED_DB, "u_mark");
    expect(list[0]?.lastUsedAtMs).toBeGreaterThan(0);
  });
});

describe("sessionless bearer throttling", () => {
  it("throttles repeated invalid tokens per client address", async () => {
    await seedUser("u_throttle");
    let kind = "";
    for (
      let attempt = 0;
      attempt < LOGIN_THROTTLE_MAX_ATTEMPTS + 2;
      attempt += 1
    ) {
      const result = await decideLoginCredentialApiRequest(
        env.FEED_DB,
        new Request(`${ORIGIN}/api/v1/items/`, {
          headers: {
            authorization: "Bearer mflc_wrong",
            "cf-connecting-ip": "203.0.113.77",
          },
        }),
        "/api/v1/items/",
      );
      kind = result.kind;
    }
    expect(kind).toBe("throttled");
  });

  it("does not count an authorization denial as a failed attempt", async () => {
    await seedUser("u_nothrottle");
    const credential = await createLoginCredential(env.FEED_DB, {
      name: "n",
      userId: "u_nothrottle",
    });
    for (
      let attempt = 0;
      attempt < LOGIN_THROTTLE_MAX_ATTEMPTS + 2;
      attempt += 1
    ) {
      const result = await decideLoginCredentialApiRequest(
        env.FEED_DB,
        new Request(`${ORIGIN}/api/v1/items/`, {
          headers: {
            authorization: `Bearer ${credential.secret}`,
            "cf-connecting-ip": "203.0.113.78",
          },
        }),
        "/api/v1/items/",
      );
      expect(result.kind).toBe("forbidden");
    }
  });
});

describe("api access audit", () => {
  it("attributes a credential call to the credential", async () => {
    await seedUser("u_audit");
    const credential = await createLoginCredential(env.FEED_DB, {
      name: "audit",
      userId: "u_audit",
    });
    await writeApiAccessLog(
      env.FEED_DB,
      {
        apiKeyId: null,
        credentialId: credential.id,
        permissionCode: "content:chapter:read",
        userId: "u_audit",
      },
      "GET",
      "/api/v1/items/",
      false,
      403,
    );
    const row = await env.FEED_DB.prepare(
      "SELECT api_key_id, credential_id, granted, status FROM ext_api_access_log",
    ).first<{
      api_key_id: string | null;
      credential_id: string | null;
      granted: number;
      status: number;
    }>();
    expect(row).toMatchObject({
      api_key_id: null,
      credential_id: credential.id,
      granted: 0,
      status: 403,
    });
  });

  it("keeps writing a keyed call without a credential id", async () => {
    await writeApiAccessLog(
      env.FEED_DB,
      {
        apiKeyId: "key_1",
        permissionCode: "content:chapter:read",
        userId: "u_audit_key",
      },
      "POST",
      "/api/v1/items/",
      true,
      200,
    );
    const row = await env.FEED_DB.prepare(
      "SELECT api_key_id, credential_id FROM ext_api_access_log",
    ).first<{api_key_id: string | null; credential_id: string | null}>();
    expect(row).toMatchObject({api_key_id: "key_1", credential_id: null});
  });
});

describe("credential expiry", () => {
  it("stores the requested expiry, and none when omitted", async () => {
    await seedUser("u_exp");
    const expiresAtMs = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const withExpiry = await createAdminRbacUserCredential({
      locals: locals("u_exp"),
      request: new Request(CREATE_URL, {
        body: JSON.stringify({expiresAtMs, name: "exp"}),
        headers: {origin: ORIGIN},
        method: "POST",
      }),
    } as never);
    const expiring = await withExpiry.json() as {
      credentials: {expiresAtMs: number | null}[];
    };
    expect(expiring.credentials[0]?.expiresAtMs).toBe(expiresAtMs);

    const withoutExpiry = await createAdminRbacUserCredential({
      locals: locals("u_exp"),
      request: new Request(CREATE_URL, {
        body: JSON.stringify({name: "forever"}),
        headers: {origin: ORIGIN},
        method: "POST",
      }),
    } as never);
    const forever = await withoutExpiry.json() as {
      credentials: {expiresAtMs: number | null; name: string}[];
    };
    const stored = forever.credentials.find((entry) => entry.name === "forever");
    expect(stored?.expiresAtMs).toBeNull();
  });
});
