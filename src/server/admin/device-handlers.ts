/**
 * 设备面板（`/admin/devices/`）上两个设备变更动作的路由工厂。
 *
 * 吊销与恢复只差「调用哪个函数」和「记哪条审计动作」，所以它们在这里共用一个
 * handler，让路由文件保持轻薄（AGENTS.md「源码架构」：路由只做协调，逻辑放在
 * server 模块里）。两者都要求 `system:device:manage`；`revokeUserDevice` /
 * `restoreUserDevice` 本身与其余设备数据访问放在一起，位于 `rbac-handlers.ts`。
 */

import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {restoreUserDevice, revokeUserDevice} from "./rbac-handlers";
import {jsonResponse, localizedError} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";

export type DeviceMutationAction = "revoke" | "restore";

/** `POST {userId, deviceId}` -> `{ok: true}`，或一个本地化的 4xx。 */
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
      return localizedError(request, "errors.rbac.missingDeviceIdentity", 400);
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
