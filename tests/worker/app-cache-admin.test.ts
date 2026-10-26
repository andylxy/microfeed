import {env} from "cloudflare:workers";
import {afterEach, beforeEach, describe, expect, it} from "vitest";

import {GET as cacheGet} from "@/pages/[adminPath]/ajax/cache/index";
import {POST as cachePurge} from "@/pages/[adminPath]/ajax/cache/purge";
import {POST as cacheSave} from "@/pages/[adminPath]/ajax/cache/save";
import {
  deleteAppCacheControlEntry,
  purgeDayKey,
  readAppCacheControl,
} from "@/server/cache/cache-control";
import {
  appCachePurgeTags,
  isAppCachePurgeScope,
} from "@/server/cache/cache-purge";
import {
  PURGE_DAILY_MAX,
  PURGE_MIN_INTERVAL_MS,
} from "@/shared/AppCacheControl";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * 缓存控制面后台（方案第 5 节）：三个 AJAX 端点的权限门、读写与清空预算。
 *
 * 清空的真实调用（`cache.purge`）不在用例里触发：本地 miniflare 不支持它，
 * 而预算判定发生在调用之前——节流与日上限两种拒绝都在这里验，标签拼法单独
 * 验纯函数。受理后的真实清空效果不在本地用例的覆盖范围内。
 */

const MANAGE = PERMISSION_CODES.SYSTEM_CACHE_MANAGE;
const ORIGIN = "https://feed.example.com";

function locals(permissions: string[] = [MANAGE]) {
  return {
    authUser: {id: "u_cache_admin", role: null},
    rbacBanned: false,
    rbacDeviceRevoked: false,
    rbacMustChangePassword: false,
    rbacPermissions: new Set(permissions),
  };
}

function getRequest(): Request {
  return new Request(`${ORIGIN}/admin/ajax/cache/`);
}

function postRequest(path: string, body: unknown): Request {
  return new Request(`${ORIGIN}/admin/ajax/cache/${path}/`, {
    body: JSON.stringify(body),
    headers: {"content-type": "application/json"},
    method: "POST",
  });
}

function callGet(who = locals()): Promise<Response> {
  return cacheGet({locals: who, request: getRequest()} as never) as Promise<Response>;
}

function callSave(body: unknown, who = locals()): Promise<Response> {
  return cacheSave({
    locals: who,
    request: postRequest("save", body),
  } as never) as Promise<Response>;
}

function callPurge(body: unknown, who = locals()): Promise<Response> {
  return cachePurge({
    locals: who,
    request: postRequest("purge", body),
  } as never) as Promise<Response>;
}

async function writeControlRaw(value: unknown): Promise<void> {
  await env.FEED_DB.prepare(
    "INSERT INTO settings (category, data) VALUES ('app_cache_control', ?) " +
      "ON CONFLICT(category) DO UPDATE SET data = excluded.data",
  ).bind(JSON.stringify(value)).run();
  await deleteAppCacheControlEntry();
}

async function clearControl(): Promise<void> {
  await env.FEED_DB.prepare(
    "DELETE FROM settings WHERE category = 'app_cache_control'",
  ).run();
  await deleteAppCacheControlEntry();
}

beforeEach(clearControl);
afterEach(clearControl);

describe("cache control endpoint guards", () => {
  it("rejects read, save and purge without system:cache:manage", async () => {
    const anon = locals([]);
    expect((await callGet(anon)).status).toBe(403);
    expect((await callSave({patch: {enabled: false}}, anon)).status).toBe(403);
    expect((await callPurge({scope: "all"}, anon)).status).toBe(403);
    // 被拒的保存不写库。
    const row = await env.FEED_DB.prepare(
      "SELECT COUNT(*) AS c FROM settings WHERE category = 'app_cache_control'",
    ).first<{c: number}>();
    expect(row?.c).toBe(0);
  });
});

