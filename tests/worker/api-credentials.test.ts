/**
 * Tests for the signed API call path (XiHan BasicApp model) that ties API
 * credentials to a user and attributes every submission through RBAC.
 *
 * Covers: client signer ↔ server verifier roundtrip, the four unauthorized
 * reasons, RBAC allow/forbidden, the user-scoped owner functions, and the
 * access-log audit row.
 */

import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

import {decideSignedApiRequest, writeApiAccessLog} from "@/server/api/access";
import {requiredApiPermission} from "@/server/api/api-permissions";
import {
  countApiKeysForUser,
  createApiKey,
  findApiKeyForUser,
  listApiKeysForUser,
  revokeApiKeyForUser,
  rotateApiKeyForUser,
} from "@/server/api/api-keys";
import {verifySignedCall} from "@/server/api/signed-call";
import {
  canonicalizeQuery,
  constantTimeEqualHex,
  hmacSha256Hex,
  sha256Hex,
} from "@/shared/crypto";
import {signRequest} from "@/shared/api-signing";

const ORIGIN = "https://feed.example.com";

async function seedUser(id: string): Promise<void> {
  await env.FEED_DB.prepare(
    'INSERT INTO "auth_user" (id, name, email, emailVerified, createdAt, updatedAt, role) ' +
      "VALUES (?, ?, ?, 1, '2024-01-01', '2024-01-01', 'user')",
  )
    .bind(id, id.toUpperCase(), `${id}@example.com`)
    .run();
}

async function assignRole(userId: string, roleId: string): Promise<void> {
  await env.FEED_DB.prepare(
    "INSERT OR IGNORE INTO ext_user_roles (user_id, role_id) VALUES (?, ?)",
  )
    .bind(userId, roleId)
    .run();
}

interface SignedRequestOptions {
  method: string;
  path: string;
  query?: string;
  body?: string;
  accessKey: string;
  secret: string;
  nonce?: string;
  timestamp?: number;
}

let nonceCounter = 0;

async function signedRequest(options: SignedRequestOptions): Promise<Request> {
  const headers = await signRequest({
    accessKey: options.accessKey,
    body: options.body,
    method: options.method,
    // Explicit, guaranteed-unique nonce so two test requests never collide in
    // ext_replay_nonces (the default random UUID can repeat across calls here).
    nonce: options.nonce ?? `test-nonce-${++nonceCounter}`,
    path: options.path,
    query: options.query,
    secret: options.secret,
    timestamp: options.timestamp,
  });
  const url = new URL(options.path, ORIGIN);
  if (options.query) url.search = options.query.replace(/^\?/u, "");
  return new Request(url, {
    body: options.body,
    headers,
    method: options.method,
  });
}

beforeEach(async () => {
  await env.FEED_DB.batch([
    env.FEED_DB.prepare("DELETE FROM ext_api_access_log"),
    env.FEED_DB.prepare("DELETE FROM ext_api_key_owners"),
    env.FEED_DB.prepare("DELETE FROM ext_replay_nonces"),
    env.FEED_DB.prepare("DELETE FROM ext_user_roles"),
    env.FEED_DB.prepare("DELETE FROM ext_user_security"),
    env.FEED_DB.prepare('DELETE FROM "auth_user"'),
    env.FEED_DB.prepare("DELETE FROM api_keys"),
  ]);
});

