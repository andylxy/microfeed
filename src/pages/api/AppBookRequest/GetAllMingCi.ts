import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {jsonResponse} from "@/server/http";
import {appEnvelope} from "@/server/tcm/envelope";
import {getAppAllTerms} from "@/server/tcm/reads";
import {resolveMingCiPermission} from "@/server/app-mingci-permission/resolve";

// 有码走原公共缓存；缺码 / 无凭证 / 解析失败一律 no-store（fail-closed，详见下方说明）。
const PUBLIC_CACHE: ResponseInit["headers"] = {"cache-control": "public, max-age=300"};
const NO_STORE: ResponseInit["headers"] = {"cache-control": "no-store"};

export const GET: APIRoute = async ({request}) => {
  // 纵深防御（R1 两者都做之一）：名词列表又称「本地名词缓存底表」，决定 $g{} 能否展开。
  // 即使客户端越权、缓存逃逸或跑旧版本，服务端也绝不吐名词数据。
  // 这里**复用** `resolveMingCiPermission`（与 /api/app/mingci-permission 同一事实来源），
  // 取 token → 校验 → 解析权限全链只有一份实现，内容端点与权限端点的判定逻辑不会漂移。
  // 读不到「确定有码」的任何情况（缺码 / 无凭证 / DB 故障）都 fail-closed 返回空数组 + no-store；
  // 这跟独立端点的 401/500 不同：本路是「内容端点」，fail-closed 必须**静默空数据**而非报错，
  // 否则客户端没法区分「服务端炸了」与「没权限」，且会破坏既有信封约定（始终 200 + 数组）。
  const outcome = await resolveMingCiPermission(env.FEED_DB, request);
  const allowed = outcome.kind === "ok" && outcome.allowed;
  if (!allowed) {
    return jsonResponse(appEnvelope([]), {headers: NO_STORE});
  }
  return jsonResponse(appEnvelope(await getAppAllTerms(env.FEED_DB)), {
    headers: PUBLIC_CACHE,
  });
};
