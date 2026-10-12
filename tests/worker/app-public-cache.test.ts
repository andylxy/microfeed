/**
 * App 公共数据端点的服务端缓存验证（src/server/tcm/app-cache.ts）。
 *
 * 锁定行为：三个公共端点（GetAllZhongYao / GetAliaZhongYao / GetNav）首次请求
 * 把响应写入 Cache API（固定 key），后续请求即使 D1 不可用也能返回同一响应体，
 * 即命中缓存后完全不读库。这是每天 5M rows_read 额度下的关键防线：
 * 源码里的 public, max-age=300 出站头会被 applyWorkerCachePolicy 覆盖成
 * no-store，缓存必须由端点自己持有（见 app-cache.ts 头注释）。
 */
import {describe, expect, it} from "vitest";
import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import * as GetAllZhongYao from "@/pages/api/AppBookRequest/GetAllZhongYao";
import * as GetAliaZhongYao from "@/pages/api/AppBookRequest/GetAliaZhongYao";
import * as GetNav from "@/pages/api/AppBookRequest/GetNav";

const CACHE_ORIGIN = "https://app-cache.microfeed.internal";
const ORIGIN = "https://app.example.com";

/** 构造 Astro APIContext（端点不读 request/url，`as never` 让 tsc 放行）。 */
function ctx(path: string): never {
  return {url: new URL(ORIGIN + path)} as never;
}

/** Workers 运行时 Cache Storage 的最小接口（`caches.default`，按 URL 存取）。 */
interface WorkerCache {
  match(request: URL): Promise<Response | undefined>;
}

function peekCache(): WorkerCache {
  const storage = (globalThis as {caches?: {default?: WorkerCache}}).caches;
  if (!storage?.default) throw new Error("Cache Storage unavailable");
  return storage.default;
}

async function expectCachedAfterFirst(
  path: string,
  get: APIRoute,
  cacheName: string,
): Promise<void> {
  const first = await get(ctx(path));
  expect(first.status).toBe(200);
  const body = await first.text();
  const cached = await peekCache().match(new URL(`/app/${cacheName}`, CACHE_ORIGIN));
  expect(cached).toBeDefined();
  const original = env.FEED_DB;
  (env as {FEED_DB: unknown}).FEED_DB = new Proxy({}, {
    get() { throw new Error("should not touch D1"); },
  });
  try {
    const second = await get(ctx(path));
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(body);
  } finally {
    (env as {FEED_DB: unknown}).FEED_DB = original;
  }
}

describe("App 公共端点服务端缓存", () => {
  it("GetAllZhongYao：首请求写入缓存，之后断开 D1 仍能返回同一响应体", async () => {
    await expectCachedAfterFirst(
      "/api/AppBookRequest/GetAllZhongYao", GetAllZhongYao.GET, "zhongyao",
    );
  });

  it("GetAliaZhongYao：同上", async () => {
    await expectCachedAfterFirst(
      "/api/AppBookRequest/GetAliaZhongYao", GetAliaZhongYao.GET, "yao-aliases",
    );
  });

  it("GetNav：同上", async () => {
    await expectCachedAfterFirst(
      "/api/AppBookRequest/GetNav", GetNav.GET, "nav",
    );
  });
});
