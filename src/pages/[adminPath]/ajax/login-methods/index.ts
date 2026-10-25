/**
 * Login methods config read (`GET /admin/ajax/login-methods/`).
 *
 * Returns the current `app_login_methods` config, guarded by
 * `system:app-login-methods:read`. Writes live in `save.ts` (`:manage`).
 * Reads go straight to D1: the admin board is the authoritative view and
 * must not be subject to the app-side 2h cache (ADR-0050 D3).
 */
import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import FeedDb from "@/server/feed/FeedDb";
import {readLoginMethodsConfig} from "@/server/app/login/config";
import {jsonResponse} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

export const GET: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.SYSTEM_APP_LOGIN_METHODS_READ,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  return jsonResponse(
    {config: await readLoginMethodsConfig(new FeedDb(env, request))},
    {headers: {"cache-control": "private, no-store"}},
  );
};
