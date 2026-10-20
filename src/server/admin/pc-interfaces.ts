/**
 * PC 端接口清单（migration 0131）：权限管理页「PC 端管理」分类下、挂在各码
 * 结点下面的只读接口叶子的数据源。与 `app-interfaces.ts` 同构——App 端挂
 * `/api/AppBookRequest/*` 与 `/api/app/*`，PC 端挂后台自己的 `ajax/*` 端点。
 *
 * 门码与方法的权威在 `src/pages/[adminPath]/ajax/**` 的路由文件（守卫写在
 * 路由层或其再导出的 handler 里）；这里是展示用的静态目录，由
 * `tests/unit/server/pc-interfaces.test.ts` 逐行防漂移：每行核对
 *   - 路径对应的路由文件存在；
 *   - 路由文件（或其再导出目标）确实引用该行的 `PERMISSION_CODES` 常量；
 *   - 路由文件确实导出该行的 HTTP 方法。
 * 路由改门码或改方法而忘记同步目录时，测试直接红。
 *
 * 只读：运行时权威仍是各路由文件自己的 `requireRbac` 调用。
 */

import type {InterfaceCatalogRow} from "@/shared/AppInterface";
import {adminBasePath, DEFAULT_ADMIN_PATH} from "@/shared/AdminPath";

/** 一行 = 一个端点；门码可多枚（同一方法按请求体分create/update，如 feed POST）。 */
type CatalogEntry = readonly [method: string, path: string, ...codes: string[]];

