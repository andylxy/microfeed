import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

import {createApiKey, updateApiAccessSettings} from "@/server/api/api-keys";
import {decideLegacyApiRequest, writeApiAccessLog} from "@/server/api/access";

/**
 * legacy bearer 调用的审计归属与访问日志（ADR-0047 D4 + ADR-0049 D6）：
 * 判定与归属单次查表同趟取回；可解析的凭证允许与拒绝双向留痕，owner 缺席时
 * user_id 用 `apikey:<id>` 占位；解析不出的凭证没有可归属主体，不写行。
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
      env.FEED_DB.prepare(
        "DELETE FROM settings WHERE category = 'apiSettings'",
      ),
    ]);
    await updateApiAccessSettings(env.FEED_DB, {
      enabled: true,
      publicDocsEnabled: false,
    });
  });

  it("resolves a legacy bearer to its key id, with the apikey:<id> fallback", async () => {
    const created = await createApiKey(env.FEED_DB, {name: "Legacy audit"});
    const {decision, attribution} = await decideLegacyApiRequest(
      env.FEED_DB,
      bearerRequest(created.apiKey!),
      "/api/v1/feed/",
    );
    expect(decision).toBe("allow-integration");
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

    const {attribution} = await decideLegacyApiRequest(
      env.FEED_DB,
      bearerRequest(created.apiKey!),
      "/api/v1/feed/",
    );
    expect(attribution?.userId).toBe("owner-1");
    expect(attribution?.apiKeyId).toBe(created.id);
  });

  it("has no attribution to record for unknown or missing bearers", async () => {
    await createApiKey(env.FEED_DB, {name: "Unrelated"});
    const unknown = await decideLegacyApiRequest(
      env.FEED_DB,
      bearerRequest("mf_0000000000000000000000000000000000000000000000000000000000000000"),
      "/api/v1/feed/",
    );
    expect(unknown.decision).toBe("unauthorized");
    expect(unknown.attribution).toBeNull();
    const missing = await decideLegacyApiRequest(
      env.FEED_DB,
      new Request(`${ORIGIN}/api/v1/feed/`),
      "/api/v1/feed/",
    );
    expect(missing.decision).toBe("unauthorized");
    expect(missing.attribution).toBeNull();
  });

  it("flags insufficient scope with attribution and writes allow/deny rows", async () => {
    // 只授 read scope 的 key 打写端点：判定为 insufficient-scope 且带归属。
    const created = await createApiKey(env.FEED_DB, {
      name: "Read only",
      scopes: ["content:read"],
    });
    const denied = await decideLegacyApiRequest(
      env.FEED_DB,
      new Request(`${ORIGIN}/api/v1/items/`, {
        headers: {authorization: `Bearer ${created.apiKey!}`},
        method: "POST",
      }),
      "/api/v1/items/",
    );
    expect(denied.decision).toBe("insufficient-scope");
    expect(denied.attribution?.apiKeyId).toBe(created.id);

    const attribution = denied.attribution!;
    await writeApiAccessLog(env.FEED_DB, attribution, "GET", "/api/v1/feed/", true, 200);
    await writeApiAccessLog(env.FEED_DB, attribution, "POST", "/api/v1/items/", false, 403);

    const {results} = await env.FEED_DB.prepare(
      "SELECT api_key_id, user_id, permission_code, granted, status " +
        "FROM ext_api_access_log ORDER BY created_at_ms, method",
    ).all<{
      api_key_id: string;
      granted: number;
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
    expect(results.find((row) => row.granted === 1))
      .toMatchObject({status: 200});
    expect(results.find((row) => row.granted === 0))
      .toMatchObject({status: 403});
  });
});
