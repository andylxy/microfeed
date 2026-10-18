/**
 * Verifies the top-level layout of `src/server/`.
 *
 * `src/server/` held 23 top-level items (18 directories + 5 files) before the
 * 2026-10-12 reorganisation. Four of those directories were named after a
 * single feature (`app-version/`, `app-announcement/`, `app-mingci-permission/`,
 * `app-search-permission/`), which mixed feature-specific siblings in with the
 * shared `cache/`, `auth/`, `api/` layers. The reorganisation moved the four
 * `app-*` features under `src/server/app/{announcement,permission,version}/`
 * and moved `tcm/app-cache.ts` into `cache/app-cache.ts`, leaving 20 items
 * (15 directories + 5 files).
 *
 * Rule enforced:
 *   Any new top-level entry under `src/server/` must be added to the whitelist
 *   in this script. The whitelist is the human-owned record of what belongs at
 *   the top level; a silent addition means a new feature landed outside the
 *   agreed structure.
 *
 * Run with `yarn layout:check`. It exits non-zero when any rule is violated.
 */
import {readdirSync, statSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {report, finish} from "./gate-utils";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const serverRoot = path.join(repositoryRoot, "src", "server");

const WHITELIST = new Set([
  // Domain directories.
  "admin",
  "api",
  "app",
  "auth",
  "cache",
  // Cloudflare 使用情况看板（D1 / R2 / Workers 只读转发）的限额常量、R2 操作分级、
  // Token 密文存取与官方接口客户端。2026-10-18 新增，与 `webhooks` 先例同为特性目录。
  "cloud-usage",
  "feed",
  "items",
  "media",
  "openapi",
  "pages",
  "rbac",
  "site-files",
  "tcm",
  "themes",
  "webhooks",
  // Top-level files.
  "admin-routes.ts",
  "http.ts",
  "installation-identity.ts",
  "maintenance.ts",
  "mutation.ts",
]);

const entries = readdirSync(serverRoot);

for (const entry of entries) {
  if (WHITELIST.has(entry)) continue;
  const absolute = path.join(serverRoot, entry);
  const kind = statSync(absolute).isDirectory() ? "directory" : "file";
  report(
    `src/server/${entry}`,
    "LAYOUT-001",
    `top-level ${kind} is not in the whitelist; add it to scripts/check-server-layout.ts`,
  );
}

finish("layout");

console.log(`OK: ${entries.length} top-level entries under src/server/, all whitelisted.`);
