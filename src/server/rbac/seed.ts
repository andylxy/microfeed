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
  // 书籍状态字典（migration 0142）。只授 super_admin（走 `*`），不进
  // EDITOR_PERMISSIONS：状态种类影响前台可见面，属于管理侧决策。
  // Mirror of PERMISSION_CODES in src/shared/Constants.ts.
  {code: "content:book-status:manage", name: "书籍状态管理"},
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
  // App 内容端点按内容域细分的门码（migration 0131，原 `app:mobile:access`
  // 一门管 8 条内容端点，粒度过粗）。一个码对应一个用途，分发见
  // `src/server/api/api-permissions.ts` 的 DOMAIN_RULES。与 `app:search:*` /
  // `app:mingci:view` 同族：App 能力权限，不进 ext_menu，在 `ext_permission_nodes`
  // 里以 `kind='code'` 节点承接；不默认授予角色（沿用原 `app:mobile:access`
  // 的授权口径，由运营按需手工挂到角色）。刻意不采用 `api:*` 前缀：
  // ADR-0009 已让那一族前缀退役（migration 0055）。
  {code: "app:nav:read", name: "App 导航读取"},
  {code: "app:style:read", name: "App 提示样式读取"},
  {code: "app:chapter:read", name: "App 章节目录读取"},
  {code: "app:content:read", name: "App 章节内容读取"},
  {code: "app:fang:read", name: "App 中药方剂读取"},
  {code: "app:zhongyao:read", name: "App 中药读取"},
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
  // App login-time log (ADR-0023, migration 0084). `:read` opens the board.
  // Mirror of PERMISSION_CODES in src/shared/Constants.ts — admin-endpoint-guards
  // and rbac.test.ts keep the two in lockstep.
  {code: "system:login-log:read", name: "登录日志查看"},
  {code: "system:login-log:manage", name: "登录日志管理"},
  // App 消息通知（Announcements，migration 0087）。Mirror of PERMISSION_CODES in
  // src/shared/Constants.ts — admin-endpoint-guards and rbac.test.ts keep the two in lockstep.
  {code: "system:announcement:read", name: "公告查看"},
  {code: "system:announcement:manage", name: "公告管理"},
  // App 搜索权限（Search Permission，migration 0088）。两个码是 App 能力权限，
  // 不是后台页面权限，因此不进 ext_menu；它们在 `ext_permission_nodes` 里以
  // `kind='code'` 节点存在（ADR-0038 自持权限树。旧代码的 `group_other` 兜底
  // 逻辑已退役，迁移 0127 把当时的承接页固化为普通行，此后可自由移动）。
  // 运营在「权限树」页把码挂到角色叶子即可开放搜索。
  {code: "app:search:global", name: "搜索-首页"},
  {code: "app:search:book", name: "搜索-书内"},
  // 名词解释查看（MingCi View Permission，migration 0096）。G3 全局单开关 → 一个码。
  // App 能力权限，不进菜单，在 `ext_permission_nodes` 里以 `kind='code'` 节点承接
  // （ADR-0038 自持权限树。旧代码的 `group_other` 兜底逻辑已退役，迁移 0127 把当时
  // 的承接页固化为普通行）；运营在「权限树」页挂到角色叶子即开放阅读页
  // `$g{名词解释}` 的底层名词数据（无权限时列表不加载）。
  {code: "app:mingci:view", name: "名词解释查看"},
  // 版本升级 / 运营公告（2026-10-16，migration 0119）。与 app:search:* / app:mingci:view
  // 同族：App 能力权限，不建菜单行、不进 ext_menu，在 `ext_permission_nodes`
  // 里以 `kind='code'` 节点承接（ADR-0038 自持权限树。旧代码的 `group_other`
  // 兜底逻辑已退役，迁移 0127 把当时的承接页固化为普通行）。
  {code: "app:version:read", name: "版本升级检查"},
  {code: "app:announcement:read", name: "运营公告"},
  // Cloudflare 使用情况看板（migration 0123）。只读运维看板，一个码覆盖 D1 / R2 /
  // Workers 三个分区；只授 super_admin（拍板 B1），不进 EDITOR_PERMISSIONS。
  // Mirror of PERMISSION_CODES in src/shared/Constants.ts.
  {code: "system:cloud-usage:read", name: "Cloudflare 用量查看"},
  // 权限管理页（migration 0130，ADR-0039）。App 能力控制不另设入口：权限管理
  // 单页内按终端归属分区，PC 端与 App 端共用这一页。只授 super_admin（走 `*`），
  // 不进 EDITOR_PERMISSIONS。Mirror of PERMISSION_CODES in src/shared/Constants.ts.
  {code: "system:app-capability:manage", name: "App 能力管理"},
  // wildcard
  {code: RBAC_WILDCARD, name: "超级管理员（全部）"},
];

export interface RbacRoleDef {
  code: string;
  name: string;
  permissions: string[];
}

// editor 的权限集。readonly 现在与 editor 相同（用户 2026-10-16 要求同步），故两者
// 共用这份列表——若以后需要分化，把 readonly 分出独立列表即可。各码理由见下方注释。
const EDITOR_PERMISSIONS: readonly string[] = [
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
  // App 自身要用的两个能力码（migration 0119）。与 `app:search:*` /
  // `app:mingci:view` 不同 —— 那两个由运营按需手工授权，这两个**默认授予**：
  // `/api/app/version` 是 App 每次启动的升级检查，`/api/app/announcements`
  // 是运营公告通道；缺了它们，一个刚装好的 App 查不了升级、收不到公告，
  // 而 App 的内置凭证（`SecurityConfig.getApiKey()`）用的正是这个角色。
  "app:version:read",
  "app:announcement:read",
];

export const RBAC_ROLES: RbacRoleDef[] = [
  {
    code: "super_admin",
    name: "超级管理员",
    permissions: [RBAC_WILDCARD],
  },
  {
    code: "editor",
    name: "编辑",
    permissions: [...EDITOR_PERMISSIONS],
  },
  {
    // 默认角色（`DEFAULT_USER_ROLE`，新账号默认拿到）。2026-10-16 起与 editor 相同
    // （用户要求同步）：不再只读，而是完整编辑权限（含内容写、manage、App 能力码）。
    // 与 editor 共用 {@link EDITOR_PERMISSIONS}——若以后需要分化，分出独立列表。
    // 注：角色 code 仍是 `readonly`（历史遗留，r_readonly 被多处引用），但 name 已
    // 改为「默认编辑」以反映实际权限。
    code: "readonly",
    name: "默认编辑",
    permissions: [...EDITOR_PERMISSIONS],
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
