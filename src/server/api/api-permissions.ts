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
 * The upstream-owned `pages` / `site-files` / `media_files` domains are
 * deliberately **not** listed: they keep the upstream OAuth-scope model, and a
 * path with no rule here requires no RBAC code.
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
  create: "content:article:create",
  update: "content:article:update",
  delete: "content:article:delete",
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
    read: "content:article:read",
    write: "content:article:read",
  },
  // The article (chapter) domain: `/items/` creates, `/items/{id}/` reads,
  // updates and deletes, `/items/validate/` validates a would-be create.
  {
    prefix: "items",
    read: "content:article:read",
    write: "content:article:update",
    ...ARTICLE_WRITE_CODES,
  },
  // Read-only endpoints. They export no write handler, so a write method is a
  // 405 further down; requiring the read code keeps the rule total without
  // inventing a write code nobody can hold.
  {prefix: "feed", read: "content:article:read", write: "content:article:read"},
  {
    prefix: "search",
    read: "content:article:read",
    write: "content:article:read",
  },
  // The primary channel is managed as a whole, so one code covers every method.
  {
    prefix: "channels",
    read: "content:channel:manage",
    write: "content:channel:manage",
  },
  // Novel content read API (ADR-0006). Three distinct prefixes, none a prefix of
  // another, so the first-match lookup has no ordering trap.
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
    read: "content:article:read",
    write: "content:article:read",
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
 * The RBAC code an integration request must hold, or `null` when the path needs
 * no RBAC code here — a non-integration path, or an upstream-owned domain that
 * keeps the OAuth-scope model. Callers treat `null` as "no code required".
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
