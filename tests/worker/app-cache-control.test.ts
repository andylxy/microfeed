import {env} from "cloudflare:workers";
import {afterEach, beforeEach, describe, expect, it} from "vitest";

import {APP_ZHONGYAO_CACHE, cachedAppResponse, cachedJson} from "@/server/cache/app-cache";
import {
  APP_CACHE_BUCKETS,
  DEFAULT_APP_CACHE_CONTROL,
  PURGE_DAILY_MAX,
  PURGE_MIN_INTERVAL_MS,
  TTL_TIER_OF,
} from "@/shared/AppCacheControl";
import {
  APP_CACHE_TAG,
  BUCKET_OF_CACHE,
  deleteAppCacheControlEntry,
  noteAppCachePurged,
  parseAppCacheControl,
  purgeDayKey,
  readAppCacheControl,
  saveAppCacheControl,
} from "@/server/cache/cache-control";
import {workerCache} from "@/server/cache/worker-cache";

/**
 * 缓存控制项（方案第 5 节）：归一与兜底、总开关、按桶开关、TTL 分档、体积上限、
 * 清空的节流与日上限。
 *
 * 控制项自己也是一条 `caches.default` 条目，跨用例会互相污染——每个用例前后都
 * 清 `settings` 的那一行与控制项缓存。
 */

const CONTROL_KEY = new URL(
  "/app/cache-control",
  "https://app-cache.microfeed.internal",
);
/** zhongyao 桶的键：别的用例也会写它，每个用例前先删掉，避免读到别人的条目。 */
const ZHONGYAO_KEY = new URL(
  "/app/zhongyao",
  "https://app-cache.microfeed.internal",
);

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

beforeEach(async () => {
  await clearControl();
  await workerCache().delete(ZHONGYAO_KEY);
});
afterEach(clearControl);

describe("bucket → TTL tier mapping", () => {
  it("maps every bucket to one of the four configured tiers", () => {
    expect(TTL_TIER_OF).toEqual({
      nav: "nav",
      chapters: "content",
      content: "content",
      fang: "content",
      zhongyao: "content",
      aliases: "content",
      style: "config",
      "login-methods": "rule",
      identity: "config",
      version: "rule",
    });
    for (const bucket of APP_CACHE_BUCKETS) {
      expect(DEFAULT_APP_CACHE_CONTROL.ttls[TTL_TIER_OF[bucket]])
        .toBeTypeOf("number");
    }
  });

  it("maps each cache name to its bucket", () => {
    expect(BUCKET_OF_CACHE).toEqual({
      "nav-v3": "nav",
      "book-chapters": "chapters",
      "chapter-content-v1": "content",
      "book-fang-v1": "fang",
      zhongyao: "zhongyao",
      "yao-aliases": "aliases",
      "style-config": "style",
      "login-methods": "login-methods",
    });
  });
});

describe("parseAppCacheControl", () => {
  it("falls back to every default when the row is missing", () => {
    expect(parseAppCacheControl(null)).toEqual(DEFAULT_APP_CACHE_CONTROL);
    expect(parseAppCacheControl("not an object")).toEqual(DEFAULT_APP_CACHE_CONTROL);
  });

  it("keeps valid fields and only resets the bad one", () => {
    const parsed = parseAppCacheControl({
      enabled: false,
      ttls: {content: 7200, nav: 60},
      buckets: {zhongyao: false, nav: "yes"},
      maxEntryBytes: 1024,
    });
    expect(parsed.enabled).toBe(false);
    // 合法值保留
    expect(parsed.ttls.content).toBe(7200);
    // 越界（nav 下限 300）回默认
    expect(parsed.ttls.nav).toBe(DEFAULT_APP_CACHE_CONTROL.ttls.nav);
    // 布尔字段类型不对回默认
    expect(parsed.buckets.zhongyao).toBe(false);
    expect(parsed.buckets.nav).toBe(true);
    // 体积上限低于 64 KiB 下限回默认
    expect(parsed.maxEntryBytes).toBe(DEFAULT_APP_CACHE_CONTROL.maxEntryBytes);
  });
});

describe("readAppCacheControl", () => {
  it("returns the defaults and caches them without a purge tag", async () => {
    const control = await readAppCacheControl();
    expect(control.enabled).toBe(true);
    // 控制项自身不打 APP_CACHE_TAG：否则「清空全部」会连它一起清。
    const entry = await workerCache().match(CONTROL_KEY);
    expect(entry).toBeDefined();
    expect(entry!.headers.get("cache-tag")).toBeNull();
  });
});

