/**
 * App 缓存控制项（方案第 5 节）。
 *
 * 单行 JSON 存 `settings` 表（category=`app_cache_control`），管四件事：
 *  - 总开关：关掉后三个写入口都不读不写缓存；
 *  - 按桶开关：单独关掉某一类条目（大响应先关，见方案 5.5）；
 *  - 四档 TTL：桶名决定取哪一档，范围按「陈旧后果」固定（方案 1 节）；
 *  - 单条体积上限：`body.length * 3` 上界判定，见方案 5.5 的单位说明。
 *
 * 读走 `caches.default` 单键 read-through（TTL 300）：每请求 1 次缓存查找、稳态
 * 0 行 D1；未命中回源 `settings` 一行，摊销 = `86400/300 × 3` = 864 行/日。
 *
 * 这一层自己不受总开关与按桶开关管辖（关掉总开关不能把自己也关掉），也不打
 * `APP_CACHE_TAG`（否则「清空全部」会连控制项一起清，清空后第一个请求要回源读
 * `settings`）。两条都由 `tests/worker/app-cache-control.test.ts` 守护。
 */

import {env} from "cloudflare:workers";

import {SETTINGS_CATEGORIES} from "@/shared/Constants";
import {
  APP_CACHE_BUCKETS,
  APP_CACHE_TTL_RANGES,
  APP_CACHE_TTL_TIERS,
  DEFAULT_APP_CACHE_CONTROL,
  DEFAULT_MAX_ENTRY_BYTES,
  MAX_MAX_ENTRY_BYTES,
  MIN_MAX_ENTRY_BYTES,
  PURGE_DAILY_MAX,
  PURGE_MIN_INTERVAL_MS,
  type AppCacheBucket,
  type AppCacheControl,
  type AppCacheTtlTier,
} from "@/shared/AppCacheControl";
import {
  readSettingsCategory,
  writeSettingsCategory,
} from "@/server/feed/settings-store";
import {
  deleteWorkerCacheKeys,
  readJsonEntry,
  workerCacheKey,
  writeJsonEntry,
} from "./worker-cache";

/** 清空全部用的标签。三个写入口写入的条目都带它。 */
export const APP_CACHE_TAG = "mf:app-cache";
/** 控制项自己的缓存键，与内容条目同一个内部 origin。 */
const CONTROL_ORIGIN = "https://app-cache.microfeed.internal";
const CONTROL_PATH = "/app/cache-control";
/** 控制项缓存 TTL（秒）。保存后删本地键，其余机房 ≤5 分钟自然过期。 */
export const APP_CACHE_CONTROL_TTL = 300;

/** 缓存名 → 桶。`app-cache.ts` 的常量值作键，改缓存名时要同步这里。 */
export const BUCKET_OF_CACHE: Record<string, AppCacheBucket> = {
  "nav-v3": "nav",
  "book-chapters": "chapters",
  "chapter-content-v1": "content",
  "book-fang-v1": "fang",
  zhongyao: "zhongyao",
  "yao-aliases": "aliases",
  "style-config": "style",
  "login-methods": "login-methods",
};

function intOr(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number"
    ? value
    : Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
}

/**
 * 归一控制项。整行缺失与字段级坏值都回退到默认值（`ADR-0050` D2 的方向）：
 * 字段类型不对、越界、缺键时只把该字段归默认，其余字段照用。
 */
export function parseAppCacheControl(raw: unknown): AppCacheControl {
  const source = recordOf(raw);
  const rawTtls = recordOf(source.ttls);
  const rawBuckets = recordOf(source.buckets);

  const ttls = {} as Record<AppCacheTtlTier, number>;
  for (const tier of APP_CACHE_TTL_TIERS) {
    const range = APP_CACHE_TTL_RANGES[tier];
    ttls[tier] = intOr(
      rawTtls[tier],
      DEFAULT_APP_CACHE_CONTROL.ttls[tier],
      range.min,
      range.max,
    );
  }

  const buckets = {} as Record<AppCacheBucket, boolean>;
  for (const bucket of APP_CACHE_BUCKETS) {
    buckets[bucket] = boolOr(
      rawBuckets[bucket],
      DEFAULT_APP_CACHE_CONTROL.buckets[bucket],
    );
  }

  return {
    buckets,
    enabled: boolOr(source.enabled, DEFAULT_APP_CACHE_CONTROL.enabled),
    lastPurgedAtMs: intOr(source.lastPurgedAtMs, 0, 0, Number.MAX_SAFE_INTEGER),
    maxEntryBytes: intOr(
      source.maxEntryBytes,
      DEFAULT_MAX_ENTRY_BYTES,
      MIN_MAX_ENTRY_BYTES,
      MAX_MAX_ENTRY_BYTES,
    ),
    purgedOnDay: typeof source.purgedOnDay === "string" ? source.purgedOnDay : "",
    purgedToday: intOr(source.purgedToday, 0, 0, 10_000),
    ttls,
  };
}

/** UTC 日字符串，清空计数的归零边界。 */
export function purgeDayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function controlKey(): URL {
  return workerCacheKey(CONTROL_ORIGIN, CONTROL_PATH);
}

/**
 * 读控制项。命中缓存 0 行 D1；未命中回源 `settings` 一行并写回。
 * 这里刻意不走 `cachedJson`——那个函数会读控制项，走它会成环。
 *
 * 一次内容请求要经三个入口（`cachedAppResponse`、`cachedJson`、身份缓存）各读
 * 一次控制项；隔离内存副本把同一次请求里的三次查找压成一次。副本 1 秒过期，
 * 保存与清空计数会主动清掉它。
 */
const CONTROL_MEMO_MS = 1_000;
let controlMemo: {control: AppCacheControl; expiresAtMs: number} | null = null;

