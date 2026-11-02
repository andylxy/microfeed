/**
 * RBAC permission catalog — the code-side source of truth that mirrors the SQL
 * seed in `migrations/0031_ext_rbac_seed.sql`. The worker test asserts the two
 * stay in sync.
 *
 * Permission codes follow the `module:resource:action` convention (DESIGN.md).
 *
 * ⚠️ 标记区 `// <rbac-gen:begin>` … `// <rbac-gen:end>` 由 `yarn rbac:gen`
 * 整体重铺：条目顺序跟 `src/shared/Constants.ts` 的 `PERMISSION_CODES`，新码自动
 * 补进来，新码同时产出一份追加迁移。
 *
 * **标记区内只放条目，不写注释**——生成器重铺时会丢掉区内的所有 `//`。想写
 * 「这个码为何只授 super_admin」「某次改名的沿革」这类判断，写在标记区**外面**
 * （见下方 `CATALOG_NOTES`），或写进 `src/shared/RbacPermissionDocs.ts` 的
 * summary（那里有码做键，重排不会让它跑位）。
 *
 * 早先的实现把注释锚定到后面的码跟着搬家，结果锚定的码被删时，注释会在下一轮
 * 被重新锚定到无关的码上——错得很安静，所以改成了纯数据。
 */

import {RBAC_WILDCARD} from "./resolve";
import {refreshRoleMembersSnapshotStatements} from "./snapshot";

export interface RbacPermissionDef {
  code: string;
  name: string;
}

/**
 * 目录的设计说明：**在标记区之外，生成器不会碰**。
 *
 * 按主题记「为什么这么设计」，不按码逐条记（逐条的理由写进
 * `RbacPermissionDocs.ts`，那里有码做键，重排不会让它跑位）。
 *
 * 它被 `tests/unit/rbac-catalog-single-source.test.ts` 读取并断言非空——不是为了
 * 凑一个消费者，而是把「标记区里不许写注释」这条规则的另一半钉住：注释被禁掉，
 * 必须有一个明确允许写说明的地方，否则下一个人只能二选一（违规写进区里，或干脆
 * 不写）。这条常量的存在本身就是那个答案，测试保证它不会被人清空。
 */
export const CATALOG_NOTES: readonly string[] = [
  "只授 super_admin（走 `*`）的码：书籍状态字典（0142）、权限管理等治理类码。" +
    "它们不进 EDITOR_PERMISSIONS——状态种类影响前台可见面，属于管理侧决策。",
  "`content:chapter:*` 由 `article` 改名而来（0057），为的是与内容读取 API 的 " +
    "`chapters` 路径段一致（ADR-0006）；上游端点里的 `items` 是同一实体，保持上游命名。",
  "App 内容端点的门码按内容域细分（0131，原 `app:mobile:access` 一个码管 8 条端点，" +
    "粒度太粗）。一个码对应一个用途，分发规则见 `src/server/api/api-permissions.ts` 的 " +
    "DOMAIN_RULES。刻意不采用 `api:*` 前缀：那一族前缀已由 ADR-0009 退役（0055）。",
  "`app:search:*` / `app:mingci:view` / `app:nav:read` 等属 App 能力码，" +
    "在 `ext_permission_nodes` 里以 `kind='code'` 节点承接；不默认授予角色，由运营按需挂。",
  "设备管理与 App 版本管理（0082）：`:read` 打开看板，`:manage` 才放开吊销/恢复与版本写入。",
];

