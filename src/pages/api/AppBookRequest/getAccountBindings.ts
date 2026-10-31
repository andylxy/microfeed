import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {appGetAccountBindings, bindingEnvelope} from "@/server/tcm/app-account-binding";

// 绑定状态查询（ADR-0014 §4.0）。只读，不需要限流：没有可爆破的凭据输入，
// 且 `requireAppUser` 已经要求携带有效的 `mflc_` 令牌。
export const GET: APIRoute = async ({request}) =>
  bindingEnvelope(await appGetAccountBindings(env as never, request));
