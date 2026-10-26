/**
 * App 凭证鉴权用的角色对象缓存（方案 4.3）。
 *
 * `resolveUserAccess` 每次鉴权要读四张表（`ext_user_roles` / `ext_roles` /
 * `ext_role_permissions` / `ext_permissions`），本机快照 24 行。角色、授权、
 * 用户角色分配都是人工月级操作，按 `userId` 缓存 24 小时，写路径按用户清。
 *
 * 命中时 `permissions` 必须还原成 `Set`：`permissionsInclude` 用 `.has()`
 * 判定，数组会让它静默失效（所有请求都判无权限）。
 *
 * 总开关与桶开关、TTL 档都来自控制项（`cache-control.ts`）。条目带
 * `APP_CACHE_TAG` 与分桶标签，供控制面「清空全部 / 清空单个桶」。
 */

import {TTL_TIER_OF} from "@/shared/AppCacheControl";
import type {UserAccess} from "@/server/rbac/resolve";
import {resolveUserAccess} from "@/server/rbac/resolve";
import {APP_CACHE_TAG, readAppCacheControl} from "./cache-control";
import {
  deleteWorkerCacheKeys,
  readJsonEntry,
  workerCacheKey,
  writeJsonEntry,
} from "./worker-cache";

const IDENTITY_ORIGIN = "https://app-identity.microfeed.internal";

function userAccessKey(userId: string): URL {
  return workerCacheKey(
    IDENTITY_ORIGIN,
    `/identity/access/${encodeURIComponent(userId)}`,
  );
}

function fromCached(value: unknown): UserAccess | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.permissions)) return null;
  if (!record.permissions.every((code) => typeof code === "string")) return null;
  if (typeof record.isMember !== "boolean") return null;
  return {
    isMember: record.isMember,
    permissions: new Set(record.permissions as string[]),
  };
}

/**
 * read-through 读取：命中 0 行 D1；未命中 / 坏条目回源一次并写回。
 * 写失败静默退化为直读（与 `cachedJson` 同一策略）。
 */
export async function cachedUserAccess(
  db: D1Database,
  userId: string,
): Promise<UserAccess> {
  const control = await readAppCacheControl();
  const bypass = !control.enabled || !control.buckets.identity;
  const key = userAccessKey(userId);
  if (!bypass) {
    const hit = fromCached(await readJsonEntry<unknown>(key));
    if (hit !== null) return hit;
  }
  const access = await resolveUserAccess(db, userId);
  if (!bypass) {
    const ttl = control.ttls[TTL_TIER_OF.identity];
    await writeJsonEntry(
      key,
      {isMember: access.isMember, permissions: [...access.permissions]},
      ttl,
      [APP_CACHE_TAG, `${APP_CACHE_TAG}:identity`],
    );
  }
  return access;
}

/**
 * 清掉一批用户的角色对象。调用方负责先查出受影响的 `user_id`：这条查询
 * 属于 RBAC 的知识，放在缓存层是错位。
 */
export async function purgeUsersAccess(userIds: string[]): Promise<void> {
  await deleteWorkerCacheKeys(userIds.map(userAccessKey));
}

/** 清掉一个用户的角色对象。 */
export async function purgeUserAccess(userId: string): Promise<void> {
  await purgeUsersAccess([userId]);
}
