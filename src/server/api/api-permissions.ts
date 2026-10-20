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
  /** GET/HEAD 的任一双码门：持其中任意一个码即放行（migration 0131）。 */
  readAnyOf?: readonly string[];
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
  // 移动端命名空间（`/api/AppBookRequest/…`，spec §6）。migration 0131 起
  // 按内容域逐端点分发门码（原单一 `app:mobile:access` 兜底一门管 8 条，粒度
  // 过粗）：一个码对应一个用途，逐条列举、不再留兜底——新内容端点忘记登记时
  // 在这里进入 fail-closed（deny），与 A1 的口径一致。这些端点只读，所以
  // `read` / `write` 挂同一个码；对它们发写方法在下面按 405 拒掉。
  {prefix: "AppBookRequest/GetNav/", read: "app:nav:read", write: "app:nav:read"},
  {prefix: "AppBookRequest/GetTipsStyleConfig/", read: "app:style:read", write: "app:style:read"},
  {prefix: "AppBookRequest/GetBookChapter/", read: "app:chapter:read", write: "app:chapter:read"},
  {prefix: "AppBookRequest/GetChapterContent/", read: "app:content:read", write: "app:content:read"},
  {prefix: "AppBookRequest/GetBookIdFang/", read: "app:fang:read", write: "app:fang:read"},
  {prefix: "AppBookRequest/GetAllZhongYao/", read: "app:zhongyao:read", write: "app:zhongyao:read"},
  {prefix: "AppBookRequest/GetAliaZhongYao/", read: "app:zhongyao:read", write: "app:zhongyao:read"},
  // 名词数据端点归到名词能力码（原在 `app:mobile:access` 兜底门下，0131 起与
  // mingci-permission 端点共用 `app:mingci:view`：数据与它的查看权同权）。
  {prefix: "AppBookRequest/GetAllMingCi/", read: "app:mingci:view", write: "app:mingci:view"},
  // App 搜索权限端点（`GET /api/app/search-permission`，DESIGN §5.2）。外门是
  // 两个搜索能力码的任一双码门：持 global 或 book 任意一个都允许来问，端点自身
  // 再按用户角色判定两个码各给什么答案（见端点处理器）。
  {
    prefix: "app/search-permission",
    read: "app:search:global",
    write: "app:search:global",
    readAnyOf: ["app:search:global", "app:search:book"],
  },
  // App 名词解释查看权限端点（`GET /api/app/mingci-permission`，G3 单开关）。
  // 外门与端点内部复核同用 `app:mingci:view`：端点回答的就是这一个码的持有情况。
  {
    prefix: "app/mingci-permission",
    read: "app:mingci:view",
    write: "app:mingci:view",
  },
  // App 版本升级描述符端点（`GET /api/app/version`，spec §6.5）。门即权限码
  // `app:version:read` 本身 —— 该码默认授予 editor 角色（migrations/0119 播种码、
  // 0120 授予，属「运营管理」叶子结点下的默认授权）。端点的 `version.ts` 再用同一码
  // 复核一次（防御纵深）。read-only，故 read/write 同码。
  {
    prefix: "app/version",
    read: "app:version:read",
    write: "app:version:read",
  },
  // App 运营公告端点（`GET /api/app/announcements`，DESIGN §5.3）。与 version 同构：
  // 门即权限码 `app:announcement:read`，默认授予 editor 角色（migrations/0119 / 0120）。
  {
    prefix: "app/announcements",
    read: "app:announcement:read",
    write: "app:announcement:read",
  },
];

function requiredCode(rule: DomainRule, method: string): string | readonly string[] {
  switch (method.toUpperCase()) {
    case "GET":
    case "HEAD":
      return rule.readAnyOf ?? rule.read;
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

/** 单码门返回一个码，任一双码门返回码数组；`null` = 未登记（fail-closed）。 */
export type RequiredApiPermission = string | readonly string[];

/**
 * 集成请求必须持有的 RBAC 码；路径不在映射表里时返回 `null`（非集成路径，
 * 调用方在此之前已把它转成 notFound/reference）。集成路径但没有命中任何规则
 * 同样返回 `null`，调用方按**拒绝**处理（fail-closed，A1），所以漏登记的
 * 端点不会悄悄把某个域开放出去。数组形态是任一双码门：持其中任意一个码即放行。
 */
export function requiredApiPermission(
  pathname: string,
  method: string,
): RequiredApiPermission | null {
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
