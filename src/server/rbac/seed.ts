/**
 * RBAC permission catalog — the code-side source of truth that mirrors the SQL
 * seed in `migrations/0031_ext_rbac_seed.sql`. The worker test asserts the two
 * stay in sync.
 *
 * Permission codes follow the `module:resource:action` convention (DESIGN.md).
 */

import {RBAC_WILDCARD} from "./resolve";

export interface RbacPermissionDef {
  code: string;
  name: string;
}

export const RBAC_PERMISSIONS: RbacPermissionDef[] = [
  // content - books
  {code: "content:book:create", name: "新建书"},
  {code: "content:book:read", name: "查看书"},
  {code: "content:book:update", name: "编辑书"},
  {code: "content:book:delete", name: "删除书"},
  // content - categories
  {code: "content:category:create", name: "新建分类"},
  {code: "content:category:read", name: "查看分类"},
  {code: "content:category:update", name: "编辑分类"},
  {code: "content:category:delete", name: "删除分类"},
  {code: "content:category:order", name: "分类排序"},
  // content - volumes
  {code: "content:volume:update", name: "卷结构编辑"},
  {code: "content:volume:read", name: "查看卷"},
  // content - chapters (renamed from `article` in migration 0057 so the codes
  // match the `chapters` path segment of the content read API, ADR-0006;
  // `items` in upstream endpoints is the same entity and stays as upstream has it)
  {code: "content:chapter:create", name: "新建章节"},
  {code: "content:chapter:read", name: "查看章节"},
  {code: "content:chapter:update", name: "编辑章节"},
  {code: "content:chapter:delete", name: "删除章节"},
  // system
  {code: "system:user:manage", name: "用户管理"},
  {code: "system:role:manage", name: "角色管理"},
  {code: "content:settings:manage", name: "站点设置管理"},
  {code: "system:webhook:manage", name: "Webhook 管理"},
  // menu - admin menu visibility (migration 0040). A menu row binds at most one
  // of these; a menu with no code is public. `system:api:manage` gates opening
  // the dashboard's API area. What an API call may read or write is decided by
  // the same `content:*:*` codes the dashboard uses (ADR-0009).
  {code: "content:channel:manage", name: "频道设置管理"},
  {code: "content:review:manage", name: "审核管理"},
  {code: "content:audit:read", name: "审计查看"},
  {code: "content:page:manage", name: "页面管理"},
  {code: "content:site_file:manage", name: "站点文件管理"},
  {code: "media:file:manage", name: "媒体文件管理"},
  {code: "system:api:manage", name: "API 管理"},
  // wildcard
  {code: RBAC_WILDCARD, name: "超级管理员（全部）"},
];

export interface RbacRoleDef {
  code: string;
  name: string;
  permissions: string[];
}

export const RBAC_ROLES: RbacRoleDef[] = [
  {
    code: "super_admin",
    name: "超级管理员",
    permissions: [RBAC_WILDCARD],
  },
  {
    code: "editor",
    name: "编辑",
    permissions: [
      "content:book:read",
      "content:book:update",
      "content:book:create",
      "content:category:read",
      "content:category:update",
      "content:volume:read",
      "content:volume:update",
      // Content menus bind `content:chapter:read` / `content:chapter:create`, so
      // an editor without these cannot even see the item list or the import
      // page. `content:chapter:update` was already required by the feed write
      // path — without it an editor could not edit or add a chapter at all.
      // `content:chapter:delete` is deliberately withheld.
      "content:chapter:read",
      "content:chapter:create",
      "content:chapter:update",
      // Pages and site files are content work; review, audit, channel settings
      // and the API area stay admin-only.
      "content:page:manage",
      "content:site_file:manage",
    ],
  },
  {
    // Read-only content role, seeded by migration 0043 and the default handed
    // to a newly created account (see `DEFAULT_USER_ROLE`). Read codes only —
    // no writes, no `*:manage`, no API grants.
    code: "readonly",
    name: "只读",
    permissions: [
      "content:chapter:read",
      "content:book:read",
      "content:category:read",
      "content:volume:read",
    ],
  },
];

export function permissionId(code: string): string {
  return `p_${code.replace(/:/g, "_")}`;
}

export function roleId(code: string): string {
  return `r_${code}`;
}

/** Idempotent seed (used by tests and as the documented catalog reference). */
export async function seedRbac(db: D1Database): Promise<void> {
  for (const permission of RBAC_PERMISSIONS) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES (?, ?, ?)",
      )
      .bind(permissionId(permission.code), permission.code, permission.name)
      .run();
  }
  for (const role of RBAC_ROLES) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO ext_roles (id, code, name) VALUES (?, ?, ?)",
      )
      .bind(roleId(role.code), role.code, role.name)
      .run();
    for (const code of role.permissions) {
      await db
        .prepare(
          "INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id) VALUES (?, ?)",
        )
        .bind(roleId(role.code), permissionId(code))
        .run();
    }
  }
}
