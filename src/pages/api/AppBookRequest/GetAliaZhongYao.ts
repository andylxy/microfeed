import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {cachedAppResponse} from "@/server/cache/app-cache";
import {getDerivedYaoAliases} from "@/server/tcm/reads";

export const GET: APIRoute = async () =>
  cachedAppResponse("yao-aliases", async () => {
    const derived = await getDerivedYaoAliases(env.FEED_DB);
    // bieMing 前导空格会派生出空正名（饴糖 → ""）；退役手工层后改在响应层过滤，
    // 维持 341 条且与删表前的有效集合逐条一致。
    return [...derived]
      .filter(([, name]) => name !== "")
      .map(([bieming, name]) => ({bieming, name}));
  });
