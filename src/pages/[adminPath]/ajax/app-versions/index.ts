/**
 * App version board read (`GET /admin/ajax/app-versions/`).
 *
 * Returns the singleton version configuration plus the rollout rules, guarded
 * by `system:app-version:read`. Writes live in `save.ts` (`:manage`).
 */
import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {
  readAppVersionConfig,
  readRolloutRules,
} from "@/server/app-version/config";
import {jsonResponse} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

export const GET: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.SYSTEM_APP_VERSION_READ,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  const [config, rules] = await Promise.all([
    readAppVersionConfig(env.FEED_DB),
    readRolloutRules(env.FEED_DB),
  ]);
  return jsonResponse(
    {config, rules},
    {headers: {"cache-control": "private, no-store"}},
  );
};
