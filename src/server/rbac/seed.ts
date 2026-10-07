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
  // The mobile app's API access gate, surfaced as a leaf in the role editor's
  // permission tree under 集成 → API (the `api` page, migration 0078). Granting
  // it to a role is what lets that role's account call the `/api/AppBookRequest/*`
  // mobile endpoints — the user → role → permissions path. Deliberately NOT an
  // `api:*` code: ADR-0009 retired that prefix family (migration 0055).
  {code: "app:mobile:access", name: "移动端权限"},
  {code: "content:annotation-markers:read", name: "标注标记查看"},
  {code: "content:annotation-markers:manage", name: "标注标记管理"},
  // content - fangs (方剂 / prescriptions), view-only on the dedicated board
  {code: "content:fang:read", name: "方剂查看"},
  {code: "content:alias:read", name: "别名查看"},
  {code: "content:alias:manage", name: "别名维护"},
  // content - yao (中药) / term (名词): view on the board, manage for its CRUD
  {code: "content:yao:read", name: "中药查看"},
  {code: "content:yao:manage", name: "中药维护"},
  {code: "content:term:read", name: "名词查看"},
  {code: "content:term:manage", name: "名词维护"},
  // Device management + app version/rollout administration (migration 0082).
  // `:read` opens the board, `:manage` unlocks revoke/restore and version writes.
  {code: "system:device:read", name: "设备查看"},
  {code: "system:device:manage", name: "设备管理"},
  {code: "system:app-version:read", name: "版本查看"},
  {code: "system:app-version:manage", name: "版本管理"},
  // App login-time log (ADR-0002, migration 0084). `:read` opens the board.
  // Mirror of PERMISSION_CODES in src/shared/Constants.ts — admin-endpoint-guards
  // and rbac.test.ts keep the two in lockstep.
  {code: "system:login-log:read", name: "登录日志查看"},
  {code: "system:login-log:manage", name: "登录日志管理"},
  // App 消息通知（Announcements，migration 0087）。Mirror of PERMISSION_CODES in
  // src/shared/Constants.ts — admin-endpoint-guards and rbac.test.ts keep the two in lockstep.
  {code: "system:announcement:read", name: "公告查看"},
  {code: "system:announcement:manage", name: "公告管理"},
  // App 搜索权限（Search Permission，migration 0088）。App 能力权限，不进菜单，
  // 由 group_other/unmapped 兜底组承接；运营在「角色管理」页挂到角色叶子即开放搜索。
  {code: "app:search:global", name: "搜索-首页"},
  {code: "app:search:book", name: "搜索-书内"},
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
      // Annotation markers are content work: an editor's rich-text editor
      // fetches the marker list (`:read`) to build its `$X{...}` toolbar
      // buttons. Managing the list stays admin-only.
      "content:annotation-markers:read",
      // Fang (方剂) board is read-only on the page (rows link out to the item
      // editor, which is gated by the generic item permissions): an editor can
      // open it, but composition/status editing happens on the item page.
      "content:fang:read",
      "content:alias:read",
      "content:alias:manage",
      // 中药 / 名词 boards own their rows' identity + publishing state (add /
      // rename / publish / soft-delete / restore), which is content work an
      // editor already does on the item page — so it also gets the `manage`
      // codes. The full body still opens in the item editor.
      "content:yao:read",
      "content:yao:manage",
      "content:term:read",
      "content:term:manage",
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
      // Fang list is read-only content work for a read-only account: it may
      // open the dedicated board and inspect a prescription's composition, but
      // not edit it (no `content:fang:update`).
      "content:fang:read",
      "content:alias:read",
      "content:volume:read",
      // 中药 / 名词 lists are read-only content work for a read-only account.
      "content:term:read",
      "content:yao:read",
      // Without this the editor's marker-list fetch 403s and the account only
      // ever sees the four seed buttons, never the live list (0069).
      "content:annotation-markers:read",
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
  // 合成一个批次：目录很小，但此前逐行写入不是原子的——中途失败会留下只填了一半的目录。
  const statements: D1PreparedStatement[] = [];
  for (const permission of RBAC_PERMISSIONS) {
    statements.push(
      db
        .prepare(
          "INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES (?, ?, ?)",
        )
        .bind(permissionId(permission.code), permission.code, permission.name),
    );
  }
  for (const role of RBAC_ROLES) {
    statements.push(
      db
        .prepare(
          "INSERT OR IGNORE INTO ext_roles (id, code, name) VALUES (?, ?, ?)",
        )
        .bind(roleId(role.code), role.code, role.name),
    );
    for (const code of role.permissions) {
      statements.push(
        db
          .prepare(
            "INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id) VALUES (?, ?)",
          )
          .bind(roleId(role.code), permissionId(code)),
      );
    }
  }
  if (statements.length > 0) await db.batch(statements);
}
