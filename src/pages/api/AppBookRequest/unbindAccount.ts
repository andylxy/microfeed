import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {
  appUnbindAccount,
  bindingEnvelope,
} from "@/server/tcm/app-account-binding";

// 解绑 QQ（ADR-0014 §4.2）。不限流：不校验口令，且 `requireAppUser` 已要求
// 有效 `mflc_` 令牌；解绑自带 I14 前置（必须有口令行），不会把账号锁死。
export const POST: APIRoute = async ({request}) => {
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  return bindingEnvelope(
    await appUnbindAccount(env as never, request, body),
  );
};