describe("cache control board", () => {
  it("reads past the 300-second cached copy", async () => {
    await writeControlRaw({enabled: false});
    // 先让请求路径的 read-through 把旧值写进 caches.default。
    expect((await readAppCacheControl()).enabled).toBe(false);
    // 直接改 D1，不删缓存条目：后台必须看到新值。
    await env.FEED_DB.prepare(
      "UPDATE settings SET data = ? WHERE category = 'app_cache_control'",
    ).bind(JSON.stringify({enabled: true})).run();

    const response = await callGet();
    expect(response.status).toBe(200);
    const body = await response.json() as {control: {enabled: boolean}};
    expect(body.control.enabled).toBe(true);
    // 请求路径仍命中旧副本（自愈窗口 300 秒），两条读路彼此独立。
    expect((await readAppCacheControl()).enabled).toBe(false);
  });

  it("rejects an out-of-range TTL instead of clamping it", async () => {
    const response = await callSave({patch: {ttls: {content: 30}}});
    expect(response.status).toBe(400);
    const body = await response.json() as {error: string};
    expect(body.error.length).toBeGreaterThan(0);

    const reread = await callGet();
    const readBody = await reread.json() as {
      control: {ttls: {content: number}};
    };
    expect(readBody.control.ttls.content).toBe(86_400);
  });

  it("saves the editable surface and returns the normalized control", async () => {
    const response = await callSave({
      patch: {
        buckets: {zhongyao: false},
        enabled: false,
        maxEntryBytes: 2_097_152,
        ttls: {content: 7_200},
      },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      control: {
        buckets: {zhongyao: boolean};
        enabled: boolean;
        maxEntryBytes: number;
        ttls: {content: number};
      };
    };
    expect(body.control.enabled).toBe(false);
    expect(body.control.buckets.zhongyao).toBe(false);
    expect(body.control.ttls.content).toBe(7_200);
    expect(body.control.maxEntryBytes).toBe(2_097_152);
  });
});

describe("cache purge scope and budget", () => {
  it("accepts only 'all' or a registered bucket", () => {
    expect(isAppCachePurgeScope("all")).toBe(true);
    expect(isAppCachePurgeScope("chapters")).toBe(true);
    expect(isAppCachePurgeScope("chapter")).toBe(false);
    expect(isAppCachePurgeScope(null)).toBe(false);
    expect(appCachePurgeTags("all")).toEqual(["mf:app-cache"]);
    expect(appCachePurgeTags("chapters")).toEqual(["mf:app-cache:chapters"]);
  });

  it("rejects an unknown bucket before touching the budget", async () => {
    await writeControlRaw({purgedToday: 0});
    const response = await callPurge({scope: "chapter"});
    expect(response.status).toBe(400);
    const row = await env.FEED_DB.prepare(
      "SELECT data FROM settings WHERE category = 'app_cache_control'",
    ).first<{data: string}>();
    expect(JSON.parse(row!.data).purgedToday).toBe(0);
  });

  it("rejects an unparsable body instead of defaulting to a global purge", async () => {
    await writeControlRaw({purgedToday: 0});
    const response = await cachePurge({
      locals: locals(),
      request: new Request(`${ORIGIN}/admin/ajax/cache/purge/`, {
        body: "{not json",
        headers: {"content-type": "application/json"},
        method: "POST",
      }),
    } as never) as Response;
    expect(response.status).toBe(400);
    const row = await env.FEED_DB.prepare(
      "SELECT data FROM settings WHERE category = 'app_cache_control'",
    ).first<{data: string}>();
    expect(JSON.parse(row!.data).purgedToday).toBe(0);
  });

  it("rejects a second purge inside the 10-second interval", async () => {
    await writeControlRaw({lastPurgedAtMs: Date.now(), purgedToday: 0});
    const response = await callPurge({scope: "all"});
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after")))
      .toBeGreaterThan(0);
    expect(Number(response.headers.get("retry-after")))
      .toBeLessThanOrEqual(Math.ceil(PURGE_MIN_INTERVAL_MS / 1_000));
    const row = await env.FEED_DB.prepare(
      "SELECT data FROM settings WHERE category = 'app_cache_control'",
    ).first<{data: string}>();
    expect(JSON.parse(row!.data).purgedToday).toBe(0);
  });

  it("stops at the 30-per-day cap and does not count the rejection", async () => {
    await writeControlRaw({
      lastPurgedAtMs: 0,
      purgedOnDay: purgeDayKey(),
      purgedToday: PURGE_DAILY_MAX,
    });
    const response = await callPurge({scope: "chapters"});
    expect(response.status).toBe(429);
    const error = await response.json() as {error: string};
    expect(error.error).toContain(String(PURGE_DAILY_MAX));

    const row = await env.FEED_DB.prepare(
      "SELECT data FROM settings WHERE category = 'app_cache_control'",
    ).first<{data: string}>();
    expect(JSON.parse(row!.data).purgedToday).toBe(PURGE_DAILY_MAX);
  });
});
