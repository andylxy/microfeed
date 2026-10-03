/**
 * Revoke one device (`POST {userId, deviceId}`) from the device board.
 *
 * Guarded by `system:device:manage` (read-only holders may look, not act). The
 * handler — shared with `restore.ts` — reuses the same `revokeUserDevice` the
 * account page uses, including its audit row, so both entry points write one
 * consistent trail.
 */
import {deviceMutationRoute} from "@/server/admin/device-handlers";

export const POST = deviceMutationRoute("revoke");