const C: readonly CatalogEntry[] = [
  // 书籍（content:book:*）
  ["GET", "/admin/ajax/books", "content:book:read"],
  ["POST", "/admin/ajax/books", "content:book:create"],
  ["PUT", "/admin/ajax/books/[bookId]", "content:book:update"],
  ["DELETE", "/admin/ajax/books/[bookId]", "content:book:delete"],
  // 分类（content:category:*）
  ["GET", "/admin/ajax/categories", "content:category:read"],
  ["GET", "/admin/ajax/categories/[categoryId]", "content:category:read"],
  ["POST", "/admin/ajax/categories", "content:category:create"],
  ["PUT", "/admin/ajax/categories/[categoryId]", "content:category:update"],
  ["DELETE", "/admin/ajax/categories/[categoryId]", "content:category:delete"],
  ["POST", "/admin/ajax/categories/order", "content:category:order"],
  // 卷（content:volume:*）
  ["GET", "/admin/ajax/volumes", "content:volume:read"],
  ["GET", "/admin/ajax/volumes/entries", "content:volume:read"],
  ["POST", "/admin/ajax/volumes/assign", "content:volume:update"],
  ["POST", "/admin/ajax/volumes/order", "content:volume:update"],
  ["POST", "/admin/ajax/volumes/rename", "content:volume:update"],
  ["POST", "/admin/ajax/volumes/reorder", "content:volume:update"],
  // 章节（content:chapter:*）。feed POST 按 body 分发 create / update / delete，
  // 三枚码同挂一行；delete 不是独立的 DELETE 方法。
  ["GET", "/admin/ajax/items", "content:chapter:read"],
  ["GET", "/admin/ajax/items/[itemId]", "content:chapter:read"],
  ["GET", "/admin/ajax/search", "content:chapter:read"],
  ["GET", "/admin/ajax/tcm/fang-references", "content:chapter:read"],
  [
    "POST",
    "/admin/ajax/feed",
    "content:chapter:create",
    "content:chapter:update",
    "content:chapter:delete",
  ],
  ["POST", "/admin/ajax/r2-ops", "content:chapter:update"],
  ["DELETE", "/admin/ajax/r2-ops", "content:chapter:update"],
  ["POST", "/admin/ajax/audit/[itemId]", "content:chapter:update"],
  // 审计（content:audit:read）
  ["GET", "/admin/ajax/audit", "content:audit:read"],
  ["GET", "/admin/ajax/audit/[itemId]", "content:audit:read"],
  // 标注标记（content:annotation-markers:*）
  ["GET", "/admin/ajax/annotation-markers/list", "content:annotation-markers:read"],
  ["POST", "/admin/ajax/annotation-markers/create", "content:annotation-markers:manage"],
  ["POST", "/admin/ajax/annotation-markers/update", "content:annotation-markers:manage"],
  ["POST", "/admin/ajax/annotation-markers/delete", "content:annotation-markers:manage"],
  // 别名 / 方剂 / 中药 / 名词（content:alias|fang|yao|term:*）。
  // yao/term 的动词共用一个 action 文件，全部 POST、按 body 的 action 字段分发。
  ["PUT", "/admin/ajax/aliases", "content:alias:manage"],
  ["GET", "/admin/ajax/fangs", "content:fang:read"],
  ["GET", "/admin/ajax/yao", "content:yao:read"],
  ["POST", "/admin/ajax/yao/action", "content:yao:manage"],
  ["POST", "/admin/ajax/yao/restore", "content:yao:manage"],
  ["GET", "/admin/ajax/term", "content:term:read"],
  ["POST", "/admin/ajax/term/action", "content:term:manage"],
  ["POST", "/admin/ajax/term/restore", "content:term:manage"],
  // 页面（content:page:manage）
  ["GET", "/admin/ajax/pages", "content:page:manage"],
  ["POST", "/admin/ajax/pages", "content:page:manage"],
  ["GET", "/admin/ajax/pages/[pageId]", "content:page:manage"],
  ["PUT", "/admin/ajax/pages/[pageId]", "content:page:manage"],
  ["DELETE", "/admin/ajax/pages/[pageId]", "content:page:manage"],
  ["POST", "/admin/ajax/pages/[pageId]/purge", "content:page:manage"],
  ["PUT", "/admin/ajax/pages/order", "content:page:manage"],
  // 站点文件（content:site_file:manage）
  ["GET", "/admin/ajax/site-files", "content:site_file:manage"],
  ["POST", "/admin/ajax/site-files", "content:site_file:manage"],
  ["GET", "/admin/ajax/site-files/[siteFileId]", "content:site_file:manage"],
  ["PUT", "/admin/ajax/site-files/[siteFileId]", "content:site_file:manage"],
  ["DELETE", "/admin/ajax/site-files/[siteFileId]", "content:site_file:manage"],
  ["POST", "/admin/ajax/site-files/[siteFileId]/publish", "content:site_file:manage"],
  ["POST", "/admin/ajax/site-files/[siteFileId]/reset", "content:site_file:manage"],
  ["POST", "/admin/ajax/site-files/preview", "content:site_file:manage"],
  // 审核（content:review:manage）
  ["GET", "/admin/ajax/review", "content:review:manage"],
  ["POST", "/admin/ajax/review", "content:review:manage"],
  ["GET", "/admin/ajax/review/[itemId]", "content:review:manage"],
  ["POST", "/admin/ajax/review/[itemId]", "content:review:manage"],
  ["GET", "/admin/ajax/review/corrections", "content:review:manage"],
  ["POST", "/admin/ajax/review/corrections", "content:review:manage"],
  ["POST", "/admin/ajax/review/corrections/[correctionId]", "content:review:manage"],
  // 站点设置（content:settings:manage：主题板 + Cloudflare token 轮换）
  ["GET", "/admin/ajax/themes", "content:settings:manage"],
  ["POST", "/admin/ajax/themes", "content:settings:manage"],
  ["GET", "/admin/ajax/themes/[themeId]", "content:settings:manage"],
  ["DELETE", "/admin/ajax/themes/[themeId]", "content:settings:manage"],
  ["GET", "/admin/ajax/themes/[themeId]/preview", "content:settings:manage"],
  ["POST", "/admin/ajax/themes/[themeId]/purge", "content:settings:manage"],
  ["GET", "/admin/ajax/themes/drafts/[draftId]", "content:settings:manage"],
  ["PUT", "/admin/ajax/themes/drafts/[draftId]", "content:settings:manage"],
  ["POST", "/admin/ajax/themes/drafts/[draftId]", "content:settings:manage"],
  ["DELETE", "/admin/ajax/themes/drafts/[draftId]", "content:settings:manage"],
  ["GET", "/admin/ajax/themes/drafts/[draftId]/preview", "content:settings:manage"],
  ["GET", "/admin/ajax/cloud-usage/token", "content:settings:manage"],
  ["POST", "/admin/ajax/cloud-usage/token", "content:settings:manage"],
  ["DELETE", "/admin/ajax/cloud-usage/token", "content:settings:manage"],
  // API 密钥（system:api:manage）
  ["POST", "/admin/ajax/api/keys", "system:api:manage"],
  ["PATCH", "/admin/ajax/api/keys/[apiKeyId]", "system:api:manage"],
  ["DELETE", "/admin/ajax/api/keys/[apiKeyId]", "system:api:manage"],
  ["POST", "/admin/ajax/api/keys/[apiKeyId]/rotate", "system:api:manage"],
  ["POST", "/admin/ajax/api/settings", "system:api:manage"],
  // 角色与权限树（system:role:manage）
  ["POST", "/admin/ajax/rbac/roles", "system:role:manage"],
  ["POST", "/admin/ajax/rbac/role-name", "system:role:manage"],
  ["POST", "/admin/ajax/rbac/role-code", "system:role:manage"],
  ["POST", "/admin/ajax/rbac/role-delete", "system:role:manage"],
  ["POST", "/admin/ajax/rbac/role-permissions", "system:role:manage"],
  ["GET", "/admin/ajax/rbac/permission-tree", "system:role:manage"],
  ["POST", "/admin/ajax/rbac/permission-tree/save", "system:role:manage"],
  ["GET", "/admin/ajax/rbac/permission-tree/export", "system:role:manage"],
  // 账户（system:user:manage）
  ["GET", "/admin/ajax/rbac/users", "system:user:manage"],
  ["POST", "/admin/ajax/rbac/user-create", "system:user:manage"],
  ["POST", "/admin/ajax/rbac/user-ban", "system:user:manage"],
  ["POST", "/admin/ajax/rbac/user-delete", "system:user:manage"],
  ["POST", "/admin/ajax/rbac/user-roles", "system:user:manage"],
  ["POST", "/admin/ajax/rbac/user-profile", "system:user:manage"],
  ["GET", "/admin/ajax/rbac/user-credentials", "system:user:manage"],
  ["POST", "/admin/ajax/rbac/user-credential-create", "system:user:manage"],
  ["POST", "/admin/ajax/rbac/user-credential-revoke", "system:user:manage"],
  ["POST", "/admin/ajax/rbac/user-password-reset", "system:user:manage"],
  ["GET", "/admin/ajax/rbac/user-devices", "system:user:manage"],
  ["POST", "/admin/ajax/rbac/user-device-revoke", "system:user:manage"],
  ["POST", "/admin/ajax/rbac/user-device-restore", "system:user:manage"],
  // 设备（system:device:*）
  ["GET", "/admin/ajax/devices", "system:device:read"],
  ["POST", "/admin/ajax/devices/revoke", "system:device:manage"],
  ["POST", "/admin/ajax/devices/restore", "system:device:manage"],
  // 版本管理板（system:app-version:*）
  ["GET", "/admin/ajax/app-versions", "system:app-version:read"],
  ["GET", "/admin/ajax/app-versions/apks", "system:app-version:read"],
  ["POST", "/admin/ajax/app-versions/save", "system:app-version:manage"],
  ["DELETE", "/admin/ajax/app-versions/apks", "system:app-version:manage"],
  // 运营公告板（system:announcement:*）
  ["GET", "/admin/ajax/announcements", "system:announcement:read"],
  ["POST", "/admin/ajax/announcements/save", "system:announcement:manage"],
  // 登录日志 / 用量（system:login-log:read / system:cloud-usage:read）
  ["GET", "/admin/ajax/login-logs", "system:login-log:read"],
  ["GET", "/admin/ajax/cloud-usage", "system:cloud-usage:read"],
  // Webhook（system:webhook:manage）
  ["GET", "/admin/ajax/webhooks/overview", "system:webhook:manage"],
  ["GET", "/admin/ajax/webhooks/endpoints", "system:webhook:manage"],
  ["POST", "/admin/ajax/webhooks/endpoints", "system:webhook:manage"],
  ["GET", "/admin/ajax/webhooks/endpoints/[endpointId]", "system:webhook:manage"],
  ["PUT", "/admin/ajax/webhooks/endpoints/[endpointId]", "system:webhook:manage"],
  ["DELETE", "/admin/ajax/webhooks/endpoints/[endpointId]", "system:webhook:manage"],
  ["POST", "/admin/ajax/webhooks/endpoints/[endpointId]/purge", "system:webhook:manage"],
  ["POST", "/admin/ajax/webhooks/endpoints/[endpointId]/resume", "system:webhook:manage"],
  ["POST", "/admin/ajax/webhooks/endpoints/[endpointId]/rotate", "system:webhook:manage"],
  ["POST", "/admin/ajax/webhooks/endpoints/[endpointId]/test", "system:webhook:manage"],
  ["GET", "/admin/ajax/webhooks/endpoints/[endpointId]/secret", "system:webhook:manage"],
  ["GET", "/admin/ajax/webhooks/deliveries", "system:webhook:manage"],
  ["GET", "/admin/ajax/webhooks/deliveries/[deliveryId]", "system:webhook:manage"],
  ["POST", "/admin/ajax/webhooks/deliveries/[deliveryId]/redeliver", "system:webhook:manage"],
  ["POST", "/admin/ajax/webhooks/explorer/send", "system:webhook:manage"],
  ["POST", "/admin/ajax/webhooks/explorer/preview", "system:webhook:manage"],
  ["POST", "/admin/ajax/webhooks/explorer/print", "system:webhook:manage"],
  ["GET", "/admin/ajax/webhooks/explorer/subjects", "system:webhook:manage"],
  ["PATCH", "/admin/ajax/webhooks/settings", "system:webhook:manage"],
  // 菜单管理（system:menu:manage）
  ["GET", "/admin/ajax/menu", "system:menu:manage"],
  ["POST", "/admin/ajax/menu/save", "system:menu:manage"],
  ["GET", "/admin/ajax/menu/export", "system:menu:manage"],
];