describe("crypto helpers", () => {
  it("canonicalizes a query string by key then value", () => {
    expect(canonicalizeQuery("b=2&a=1&a=0")).toBe("a=0&a=1&b=2");
    expect(canonicalizeQuery("?x=hello%20world")).toBe("x=hello%20world");
    expect(canonicalizeQuery("")).toBe("");
  });

  it("compares hex strings in constant time", async () => {
    const a = await sha256Hex("hello");
    expect(constantTimeEqualHex(a, a)).toBe(true);
    expect(constantTimeEqualHex(a, "deadbeef")).toBe(false);
    expect(constantTimeEqualHex(a, a.slice(0, -1))).toBe(false);
  });

  it("derives a stable HMAC key from the secret hash (client == server)", async () => {
    const secret = "mfsk_abc";
    const key = await sha256Hex(secret);
    const sig = await hmacSha256Hex(key, "METHOD\n/p\n\nhash\n123\nn");
    const sigAgain = await hmacSha256Hex(key, "METHOD\n/p\n\nhash\n123\nn");
    expect(sig).toBe(sigAgain);
    expect(sig).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("requiredApiPermission mapping", () => {
  it("maps content/media/page/site reads and writes", () => {
    expect(requiredApiPermission("/api/v1/items/", "GET")).toBe(
      "api:content:read",
    );
    expect(requiredApiPermission("/api/v1/items/", "POST")).toBe(
      "api:content:write",
    );
    // The bare media_files prefix is NOT an integration suffix; only the
    // presigned_urls sub-path is (see integrationSuffix in access.ts). So the
    // writable media permission must be asserted against the recognized path.
    expect(
      requiredApiPermission("/api/v1/media_files/presigned_urls/", "POST"),
    ).toBe("api:media:write");
    expect(requiredApiPermission("/api/v1/pages/", "GET")).toBe(
      "api:page:read",
    );
    expect(requiredApiPermission("/api/v1/site-files/", "POST")).toBe(
      "api:site:write",
    );
  });

  it("returns null for non-integration media paths", () => {
    // Bare media_files/ is not a recognized integration suffix, so it is not
    // gated by RBAC and yields no required permission.
    expect(requiredApiPermission("/api/v1/media_files/", "POST")).toBeNull();
  });

  it("returns null for non-integration paths", () => {
    expect(requiredApiPermission("/api/v1/feed/", "GET")).toBe(
      "api:content:read",
    );
    expect(requiredApiPermission("/api/v1/unknown/", "GET")).toBeNull();
    expect(requiredApiPermission("/admin/", "GET")).toBeNull();
  });
});

describe("verifySignedCall", () => {
  it("accepts a valid signature and resolves the owner user", async () => {
    await seedUser("u_cred");
    const apiKey = await createApiKey(env.FEED_DB, {
      name: "ci",
      ownerUserId: "u_cred",
    });
    const request = await signedRequest({
      accessKey: apiKey.apiKey,
      method: "GET",
      path: "/api/v1/items/",
      secret: apiKey.secret!,
    });
    const result = await verifySignedCall(env.FEED_DB, request);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.userId).toBe("u_cred");
      expect(result.identity.accessKey).toBe(apiKey.apiKey);
      expect(result.identity.apiKeyId).toBe(apiKey.id);
    }
  });

  it("rejects a missing access key", async () => {
    const request = new Request(`${ORIGIN}/api/v1/items/`, {method: "GET"});
    const result = await verifySignedCall(env.FEED_DB, request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.reason).toBe("missing_access_key");
    }
  });

  it("rejects a bad signature", async () => {
    await seedUser("u_cred");
    const apiKey = await createApiKey(env.FEED_DB, {
      name: "ci",
      ownerUserId: "u_cred",
    });
    const request = await signedRequest({
      accessKey: apiKey.apiKey,
      method: "GET",
      path: "/api/v1/items/",
      secret: apiKey.secret!,
    });
    // Tamper the signature.
    request.headers.set("x-signature", "0".repeat(64));
    const result = await verifySignedCall(env.FEED_DB, request);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad_signature");
  });

  it("rejects an unknown access key", async () => {
    const request = await signedRequest({
      accessKey: "mf_unknownkey0000000000000000000000",
      method: "GET",
      path: "/api/v1/items/",
      secret: "mfsk_whatever",
    });
    const result = await verifySignedCall(env.FEED_DB, request);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unknown_key");
  });

  it("rejects a key with no owning user", async () => {
    await seedUser("u_cred");
    const apiKey = await createApiKey(env.FEED_DB, {
      name: "ci",
      ownerUserId: "u_cred",
    });
    // Orphan the key: keep secret_hash, drop the owner link.
    await env.FEED_DB.prepare(
      "DELETE FROM ext_api_key_owners WHERE api_key_id = ?",
    )
      .bind(apiKey.id)
      .run();
    const request = await signedRequest({
      accessKey: apiKey.apiKey,
      method: "GET",
      path: "/api/v1/items/",
      secret: apiKey.secret!,
    });
    const result = await verifySignedCall(env.FEED_DB, request);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unowned_key");
  });

  it("rejects a replayed nonce", async () => {
    await seedUser("u_cred");
    const apiKey = await createApiKey(env.FEED_DB, {
      name: "ci",
      ownerUserId: "u_cred",
    });
    const build = () =>
      signedRequest({
        accessKey: apiKey.apiKey,
        method: "GET",
        nonce: "replay-nonce-1",
        path: "/api/v1/items/",
        secret: apiKey.secret!,
        timestamp: Date.now(),
      });
    const first = await verifySignedCall(env.FEED_DB, await build());
    expect(first.ok).toBe(true);
    const second = await verifySignedCall(env.FEED_DB, await build());
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("replay");
      expect(second.status).toBe(400);
    }
  });
});

