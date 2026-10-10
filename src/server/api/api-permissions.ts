/**
 * Maps an API integration request to the RBAC permission code it requires.
 *
 * The login-credential bearer path authenticates a *user*; this module decides
 * *what* that user must be allowed to do. Codes live in `ext_permissions` and
 * are seeded from `src/server/rbac/seed.ts`. A `*` wildcard (super_admin)
 * bypasses the check in the caller.
 *
 * Authorization reuses the **dashboard's own RBAC codes** (`content:*:*`) rather
 * than a parallel `api:*` family, so a role's permissions mean the same thing on
 * the API as they do in the admin UI (ADR-0009).
 *
 * The upstream-owned `pages` / `site-files` / `media_files` domains are listed
 * below (A1): previously unmapped, they let any login credential call them with
 * no RBAC code. Every integration path now maps to a `content:*:*` (or
 * `media:*:*`) code, and an integration path with no matching rule is denied
 * (fail-closed) rather than silently allowed.
 */

import {API_BASE_PATH} from "@/shared/ApiVersion";
import {apiPathDetails} from "./access";

/**
 * The codes a domain requires, split by HTTP method so that "create", "update"
 * and "delete" stay separately grantable — a role may hold some and not others.
 * A method with no specific entry falls back to `write`.
 */
interface DomainRule {
  prefix: string;
  read: string;
  write: string;
  create?: string;
  update?: string;
  delete?: string;
}

const ARTICLE_WRITE_CODES = {
  create: "content:chapter:create",
  update: "content:chapter:update",
  delete: "content:chapter:delete",
} as const;

const DOMAIN_RULES: DomainRule[] = [
  // Novel content read API (ADR-0006). Read-only, so `read` and `write` carry the
  // same code; a write method against these paths is a 405 further down.
  {
    prefix: "content/categories",
    read: "content:category:read",
    write: "content:category:read",
  },
  {
    prefix: "content/books",
    read: "content:book:read",
    write: "content:book:read",
  },
  {
    prefix: "content/chapters",
    read: "content:chapter:read",
    write: "content:chapter:read",
  },
  // The article (chapter) domain: `/items/` creates, `/items/{id}/` reads,
  // updates and deletes, `/items/validate/` validates a would-be create.
  {
    prefix: "items",
    read: "content:chapter:read",
    write: "content:chapter:update",
    ...ARTICLE_WRITE_CODES,
  },
  // Read-only endpoints. They export no write handler, so a write method is a
  // 405 further down; requiring the read code keeps the rule total without
  // inventing a write code nobody can hold.
  {prefix: "feed", read: "content:chapter:read", write: "content:chapter:read"},
  {
    prefix: "search",
    read: "content:chapter:read",
    write: "content:chapter:read",
  },
  // The primary channel is managed as a whole, so one code covers every method.
  {
    prefix: "channels",
    read: "content:channel:manage",
    write: "content:channel:manage",
  },
  // Upstream-owned domains (A1): previously unmapped, so any login credential
  // could call them with no RBAC code. Each is managed as a whole, so one code
  // covers every method. `media_files` uses the new `media:file:manage` code
  // (migration 0058); `pages` / `site-files` reuse the dashboard's existing
  // manage codes so the operator audience matches the admin UI.
  {prefix: "pages", read: "content:page:manage", write: "content:page:manage"},
  {
    prefix: "site-files",
    read: "content:site_file:manage",
    write: "content:site_file:manage",
  },
  {prefix: "media_files", read: "media:file:manage", write: "media:file:manage"},
  // The mobile app namespace (`/api/AppBookRequest/…`, spec §6). Only the
  // content endpoints are registered as integration paths (see `access.ts`), so
  // they all require the single `app:mobile:access` gate. Read-only, so `read`
  // and `write` carry the same code; a write method against these paths is a
  // 405 further down.
  {
    prefix: "AppBookRequest/",
    read: "app:mobile:access",
    write: "app:mobile:access",
  },
  // App 搜索权限端点（`GET /api/app/search-permission`，DESIGN §5.2）。与
  // AppBookRequest 同属移动端集成面，只要求单一 `app:mobile:access` 门；该端点
  // 自身再按用户角色判定 `app:search:global` / `app:search:book`（见端点处理器）。
  {
    prefix: "app/search-permission",
    read: "app:mobile:access",
    write: "app:mobile:access",
  },
  // App 名词解释查看权限端点（`GET /api/app/mingci-permission`，G3 单开关）。与
  // search-permission 同构：只要求单一 `app:mobile:access` 门；该端点自身再按用户角色
  // 判定 `app:mingci:view`（见端点处理器）。
  {
    prefix: "app/mingci-permission",
    read: "app:mobile:access",
    write: "app:mobile:access",
  },
];

function requiredCode(rule: DomainRule, method: string): string {
  switch (method.toUpperCase()) {
    case "GET":
    case "HEAD":
      return rule.read;
    case "POST":
      return rule.create ?? rule.write;
    case "PUT":
    case "PATCH":
      return rule.update ?? rule.write;
    case "DELETE":
      return rule.delete ?? rule.write;
    default:
      return rule.write;
  }
}

/**
 * The RBAC code an integration request must hold, or `null` when the path is
 * outside the mapped set (a non-integration path, which the caller has already
 * turned into notFound/reference before reaching here). An integration path that
 * matches no rule returns `null` too — callers treat that as **denied**
 * (fail-closed, A1), so a forgotten mapping cannot silently open a domain.
 */
export function requiredApiPermission(
  pathname: string,
  method: string,
): string | null {
  const details = apiPathDetails(pathname);
  if (!details || details.kind !== "integration") return null;
  // Derive the suffix from the canonical path so the legacy base (`/api/`) maps
  // the same way the versioned one (`/api/v1/`) does — reading it off `pathname`
  // would leave a legacy path's leading `/api/` in place and match no rule.
  const suffix = details.canonicalPath.slice(API_BASE_PATH.length);
  for (const rule of DOMAIN_RULES) {
    if (suffix.startsWith(rule.prefix)) return requiredCode(rule, method);
  }
  return null;
}