/** 展示行：后台会话端点（`session`），门码一枚或多枚。 */
const ROWS: InterfaceCatalogRow[] = C.map(([method, path, ...codes]) => ({
  auth: "session",
  method,
  path,
  permissionCodes: codes,
}));

/** 目录里的路径一律写成默认后台基址，展示时再换成本站点实际配置的基址。 */
const CANONICAL_ADMIN_PREFIX = `/${DEFAULT_ADMIN_PATH}/`;

/**
 * 全部 PC 端管理接口（顺序即展示顺序：按上面目录的分组顺序）。
 *
 * `adminPath` 传站点实际配置的后台基址（`env.MICROFEED_ADMIN_PATH`）：后台路径
 * 配成 `/cms/` 时，树上的叶子跟着显示 `/cms/ajax/books`，不会把默认的
 * `/admin/` 当成事实。
 */
export function listPcInterfaces(adminPath?: string | null): InterfaceCatalogRow[] {
  const base = adminBasePath(adminPath);
  if (base === CANONICAL_ADMIN_PREFIX) return ROWS;
  return ROWS.map((row) => ({
    ...row,
    path: row.path.startsWith(CANONICAL_ADMIN_PREFIX)
      ? base + row.path.slice(CANONICAL_ADMIN_PREFIX.length)
      : row.path,
  }));
}
