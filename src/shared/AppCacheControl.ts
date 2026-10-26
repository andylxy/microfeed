/**
 * App 缓存控制项的运行时中立形状（方案第 5 节）。
 *
 * 服务端读写在 `src/server/cache/cache-control.ts`；后台控制面
 * （`/admin/cache/`）的 React 组件从这里取桶清单、四档 TTL 范围与默认值。
 * 浏览器组件不能导入 server 模块，因此这些纯常量与类型单独放在 shared。
 *
 * 四档 TTL 的上限取方案第 1 节的「陈旧后果」表：目录类最长 6 小时，内容与
 * 配置类最长 24 小时，规则类最长 2 小时。统一给 7 天上限会让分档判据失效。
 */

export type AppCacheTtlTier = "nav" | "content" | "config" | "rule";

export type AppCacheBucket =
  | "nav"
  | "chapters"
  | "content"
  | "fang"
  | "zhongyao"
  | "aliases"
  | "style"
  | "login-methods"
  | "identity"
  | "version";

export interface AppCacheControl {
  enabled: boolean;
  ttls: Record<AppCacheTtlTier, number>;
  buckets: Record<AppCacheBucket, boolean>;
  maxEntryBytes: number;
  lastPurgedAtMs: number;
  purgedToday: number;
  purgedOnDay: string;
}

export const APP_CACHE_TTL_TIERS: readonly AppCacheTtlTier[] = [
  "nav",
  "content",
  "config",
  "rule",
];

export const APP_CACHE_BUCKETS: readonly AppCacheBucket[] = [
  "nav",
  "chapters",
  "content",
  "fang",
  "zhongyao",
  "aliases",
  "style",
  "login-methods",
  "identity",
  "version",
];

export const APP_CACHE_TTL_RANGES: Record<
  AppCacheTtlTier,
  {min: number; max: number}
> = {
  nav: {min: 300, max: 21_600},
  content: {min: 3_600, max: 86_400},
  config: {min: 3_600, max: 86_400},
  rule: {min: 300, max: 7_200},
};

/** 桶 → TTL 档。桶与档分开是为了让「同一档的桶共用一个数字」。 */
export const TTL_TIER_OF: Record<AppCacheBucket, AppCacheTtlTier> = {
  nav: "nav",
  chapters: "content",
  content: "content",
  fang: "content",
  zhongyao: "content",
  aliases: "content",
  style: "config",
  identity: "config",
  "login-methods": "rule",
  version: "rule",
};

/** 体积上限的默认值 4 MiB。设成 1 MiB 会把 zhongyao 与 yao-aliases 挡在缓存外。 */
export const DEFAULT_MAX_ENTRY_BYTES = 4_194_304;
export const MIN_MAX_ENTRY_BYTES = 65_536;
export const MAX_MAX_ENTRY_BYTES = 16_777_216;

/** 两次清空之间的最小间隔（毫秒）。 */
export const PURGE_MIN_INTERVAL_MS = 10_000;
/** 每日清空次数上限。一次清空约 22,013 行读，30 次 = 日额度的 13.2%。 */
export const PURGE_DAILY_MAX = 30;

export const DEFAULT_APP_CACHE_CONTROL: AppCacheControl = {
  enabled: true,
  ttls: {nav: 3_600, content: 86_400, config: 86_400, rule: 7_200},
  buckets: {
    nav: true,
    chapters: true,
    content: true,
    fang: true,
    zhongyao: true,
    aliases: true,
    style: true,
    "login-methods": true,
    identity: true,
    version: true,
  },
  maxEntryBytes: DEFAULT_MAX_ENTRY_BYTES,
  lastPurgedAtMs: 0,
  purgedToday: 0,
  purgedOnDay: "",
};
