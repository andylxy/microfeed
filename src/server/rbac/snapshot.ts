/**
 * 权限快照表 `ext_user_permissions` 的读路径与重算语句（ADR-0053）。
 *
 * 后台鉴权原来要 3 条 SQL 读 27 行（权限四表 JOIN + 后台准入 + 封禁闸门），
 * 实测 25.33 µs。快照把「某账号持有哪些权限码」按账号物化，读侧降为一条点查、
 * 一行、7.67 µs。
 *
 * 权威仍在 `ext_user_roles` / `ext_role_permissions` / `ext_roles`。这张表是
 * 仓库里第二个镜像（第一个是 `auth_user.role`），所以：
 *   - 写入只能走这里导出的两个 `*Statement(s)` 构造器，不要就地写 SQL；
 *   - 读侧查不到即无权限，写路径漏一处就是 403 或越权。
 *
 * `banned` / `banReason` / `banExpires` 刻意不进快照：它们由 better-auth admin
 * 插件自己写库（`rbac-handlers.ts` 调 `api.banUser`），应用层看不到写入时刻。
 * 读路径每次把 `banned` 与 `must_change_password` 现查，与快照 LEFT JOIN 成一条。
 */

import type {UserAccess} from "./resolve";

/** 后台鉴权一次取回的全部字段。 */
export interface SnapshotGate {
  permissions: Set<string>;
  /** 持有会员角色的并集；产品语义见 ADR-0044（App 内容分档）。 */
  isMember: boolean;
  /** 持有角色是否允许登录后台（`ext_roles.allow_admin_login` 的并集）。 */
  adminLoginAllowed: boolean;
  banned: boolean;
  mustChangePassword: boolean;
}

/**
 * 快照里的 `codes` 是 JSON 数组。
 *
 * 坏值就地抛出（AGENTS.md「fast-fail」）：这份数据只由本模块写入，读到坏值说明
 * 上游已经别处出错。让账号带着半截权限继续跑，比在这个位置直接报错更难查。
 */
function parseCodes(raw: string | null): Set<string> {
  if (raw === null) return new Set();
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new TypeError("ext_user_permissions.codes 的值必须是 JSON 数组");
  }
  return new Set(
    parsed.filter((code): code is string => typeof code === "string"),
  );
}

/**
 * 读一个账号的快照，连同它的封禁位与待改密标记。
 *
 * 返回 `null` 表示账号本身不存在 —— 调用方按封禁处理，与 `accountIsBlocked`
 * 口径一致。账号存在但没有快照行（零角色）时返回非 null 且权限为空集合，
 * 也就是「无权限」，与 ADR-0053 约束 3 一致。
 */
export async function readSnapshotGate(
  db: D1Database,
  userId: string,
): Promise<SnapshotGate | null> {
  const row = await db
    .prepare(
      `SELECT u.banned AS banned,
              COALESCE(sec.must_change_password, 0) AS mustChange,
              s.codes AS codes,
              s.is_member AS isMember,
              s.admin_login_allowed AS adminLoginAllowed
         FROM auth_user u
         LEFT JOIN ext_user_security sec ON sec.user_id = u.id
         LEFT JOIN ext_user_permissions s ON s.user_id = u.id
         WHERE u.id = ?`,
    )
    .bind(userId)
    .first<{
      adminLoginAllowed: number | null;
      banned: number | null;
      codes: string | null;
      isMember: number | null;
      mustChange: number;
    }>();
  if (!row) return null;
  return {
    adminLoginAllowed: Number(row.adminLoginAllowed) === 1,
    banned: Number(row.banned) === 1,
    isMember: Number(row.isMember) === 1,
    mustChangePassword: Number(row.mustChange) === 1,
    permissions: parseCodes(row.codes),
  };
}

/**
 * App 凭证路径的缓存未命中时回源。会员标记与权限码出自同一行，四个 App
 * 内容端点与 `requiredApiPermission` 因此不会拿到互相矛盾的两份答案。
 *
 * 无快照行时返回空权限（fail-closed），与后台路径一致。
 */
export async function readSnapshotAccess(
  db: D1Database,
  userId: string,
): Promise<UserAccess> {
  const row = await db
    .prepare(
      `SELECT s.codes AS codes, s.is_member AS isMember
         FROM ext_user_permissions s
         WHERE s.user_id = ?`,
    )
    .bind(userId)
    .first<{codes: string; isMember: number | null}>();
  if (!row) return {isMember: false, permissions: new Set()};
  return {
    isMember: Number(row.isMember) === 1,
    permissions: parseCodes(row.codes),
  };
}

/**
 * 聚合语句：把一个账号的角色授权合成一行。
 *
 * `FILTER` 不能省：`member` 这类零授权角色会经 `LEFT JOIN` 产出 null，混进
 * JSON 数组；而写成 `WHERE p.code IS NOT NULL` 会把「只有零授权角色」的账号
 * 整行滤掉，连 `MAX(r.is_member)` 一起丢掉。
 */
const AGGREGATE_SELECT = `SELECT ur.user_id AS user_id,
              COALESCE(
                json_group_array(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL),
                '[]'
              ) AS codes,
              MAX(r.is_member) AS is_member,
              MAX(r.allow_admin_login) AS allow_admin_login,
              CURRENT_TIMESTAMP AS updated_at
         FROM ext_user_roles ur
         JOIN ext_roles r ON r.id = ur.role_id
         LEFT JOIN ext_role_permissions rp ON rp.role_id = ur.role_id
         LEFT JOIN ext_permissions p ON p.id = rp.permission_id`;

/**
 * 重算一个账号的快照，供放进 `db.batch([...])`。
 *
 * 先 `DELETE` 再 `INSERT … SELECT`：账号被清空角色时（`replaceUserRoles` 传空
 * 数组）聚合命中 0 行，只删不插才是正确结果；单独一条 `INSERT` 会把旧快照留
 * 在表里，那不是 403，是继续持旧权限。
 *
 * 调用方负责把这两条排在真源改动**之后**：D1 的 `batch` 在单个事务内顺序执行，
 * 顺序决定聚合看到的是新值还是旧值。
 */
export function refreshUserSnapshotStatements(
  db: D1Database,
  userId: string,
): D1PreparedStatement[] {
  return [
    db
      .prepare("DELETE FROM ext_user_permissions WHERE user_id = ?")
      .bind(userId),
    db
      .prepare(
        `INSERT INTO ext_user_permissions
           (user_id, codes, is_member, admin_login_allowed, updated_at)
         ${AGGREGATE_SELECT}
         WHERE ur.user_id = ?
         GROUP BY ur.user_id`,
      )
      .bind(userId),
  ];
}

/**
 * 重算持有某个角色的全部账号，供放进 `db.batch([...])`。
 *
 * 用于「角色本身变了」的三条路径：改角色授权（`replaceRolePermissions`）、
 * 改「允许登录后台」、改会员标记。成员关系没变，所以按角色反查成员即可。
 */
export function refreshRoleMembersSnapshotStatements(
  db: D1Database,
  roleId: string,
): D1PreparedStatement[] {
  const members = "SELECT user_id FROM ext_user_roles WHERE role_id = ?";
  return [
    db
      .prepare(
        `DELETE FROM ext_user_permissions WHERE user_id IN (${members})`,
      )
      .bind(roleId),
    db
      .prepare(
        `INSERT INTO ext_user_permissions
           (user_id, codes, is_member, admin_login_allowed, updated_at)
         ${AGGREGATE_SELECT}
         WHERE ur.user_id IN (${members})
         GROUP BY ur.user_id`,
      )
      .bind(roleId),
  ];
}
