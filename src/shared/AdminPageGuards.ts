/**
 * 后台页面 → 守卫码 静态目录（2026-11，用户「链路收敛」方向 1）。
 *
 * 与 `src/server/admin/pc-interfaces.ts` 同构：这里是**只读**目录，运行时权威
 * 仍在各 `.astro` 页面自己的 `requirePagePermission(Astro.locals, …, …)` 调用。
 * 测试 `tests/unit/admin-page-guards.test.ts` 的「admin page guard catalog」
 * 分组逐行核对目录与实际页面文件一致——改某页守卫码而忘同步目录时测试直接红，
 * 这正是「链路太长、容易漏改」的兜底：看目录就能知道每页要什么码，不必翻 46 个
 * 页面文件。
 *
 * 键 = 相对 `[adminPath]` 的路由路径（无前导斜杠，与权限树页面节点 `path`、
 * 菜单行 `path` 的形状一致）；详情页（如 `items/[itemId]`）复用其列表页的门码。
 * 首页、`login`、`account`、`forbidden`、`api/oauth` 等 7 个页面不设门码，故不在
 * 本目录（它们要么公开，要么只校验登录态）。
 * 页面守卫码与菜单/权限树 `entry_code` 的「同一把锁」一致性由
 * `tests/unit/admin-page-guards.test.ts` 既有分组另行保证。
 */

import {PERMISSION_CODES, type PermissionCode} from "./Constants";

/** 相对 `[adminPath]` 的路由路径 → 该页守卫用的权限码。 */
export const ADMIN_PAGE_GUARDS: Readonly<Record<string, PermissionCode>> = {
  aliases: PERMISSION_CODES.CONTENT_ALIAS_READ,
  announcements: PERMISSION_CODES.SYSTEM_ANNOUNCEMENT_READ,
  "annotation-markers": PERMISSION_CODES.CONTENT_ANNOTATION_MARKERS_MANAGE,
  api: PERMISSION_CODES.SYSTEM_API_MANAGE,
  "api/auth": PERMISSION_CODES.SYSTEM_API_MANAGE,
  "api/explorer": PERMISSION_CODES.SYSTEM_API_MANAGE,
  "api/settings": PERMISSION_CODES.SYSTEM_API_MANAGE,
  "app-about": PERMISSION_CODES.SYSTEM_APP_ABOUT_READ,
  "app-versions": PERMISSION_CODES.SYSTEM_APP_VERSION_READ,
  audit: PERMISSION_CODES.CONTENT_AUDIT_READ,
  "audit/[itemId]": PERMISSION_CODES.CONTENT_AUDIT_READ,
  "book-statuses": PERMISSION_CODES.CONTENT_BOOK_STATUS_MANAGE,
  books: PERMISSION_CODES.CONTENT_BOOK_READ,
  cache: PERMISSION_CODES.SYSTEM_CACHE_MANAGE,
  categories: PERMISSION_CODES.CONTENT_CATEGORY_READ,
  "channels/primary": PERMISSION_CODES.CONTENT_CHANNEL_MANAGE,
  "cloud-usage": PERMISSION_CODES.SYSTEM_CLOUD_USAGE_READ,
  devices: PERMISSION_CODES.SYSTEM_DEVICE_READ,
  fangs: PERMISSION_CODES.CONTENT_FANG_READ,
  "items/[itemId]": PERMISSION_CODES.CONTENT_CHAPTER_READ,
  "items/list": PERMISSION_CODES.CONTENT_CHAPTER_READ,
  "items/new": PERMISSION_CODES.CONTENT_CHAPTER_READ,
  "login-logs": PERMISSION_CODES.SYSTEM_LOGIN_LOG_READ,
  "login-methods": PERMISSION_CODES.SYSTEM_APP_LOGIN_METHODS_READ,
  pages: PERMISSION_CODES.CONTENT_PAGE_MANAGE,
  "pages/[pageId]": PERMISSION_CODES.CONTENT_PAGE_MANAGE,
  "pages/new": PERMISSION_CODES.CONTENT_PAGE_MANAGE,
  rbac: PERMISSION_CODES.SYSTEM_ROLE_MANAGE,
  "rbac/audit": PERMISSION_CODES.SYSTEM_ROLE_MANAGE,
  review: PERMISSION_CODES.CONTENT_REVIEW_MANAGE,
  "review/[itemId]": PERMISSION_CODES.CONTENT_REVIEW_MANAGE,
  settings: PERMISSION_CODES.CONTENT_SETTINGS_MANAGE,
  "settings/code-editor": PERMISSION_CODES.CONTENT_SETTINGS_MANAGE,
  "settings/themes": PERMISSION_CODES.CONTENT_SETTINGS_MANAGE,
  "settings/themes/drafts/[draftId]": PERMISSION_CODES.CONTENT_SETTINGS_MANAGE,
  "site-files": PERMISSION_CODES.CONTENT_SITE_FILE_MANAGE,
  "site-files/[siteFileId]": PERMISSION_CODES.CONTENT_SITE_FILE_MANAGE,
  "site-files/new": PERMISSION_CODES.CONTENT_SITE_FILE_MANAGE,
  term: PERMISSION_CODES.CONTENT_TERM_READ,
  users: PERMISSION_CODES.SYSTEM_USER_MANAGE,
  volumes: PERMISSION_CODES.CONTENT_VOLUME_READ,
  webhooks: PERMISSION_CODES.SYSTEM_WEBHOOK_MANAGE,
  "webhooks/deliveries": PERMISSION_CODES.SYSTEM_WEBHOOK_MANAGE,
  "webhooks/endpoints": PERMISSION_CODES.SYSTEM_WEBHOOK_MANAGE,
  "webhooks/events": PERMISSION_CODES.SYSTEM_WEBHOOK_MANAGE,
  yao: PERMISSION_CODES.CONTENT_YAO_READ,
};