describe("cachedAppResponse under the control plane", () => {
  it("serves from the cache with the tier TTL", async () => {
    await writeControlRaw({ttls: {content: 3600}});
    let loads = 0;
    const load = async () => {
      loads += 1;
      return [{name: "桂枝"}];
    };
    const first = await cachedAppResponse(APP_ZHONGYAO_CACHE, load);
    expect(first.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(first.headers.get("content-type")).toBe("application/json;charset=UTF-8");
    expect(first.headers.get("cache-tag")).toBe(
      `${APP_CACHE_TAG}, ${APP_CACHE_TAG}:zhongyao`,
    );
    await cachedAppResponse(APP_ZHONGYAO_CACHE, load);
    expect(loads).toBe(1);
  });

  it("bypasses match and put when the master switch is off", async () => {
    // 先放一份旧条目：总闸关闭后仍能取到回源的新值，且旧条目不被覆盖，
    // 才同时证明 match 与 put 都跳过了。
    await workerCache().put(
      ZHONGYAO_KEY,
      new Response(JSON.stringify({data: ["旧值"]}), {
        headers: {"cache-control": "public, max-age=600"},
      }),
    );
    await writeControlRaw({enabled: false});
    let loads = 0;
    const load = async () => {
      loads += 1;
      return [{name: "新值"}];
    };
    const res = await cachedAppResponse(APP_ZHONGYAO_CACHE, load);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(await res.text()).data).toEqual([{name: "新值"}]);
    await cachedAppResponse(APP_ZHONGYAO_CACHE, load);
    expect(loads).toBe(2);
    const kept = await workerCache().match(ZHONGYAO_KEY);
    expect(JSON.parse(await kept!.text()).data).toEqual(["旧值"]);
  });

  it("bypasses when the bucket is switched off", async () => {
    await writeControlRaw({buckets: {zhongyao: false}});
    let loads = 0;
    const load = async () => {
      loads += 1;
      return [];
    };
    await cachedAppResponse(APP_ZHONGYAO_CACHE, load);
    await cachedAppResponse(APP_ZHONGYAO_CACHE, load);
    expect(loads).toBe(2);
  });

  it("skips the write when the payload exceeds maxEntryBytes", async () => {
    // 下限 64 KiB。中文一字 3 字节，所以 30000 个汉字会越过上界。
    await writeControlRaw({maxEntryBytes: 65_536});
    let loads = 0;
    const big = "药".repeat(30_000);
    const load = async () => {
      loads += 1;
      return [{name: big}];
    };
    const first = await cachedAppResponse(APP_ZHONGYAO_CACHE, load);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.get("cache-tag")).toBeNull();
    await cachedAppResponse(APP_ZHONGYAO_CACHE, load);
    expect(loads).toBe(2);
  });
});

describe("cachedJson under the control plane", () => {
  it("bypasses match and put when the master switch is off", async () => {
    await writeControlRaw({enabled: false});
    let loads = 0;
    const load = async () => {
      loads += 1;
      return {loads};
    };
    await cachedJson("control-json-test", load, "version");
    await cachedJson("control-json-test", load, "version");
    expect(loads).toBe(2);
  });
});

describe("saveAppCacheControl", () => {
  it("rejects out-of-range values instead of clamping them", async () => {
    await expect(saveAppCacheControl({ttls: {content: 30}}))
      .resolves.toEqual({ok: false, reason: "invalidControl"});
    await expect(saveAppCacheControl({ttls: {nav: 604_800}}))
      .resolves.toEqual({ok: false, reason: "invalidControl"});
    await expect(saveAppCacheControl({maxEntryBytes: 1024}))
      .resolves.toEqual({ok: false, reason: "invalidControl"});
    await expect(saveAppCacheControl({enabled: "yes"}))
      .resolves.toEqual({ok: false, reason: "invalidControl"});
  });

  it("merges a valid patch and clears the control entry", async () => {
    const result = await saveAppCacheControl({
      enabled: false,
      buckets: {zhongyao: false},
      ttls: {content: 7200},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.control.enabled).toBe(false);
    expect(result.control.buckets.zhongyao).toBe(false);
    expect(result.control.ttls.content).toBe(7200);
    // 保存后本地条目被删，下一次读回源到新值。
    const reread = await readAppCacheControl();
    expect(reread.enabled).toBe(false);
  });
});

describe("noteAppCachePurged", () => {
  it("rejects a second purge inside the minimum interval", async () => {
    const now = Date.UTC(2026, 9, 26, 12, 0, 0);
    const first = await noteAppCachePurged(now);
    expect(first.allowed).toBe(true);
    const second = await noteAppCachePurged(now + 1_000);
    expect(second.allowed).toBe(false);
    if (second.allowed) return;
    expect(second.retryAfterMs).toBe(PURGE_MIN_INTERVAL_MS - 1_000);
  });

  it("stops at the daily cap and resets on the next UTC day", async () => {
    const day = Date.UTC(2026, 9, 26, 12, 0, 0);
    await writeControlRaw({
      purgedOnDay: purgeDayKey(day),
      purgedToday: PURGE_DAILY_MAX,
    });
    const blocked = await noteAppCachePurged(day + PURGE_MIN_INTERVAL_MS * 2);
    expect(blocked.allowed).toBe(false);

    // 换一天：计数归零，重新放行。
    const nextDay = day + 24 * 60 * 60 * 1000;
    const allowed = await noteAppCachePurged(nextDay);
    expect(allowed.allowed).toBe(true);
    if (!allowed.allowed) return;
    expect(allowed.control.purgedToday).toBe(1);
    expect(allowed.control.purgedOnDay).toBe(purgeDayKey(nextDay));
  });
});
