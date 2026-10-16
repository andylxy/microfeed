import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {jsonResponse} from "@/server/http";
import {appEnvelope} from "@/server/tcm/envelope";
import {getAppStyleConfig} from "@/server/tcm/reads";

/**
 * 样式目录 + 版本号（ADR-0028），走统一的 App 信封 `{code, data, msg}`。
 *
 * `version` 取 `ext_annotation_markers` 的 `MAX(updated_at_ms)` —— 目录最后一次
 * 被改动的时间。App 把它连同缓存一起落盘，下次启动据此判断手里的配置是否最新；
 * 后台 `/admin/annotation-markers/` 改一个标记就能让 App 下次启动时拿到。
 *
 * D1 读代价：`getAppStyleConfig` 全量读全部行（当前 15 行，目录必须整表读）；
 * `MAX(updated_at_ms)` 走 `ix_ext_annotation_markers_updated_at`（migrations/0121）
 * 索引 seek，读 1 个索引页。两者 `Promise.all` 并行。
 *
 * 注意：请求参数里的 `version` 不是这个 —— 那是 App 本地自增计数器，服务端不读它。
 */
export const GET: APIRoute = async () => {
  const [styles, versionRow] = await Promise.all([
    getAppStyleConfig(env.FEED_DB),
    env.FEED_DB
      .prepare("SELECT MAX(updated_at_ms) AS version FROM ext_annotation_markers")
      .first<{version: number | null}>(),
  ]);
  return jsonResponse(appEnvelope({
    styles,
    version: Number(versionRow?.version ?? 0),
  }));
};
