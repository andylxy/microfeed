/**
 * 「当前凭证能不能取运营公告」的取值逻辑。
 *
 * <p>与 {@code version} / {@code search} / {@code mingci} 同构：读 Bearer、校验令牌、
 * 解析权限集合、按权限码判布尔。放在 {@code src/server/} 的理由见
 * {@code @/server/app/permission/version} 的模块注释（AGENTS.md「源码架构」）。</p>
 *
 * <p><b>fail-closed</b>：同 {@code version} —— 拿不到确定的权限集合时返回错误形态，
 * 绝不返回 {@code allowed: false}。</p>
 */

import {permissionsInclude} from "@/server/rbac/resolve";
import {PERMISSION_CODES} from "@/shared/Constants";
import {type AppPermissionOutcome, resolveAppPermissionSet} from "./resolve";

export type AnnouncementPermissionOutcome = AppPermissionOutcome<{allowed: boolean}>;

/**
 * 解出当前凭证对运营公告权限码 {@code app:announcement:read} 的持有情况。
 *
 * <p>权限码取自 {@link PERMISSION_CODES}（三镜像），不写第四份字面量。</p>
 */
export async function resolveAnnouncementPermission(
  db: D1Database,
  request: Request,
): Promise<AnnouncementPermissionOutcome> {
  const set = await resolveAppPermissionSet(db, request, "app/announcement");
  if (set.kind === "ok") {
    return {
      kind: "ok",
      allowed: permissionsInclude(set.permissions, PERMISSION_CODES.APP_ANNOUNCEMENT_READ),
    };
  }
  // 三种错误形态与 outcome 中逐字一致，直接透传即可。
  return set;
}