export async function readAppCacheControl(): Promise<AppCacheControl> {
  const now = Date.now();
  if (controlMemo !== null && controlMemo.expiresAtMs > now) {
    return controlMemo.control;
  }
  const key = controlKey();
  const hit = await readJsonEntry<unknown>(key);
  if (hit !== null) {
    const control = parseAppCacheControl(hit);
    controlMemo = {control, expiresAtMs: now + CONTROL_MEMO_MS};
    return control;
  }
  const raw = await readSettingsCategory<unknown>(
    env.FEED_DB,
    SETTINGS_CATEGORIES.APP_CACHE_CONTROL,
  );
  const control = parseAppCacheControl(raw);
  await writeJsonEntry(key, control, APP_CACHE_CONTROL_TTL);
  controlMemo = {control, expiresAtMs: now + CONTROL_MEMO_MS};
  return control;
}

/**
 * D1 直读控制项，不经过 300 秒缓存。后台控制面用这一份：清空计数与上次清空
 * 时间要显示真实值，不能拿别的机房写下的旧副本。请求路径仍走
 * {@link readAppCacheControl}。
 */
export async function readAppCacheControlDirect(): Promise<AppCacheControl> {
  return parseAppCacheControl(
    await readSettingsCategory<unknown>(
      env.FEED_DB,
      SETTINGS_CATEGORIES.APP_CACHE_CONTROL,
    ),
  );
}

/** 清掉控制项的缓存条目（保存与清空计数后调用）。 */
export async function deleteAppCacheControlEntry(): Promise<void> {
  controlMemo = null;
  await deleteWorkerCacheKeys([controlKey()]);
}

export type AppCacheControlWriteResult =
  | {ok: true; control: AppCacheControl}
  | {ok: false; reason: "invalidControl"};

/**
 * read-merge-write 保存。只接受显式给出的字段；给出的值越界一律拒收（返回
 * `invalidControl`），不做静默夹取：页面输入 30 秒的 content TTL 时直接返回
 * 错误，运营能立刻发现配置没有保存。
 */
export async function saveAppCacheControl(
  patch: unknown,
): Promise<AppCacheControlWriteResult> {
  if (typeof patch !== "object" || patch === null) {
    return {ok: false, reason: "invalidControl"};
  }
  const source = patch as Record<string, unknown>;
  const current = parseAppCacheControl(
    await readSettingsCategory<unknown>(
      env.FEED_DB,
      SETTINGS_CATEGORIES.APP_CACHE_CONTROL,
    ),
  );

  const next: AppCacheControl = {
    ...current,
    buckets: {...current.buckets},
    ttls: {...current.ttls},
  };

  if (source.enabled !== undefined) {
    if (typeof source.enabled !== "boolean") {
      return {ok: false, reason: "invalidControl"};
    }
    next.enabled = source.enabled;
  }

  if (source.maxEntryBytes !== undefined) {
    const parsed = intOr(source.maxEntryBytes, -1, MIN_MAX_ENTRY_BYTES, MAX_MAX_ENTRY_BYTES);
    if (parsed === -1) return {ok: false, reason: "invalidControl"};
    next.maxEntryBytes = parsed;
  }

  const rawTtls = recordOf(source.ttls);
  for (const tier of APP_CACHE_TTL_TIERS) {
    if (rawTtls[tier] === undefined) continue;
    const range = APP_CACHE_TTL_RANGES[tier];
    const parsed = intOr(rawTtls[tier], -1, range.min, range.max);
    if (parsed === -1) return {ok: false, reason: "invalidControl"};
    next.ttls[tier] = parsed;
  }

  const rawBuckets = recordOf(source.buckets);
  for (const bucket of APP_CACHE_BUCKETS) {
    if (rawBuckets[bucket] === undefined) continue;
    if (typeof rawBuckets[bucket] !== "boolean") {
      return {ok: false, reason: "invalidControl"};
    }
    next.buckets[bucket] = rawBuckets[bucket] as boolean;
  }

  await writeSettingsCategory(
    env.FEED_DB,
    SETTINGS_CATEGORIES.APP_CACHE_CONTROL,
    JSON.stringify(next),
  );
  await deleteAppCacheControlEntry();
  return {ok: true, control: next};
}

/**
 * 记一次清空：写 `lastPurgedAtMs` 与当日计数，并清掉控制项缓存。
 * 返回 `null` 表示被拒（间隔不足或当日次数用完），`retryAfterMs` 供页面显示。
 */
export async function noteAppCachePurged(
  now = Date.now(),
): Promise<{allowed: true; control: AppCacheControl} | {allowed: false; retryAfterMs: number}> {
  const current = parseAppCacheControl(
    await readSettingsCategory<unknown>(
      env.FEED_DB,
      SETTINGS_CATEGORIES.APP_CACHE_CONTROL,
    ),
  );
  const sinceLast = now - current.lastPurgedAtMs;
  if (current.lastPurgedAtMs > 0 && sinceLast < PURGE_MIN_INTERVAL_MS) {
    return {allowed: false, retryAfterMs: PURGE_MIN_INTERVAL_MS - sinceLast};
  }
  const day = purgeDayKey(now);
  const usedToday = current.purgedOnDay === day ? current.purgedToday : 0;
  if (usedToday >= PURGE_DAILY_MAX) {
    return {allowed: false, retryAfterMs: 0};
  }
  const next: AppCacheControl = {
    ...current,
    lastPurgedAtMs: now,
    purgedOnDay: day,
    purgedToday: usedToday + 1,
  };
  await writeSettingsCategory(
    env.FEED_DB,
    SETTINGS_CATEGORIES.APP_CACHE_CONTROL,
    JSON.stringify(next),
  );
  await deleteAppCacheControlEntry();
  return {allowed: true, control: next};
}
