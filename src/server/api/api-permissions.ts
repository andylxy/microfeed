/**
 * Maps an API integration request to the RBAC permission code it requires.
 *
 * The signed-call path authenticates a *user* (via the key); this module decides
 * *what* that user must be allowed to do. Codes live in `ext_permissions` and are
 * seeded in migrations/0035. A `*` wildcard (super_admin) bypasses the check in
 * the caller. Reads map to `:read`, writes to `:write`, by resource domain.
 */

import {API_BASE_PATH} from "@/shared/ApiVersion";
import {apiPathDetails} from "./access";

interface DomainRule {
  prefix: string;
  read: string;
  write: string;
}

const DOMAIN_RULES: DomainRule[] = [
  {prefix: "media_files", read: "api:media:read", write: "api:media:write"},
  {prefix: "pages", read: "api:page:read", write: "api:page:write"},
  {prefix: "site-files", read: "api:site:read", write: "api:site:write"},
  // content domain: items, channels, feed, search
  {prefix: "items", read: "api:content:read", write: "api:content:write"},
  {prefix: "channels", read: "api:content:read", write: "api:content:write"},
  {prefix: "feed", read: "api:content:read", write: "api:content:write"},
  {prefix: "search", read: "api:content:read", write: "api:content:write"},
];

export function requiredApiPermission(
  pathname: string,
  method: string,
): string | null {
  const details = apiPathDetails(pathname);
  if (!details || details.kind !== "integration") return null;
  const isRead = ["GET", "HEAD"].includes(method.toUpperCase());
  const suffix = pathname.startsWith(API_BASE_PATH)
    ? pathname.slice(API_BASE_PATH.length)
    : pathname;
  for (const rule of DOMAIN_RULES) {
    if (suffix.startsWith(rule.prefix)) {
      return isRead ? rule.read : rule.write;
    }
  }
  return isRead ? "api:content:read" : "api:content:write";
}
