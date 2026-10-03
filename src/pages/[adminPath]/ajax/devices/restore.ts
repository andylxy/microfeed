/**
 * Restore a previously revoked device (`POST {userId, deviceId}`).
 *
 * Guarded by `system:device:manage`. The inverse of `revoke.ts`, sharing one
 * handler with it and `restoreUserDevice`'s audit trail.
 */
import {deviceMutationRoute} from "@/server/admin/device-handlers";

export const POST = deviceMutationRoute("restore");
