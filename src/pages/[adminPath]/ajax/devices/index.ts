/**
 * Device board read endpoint (`/admin/devices/`).
 *
 * `GET ?status=active|revoked` returns every device across every account, joined
 * to its owner (spec §6.1). Free-text filtering is done client-side over the
 * loaded list, so there is no `q` parameter. Guarded by `system:device:read`;
 * revoke/restore live in the sibling `revoke.ts` / `restore.ts` (this project
 * routes one admin verb per file — an `export const POST` on `index.ts` is not
 * routed).
 */
import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {readAllDevices} from "@/server/admin/rbac-handlers";
import {jsonResponse} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

export const GET: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.SYSTEM_DEVICE_READ,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  const status = new URL(request.url).searchParams.get("status");
  const devices = await readAllDevices(env.FEED_DB, {status});
  return jsonResponse(
    {devices},
    {headers: {"cache-control": "private, no-store"}},
  );
};
