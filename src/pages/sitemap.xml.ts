import type {APIRoute} from "astro";

import {env} from "cloudflare:workers";
import {buildSitemapXml} from "@/server/catalog/sitemap";

/** 由独立模块直接生成，不再经站点文件服务读旧 feed 的 items 窗口。 */
export const GET: APIRoute = async ({request}) => {
  const origin = new URL(request.url).origin;
  const xml = await buildSitemapXml(env.FEED_DB, origin);
  return new Response(xml, {
    headers: {"content-type": "application/xml; charset=utf-8"},
  });
};