// <rbac-gen:begin>
export const RBAC_PERMISSIONS: RbacPermissionDef[] = [
  {code: "content:book:create", name: "新建书"},
  {code: "content:book:read", name: "查看书"},
  {code: "content:book:update", name: "编辑书"},
  {code: "content:book:delete", name: "删除书"},
  {code: "content:book-status:manage", name: "书籍状态管理"},
  {code: "content:category:create", name: "新建分类"},
  {code: "content:category:read", name: "查看分类"},
  {code: "content:category:update", name: "编辑分类"},
  {code: "content:category:delete", name: "删除分类"},
  {code: "content:category:order", name: "分类排序"},
  {code: "content:volume:update", name: "卷结构编辑"},
  {code: "content:volume:read", name: "查看卷"},
  {code: "content:chapter:create", name: "新建章节"},
  {code: "content:chapter:read", name: "查看章节"},
  {code: "content:chapter:update", name: "编辑章节"},
  {code: "content:chapter:delete", name: "删除章节"},
  {code: "system:user:manage", name: "用户管理"},
  {code: "system:role:manage", name: "角色管理"},
  {code: "content:settings:manage", name: "站点设置管理"},
  {code: "system:webhook:manage", name: "Webhook 管理"},
  {code: "content:channel:manage", name: "频道设置管理"},
  {code: "content:review:manage", name: "审核管理"},
  {code: "content:audit:read", name: "审计查看"},
  {code: "content:page:manage", name: "页面管理"},
  {code: "content:site_file:manage", name: "站点文件管理"},
  {code: "media:file:manage", name: "媒体文件管理"},
  {code: "system:api:manage", name: "API 管理"},
  {code: "app:nav:read", name: "App 导航读取"},
  {code: "app:style:read", name: "App 提示样式读取"},
  {code: "app:chapter:read", name: "App 章节目录读取"},
  {code: "app:content:read", name: "App 章节内容读取"},
  {code: "app:fang:read", name: "App 中药方剂读取"},
  {code: "app:zhongyao:read", name: "App 中药读取"},
  {code: "content:annotation-markers:read", name: "标注标记查看"},
  {code: "content:annotation-markers:manage", name: "标注标记管理"},
  {code: "content:fang:read", name: "方剂查看"},
  {code: "content:alias:read", name: "别名查看"},
  {code: "content:alias:manage", name: "别名维护"},
  {code: "content:yao:read", name: "中药查看"},
  {code: "content:yao:manage", name: "中药维护"},
  {code: "content:term:read", name: "名词查看"},
  {code: "content:term:manage", name: "名词维护"},
  {code: "system:device:read", name: "设备查看"},
  {code: "system:device:manage", name: "设备管理"},
  {code: "system:app-version:read", name: "版本查看"},
  {code: "system:app-version:manage", name: "版本管理"},
  {code: "system:login-log:read", name: "登录日志查看"},
  {code: "system:login-log:manage", name: "登录日志管理"},
  {code: "system:announcement:read", name: "公告查看"},
  {code: "system:announcement:manage", name: "公告管理"},
  {code: "system:app-about:read", name: "关于页查看"},
  {code: "system:app-about:manage", name: "关于页管理"},
  {code: "system:app-login-methods:read", name: "登录方式查看"},
  {code: "system:app-login-methods:manage", name: "登录方式管理"},
  {code: "system:mail-settings:read", name: "邮件设置查看"},
  {code: "system:mail-settings:manage", name: "邮件设置管理"},
  {code: "system:cache:manage", name: "缓存管理"},
  {code: "app:search:global", name: "搜索-首页"},
  {code: "app:search:book", name: "搜索-书内"},
  {code: "app:mingci:view", name: "名词解释查看"},
  {code: "app:version:read", name: "版本升级检查"},
  {code: "app:announcement:read", name: "运营公告"},
  {code: "system:cloud-usage:read", name: "Cloudflare 用量查看"},
  {code: "system:app-capability:manage", name: "App 能力管理"},
  {code: RBAC_WILDCARD, name: "超级管理员（全部）"},
];
// <rbac-gen:end>

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
  // 目录写完，持这些角色的账号要把权限快照重算一遍（ADR-0053）。首装时这些
  // DELETE / INSERT 命中 0 行；真正的用处是「已有账号、缺管理员」的修复场景——
  // 那种场景里补授权不重算，那些账号会一直持着旧码。
  for (const role of RBAC_ROLES) {
    statements.push(...refreshRoleMembersSnapshotStatements(db, roleId(role.code)));
  }
  if (statements.length > 0) await db.batch(statements);
}
