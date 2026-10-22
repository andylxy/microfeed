import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {
  APP_NAV_CACHE,
  cachedAppResponse,
} from "@/server/cache/app-cache";
import {getAppNav, tierFromAppMember, type AppNavTier} from "@/server/tcm/reads";

// 缓存键带版本号：GetNav 的 24h 共享缓存不随部署失效，改收录状态后必须换键，
// 否则旧响应会继续吐最多一天。旧键自然过期，无需清理。缓存名走
// `APP_NAV_CACHE` 常量——写桶与清桶（`purgeAppBookCache`）共用同一个值。
//
// 两个内容桶：会员与公开各一份（键后缀就是档位值）。桶只由「是否会员」这一位
// 决定，不含调用者身份——所有会员共享一份、所有非会员共享另一份，与共享缓存的
// 语义不冲突。会员标记由鉴权时同一趟查询算出（`locals.appMember`），角色改动
// 下一次请求即生效，不受缓存影响。
export const GET: APIRoute = async ({locals}) => {
  const tier: AppNavTier = tierFromAppMember(locals.appMember);
  return cachedAppResponse(APP_NAV_CACHE, () => getAppNav(env.FEED_DB, tier), tier);
};