describe("decideSignedApiRequest", () => {
  it("allows an editor to read content via the API", async () => {
    await seedUser("u_editor");
    await assignRole("u_editor", "r_editor");
    const apiKey = await createApiKey(env.FEED_DB, {
      name: "ci",
      ownerUserId: "u_editor",
    });
    const request = await signedRequest({
      accessKey: apiKey.apiKey,
      method: "GET",
      path: "/api/v1/items/",
      secret: apiKey.secret!,
    });
    const result = await decideSignedApiRequest(env.FEED_DB, request, "/api/v1/items/");
    expect(result.kind).toBe("allow");
    if (result.kind === "allow") {
      expect(result.attribution.permissionCode).toBe("api:content:read");
      expect(result.attribution.userId).toBe("u_editor");
    }
  });

  it("forbids a path the role lacks", async () => {
    await seedUser("u_editor");
    await assignRole("u_editor", "r_editor");
    const apiKey = await createApiKey(env.FEED_DB, {
      name: "ci",
      ownerUserId: "u_editor",
    });
    const request = await signedRequest({
      accessKey: apiKey.apiKey,
      method: "POST",
      path: "/api/v1/pages/",
      secret: apiKey.secret!,
    });
    const result = await decideSignedApiRequest(env.FEED_DB, request, "/api/v1/pages/");
    expect(result.kind).toBe("forbidden");
  });

  it("forbids a user with no API permission", async () => {
    await seedUser("u_plain");
    const apiKey = await createApiKey(env.FEED_DB, {
      name: "ci",
      ownerUserId: "u_plain",
    });
    const request = await signedRequest({
      accessKey: apiKey.apiKey,
      method: "GET",
      path: "/api/v1/items/",
      secret: apiKey.secret!,
    });
    const result = await decideSignedApiRequest(env.FEED_DB, request, "/api/v1/items/");
    expect(result.kind).toBe("forbidden");
  });

  it("returns notFound for a non-integration path", async () => {
    await seedUser("u_editor");
    await assignRole("u_editor", "r_editor");
    const apiKey = await createApiKey(env.FEED_DB, {
      name: "ci",
      ownerUserId: "u_editor",
    });
    const request = await signedRequest({
      accessKey: apiKey.apiKey,
      method: "GET",
      path: "/api/v1/unknown/",
      secret: apiKey.secret!,
    });
    const result = await decideSignedApiRequest(
      env.FEED_DB,
      request,
      "/api/v1/unknown/",
    );
    expect(result.kind).toBe("notFound");
  });
});

describe("user-scoped credential ownership", () => {
  it("creates, lists, counts, rotates, and revokes owned keys", async () => {
    await seedUser("u_owner");
    const a = await createApiKey(env.FEED_DB, {
      name: "a",
      ownerUserId: "u_owner",
    });
    const b = await createApiKey(env.FEED_DB, {
      name: "b",
      ownerUserId: "u_owner",
    });
    expect(a.secret).toBeTruthy();
    expect(b.secret).toBeTruthy();

    expect(await countApiKeysForUser(env.FEED_DB, "u_owner")).toBe(2);
    const list = await listApiKeysForUser(env.FEED_DB, "u_owner");
    expect(list.map((k) => k.id).sort()).toEqual([a.id, b.id].sort());

    const rotated = await rotateApiKeyForUser(env.FEED_DB, "u_owner", a.id);
    expect(rotated?.secret).toBeTruthy();
    expect(rotated?.secret).not.toBe(a.secret);

    const found = await findApiKeyForUser(env.FEED_DB, "u_owner", a.id);
    expect(found?.id).toBe(a.id);

    expect(await revokeApiKeyForUser(env.FEED_DB, "u_owner", b.id)).toBe(true);
    expect(await countApiKeysForUser(env.FEED_DB, "u_owner")).toBe(1);
  });

  it("scopes owner lookups to the requesting user", async () => {
    await seedUser("u_a");
    await seedUser("u_b");
    const a = await createApiKey(env.FEED_DB, {
      name: "a",
      ownerUserId: "u_a",
    });
    const cross = await findApiKeyForUser(env.FEED_DB, "u_b", a.id);
    expect(cross).toBeNull();
  });
});

describe("ext_api_access_log audit", () => {
  it("writes a best-effort audit row linking key, user, and permission", async () => {
    const before = await env.FEED_DB.prepare(
      "SELECT COUNT(*) AS c FROM ext_api_access_log",
    ).first<{c: number}>();
    await writeApiAccessLog(
      env.FEED_DB,
      {
        apiKeyId: "k1",
        permissionCode: "api:content:read",
        userId: "u1",
      },
      "GET",
      "/api/v1/items/",
      true,
      200,
    );
    const after = await env.FEED_DB.prepare(
      "SELECT * FROM ext_api_access_log WHERE api_key_id = 'k1'",
    ).first<{
      user_id: string;
      permission_code: string;
      granted: number;
      status: number;
    }>();
    expect((after?.granted ?? 0)).toBe(1);
    expect(after?.user_id).toBe("u1");
    expect(after?.permission_code).toBe("api:content:read");
    expect((before?.c ?? 0) + 1).toBe(
      (await env.FEED_DB.prepare(
        "SELECT COUNT(*) AS c FROM ext_api_access_log",
      ).first<{c: number}>())?.c ?? 0,
    );
  });
});
