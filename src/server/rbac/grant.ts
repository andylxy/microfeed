/**
 * 账号 → 角色的授予语句，供放进 `db.batch([...])`。
 *
 * 五条建号路径都要"建号 + 授予 + 重算快照"这一组动作，此前各写各的，句式与
 * 顺序容易漂。统一到这里：语句一律是 `INSERT OR IGNORE ... SELECT id FROM
 * "auth_user" WHERE id = ?`——
 *
 *   - 对**已存在**的账号与 `VALUES` 写法等价；
 *   - 对"同一批里刚被 `INSERT OR IGNORE` 忽略掉的账号"（QQ 并发首登、重名）
 *     查不到那一行，天然是空操作，不会把角色授给一个不存在的 id（那是外键违例，
 *     会让整批 reject）。
 *
 * 快照语句必须紧跟授予：ADR-0053 的 9 个重算点漏一个，授权就只写进
 * `ext_user_roles` 而不生效。
 */

import {DEFAULT_USER_ROLE} from "@/shared/Rbac";
import {roleId} from "./seed";
import {refreshUserSnapshotStatements} from "./snapshot";

/** 授予给定角色码并同批重算权限快照。 */
export function grantRoleStatements(
  db: D1Database,
  userId: string,
  codes: readonly string[],
): D1PreparedStatement[] {
  return [
    ...codes.map((code) =>
      db
        .prepare(
          "INSERT OR IGNORE INTO ext_user_roles (user_id, role_id) " +
            'SELECT "id", ? FROM "auth_user" WHERE "id" = ?',
        )
        .bind(roleId(code), userId)),
    ...refreshUserSnapshotStatements(db, userId),
  ];
}

/** 建号时的兜底：没有指定角色就落到 {@link DEFAULT_USER_ROLE}（只读）。 */
export function grantDefaultRoleStatements(
  db: D1Database,
  userId: string,
): D1PreparedStatement[] {
  return grantRoleStatements(db, userId, [DEFAULT_USER_ROLE]);
}
