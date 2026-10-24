import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

import {createApiKey} from "@/server/api/api-keys";
import {legacyApiAttribution, writeApiAccessLog} from "@/server/api/access";

/**
 * legacy bearer 调用的审计归属与访问日志（ADR-0047 D4 / F5）：可解析的凭证
 * 允许与拒绝双向留痕，owner 缺席时 user_id 用 `apikey:<id>` 占位；解析不出
 * 的凭证没有可归属主体，不写行。
 */
const ORIGIN = "https://feed.example.com";

function bearerRequest(plaintext: string): Request {
  return new Request(`${ORIGIN}/api/v1/feed/`, {
    headers: {authorization: `Bearer ${plaintext}`},
  });
}

describe("legacy bearer access audit", () => {
  beforeEach(async () => {
    await env.FEED_DB.batch([
      env.FEED_DB.prepare("DELETE FROM ext_api_access_log"),
      env.FEED_DB.prepare("DELETE FROM ext_api_key_owners"),
      env.FEED_DB.prepare("DELETE FROM api_keys"),
    ]);
  });

  it("resolves a legacy bearer to its key id, with the apikey:<id> fallback", async () => {
    const created = await createApiKey(env.FEED_DB, {name: "Legacy audit"});
    const attribution = await legacyApiAttribution(
      env.FEED_DB,
      bearerRequest(created.apiKey!),
    );
    expect(attribution).toEqual({
      apiKeyId: created.id,
      credentialId: null,
      userId: `apikey:${created.id}`,
      permissionCode: null,
    });
  });

  it("prefers the owner user when ext_api_key_owners has a row", async () => {
    const created = await createApiKey(env.FEED_DB, {name: "Owned"});
    await env.FEED_DB.prepare(
      'INSERT INTO "auth_user" (id, name, email, emailVerified, createdAt, updatedAt, role, banned) ' +
        "VALUES ('owner-1', 'Owner', 'owner@example.com', 1, '2024-01-01', '2024-01-01', 'user', 0)",
    ).run();
    await env.FEED_DB.prepare(
      "INSERT INTO ext_api_key_owners (api_key_id, user_id, created_at_ms) " +
        "VALUES (?, ?, ?)",
    ).bind(created.id, "owner-1", Date.now()).run();

    const attribution = await legacyApiAttribution(
      env.FEED_DB,
      bearerRequest(created.apiKey!),
    );
    expect(attribution?.userId).toBe("owner-1");
    expect(attribution?.apiKeyId).toBe(created.id);
  });

  it("has no attribution to record for unknown or missing bearers", async () => {
    await createApiKey(env.FEED_DB, {name: "Unrelated"});
    expect(await legacyApiAttribution(
      env.FEED_DB,
      bearerRequest("mf_0000000000000000000000000000000000000000000000000000000000000000"),
    )).toBeNull();
    expect(await legacyApiAttribution(
      env.FEED_DB,
      new Request(`${ORIGIN}/api/v1/feed/`),
    )).toBeNull();
  });

  it("writes allow and deny rows with the __unmapped__ sentinel", async () => {
    const created = await createApiKey(env.FEED_DB, {name: "Logged"});
    const attribution = (await legacyApiAttribution(
      env.FEED_DB,
      bearerRequest(created.apiKey!),
    ))!;
    await writeApiAccessLog(env.FEED_DB, attribution, "GET", "/api/v1/feed/", true, 200);
    await writeApiAccessLog(env.FEED_DB, attribution, "POST", "/api/v1/items/", false, 403);

    const {results} = await env.FEED_DB.prepare(
      "SELECT api_key_id, user_id, method, path, permission_code, granted, status " +
        "FROM ext_api_access_log ORDER BY created_at_ms, method",
    ).all<{
      api_key_id: string;
      granted: number;
      method: string;
      path: string;
      permission_code: string;
      status: number;
      user_id: string;
    }>();
    expect(results).toHaveLength(2);
    for (const row of results) {
      expect(row.api_key_id).toBe(created.id);
      expect(row.permission_code).toBe("__unmapped__");
      expect(row.user_id).toBe(`apikey:${created.id}`);
    }
    expect(results.find((row) => row.method === "GET"))
      .toMatchObject({granted: 1, status: 200});
    expect(results.find((row) => row.method === "POST"))
      .toMatchObject({granted: 0, status: 403});
  });
});
