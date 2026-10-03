/**
 * Route factory for the two device mutations on the device board
 * (`/admin/devices/`).
 *
 * Revoke and restore differ only in which function they call and which audit
 * action they record, so they share one handler here and the route files stay
 * thin (AGENTS.md「源码架构」: routes coordinate, server modules hold logic).
 * Both require `system:device:manage`; `revokeUserDevice` / `restoreUserDevice`
 * themselves live next to the rest of the device data access in
 * `rbac-handlers.ts`.
 */

import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {restoreUserDevice, revokeUserDevice} from "./rbac-handlers";
import {jsonResponse, localizedError} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

export type DeviceMutationAction = "revoke" | "restore";

/** `POST {userId, deviceId}` -> `{ok: true}`, or a localized 4xx. */
export function deviceMutationRoute(action: DeviceMutationAction): APIRoute {
  const mutate = action === "revoke" ? revokeUserDevice : restoreUserDevice;
  return async ({locals, request}) => {
    const guard = await requireRbac(
      locals,
      PERMISSION_CODES.SYSTEM_DEVICE_MANAGE,
      request,
      env.FEED_DB,
    );
    if (guard) return guard;
    const body = await request.json().catch(() => null) as
      | {deviceId?: unknown; userId?: unknown}
      | null;
    const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
    const deviceId = typeof body?.deviceId === "string" ? body.deviceId.trim() : "";
    if (!userId || !deviceId) {
      return localizedError(request, "errors.rbac.invalidUserAssignment", 400);
    }
    const result = await mutate(env.FEED_DB, userId, deviceId, {
      action: `device.${action}`,
      actor: locals.authUser,
      detail: deviceId,
      target: userId,
    });
    if (!result.ok) {
      return localizedError(
        request,
        `errors.rbac.${result.reason}`,
        result.reason === "unknownUser" || result.reason === "unknownDevice"
          ? 404
          : 400,
      );
    }
    return jsonResponse({ok: true});
  };
}
