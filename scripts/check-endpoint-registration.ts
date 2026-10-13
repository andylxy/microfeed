/**
 * 校验每个 API 端点 handler 都登记在它应当在的位置。
 *
 * `src/pages/api/` 下的 handler 必须恰好归入以下三类之一
 * （截至 2026-10-13 的计数：56 个 handler = 25 个 OpenAPI + 17 个豁免 + 14 个 AppBookRequest）：
 *
 *   1. OpenAPI——其路由映射到 `src/shared/OpenApiDocument.ts` 中的某个 path。
 *      规范里的 path 相对 `API_BASE_PATH`（`/api/v1/`），因此带版本与不带版本的
 *      旧别名（`/api/...`）映射到同一个 path。
 *   2. AppBookRequest——`/api/AppBookRequest/*`，对照 `src/server/api/access.ts`
 *      中的两套 App 登记表，与 OpenAPI 规范分开维护。
 *   3. 四个豁免类之一（见 AGENTS.md「架构治理 → 新增端点登记」）：
 *      - `/api/app/{version,announcements,search-permission,mingci-permission}`
 *      - `/api/auth/*`                                 —— 由 better-auth 自管
 *      - 规范与文档元端点（`openapi.*`、`llms*.txt`）
 *      - `/api/` 与 `/api/v1/`                         —— API 根路由 landing page
 *
 * 不在任何一类中的 handler 是静默缺口：它可通过 HTTP 访问，却不在公开规范、
 * 也不在任何豁免清单里，审查 API 表面的人无从知晓它的存在。
 *
 * 共强制六条规则，每条对应下方一次 `report(...)` 调用：
 *   - ENDPOINT-001  handler 不匹配以上任何一类。
 *   - ENDPOINT-002  规范中的某个 path 在磁盘上没有对应 handler。
 *   - ENDPOINT-003  某种 catch-all 路由形态映射不到单一路由。
 *   - ENDPOINT-004  AppBookRequest handler 未登记进登记表，其大小写无法被
 *                   归一化（任意大小写请求都会 404）。
 *   - ENDPOINT-005  AppBookRequest handler 既不是内容路由（需鉴权）也不是
 *                   显式匿名路由——中间件会把它当匿名服务（fail-open）。
 *   - ENDPOINT-006  登记表中的某项在磁盘上没有对应 handler 文件。
 *
 * handler 文件后缀为 `.ts`、`.js` 或 `.astro`：API 参考界面以两个 `.astro`
 * 路由形式存在于 `src/pages/api/v1/`。扫描若漏掉其中任一后缀，就会静默跳过
 * 一条可达路由——这正是本门禁要堵住的缺口。
 *
 * 用 `yarn endpoints:check` 运行。任意规则被违反时以非零状态退出。
 */
import {existsSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {report, walk, finish} from "./gate-utils";
import {
  APP_BOOK_REQUEST_ROUTES,
  APP_BOOK_REQUEST_CONTENT_SUFFIXES,
  APP_BOOK_REQUEST_ANONYMOUS_ROUTES,
} from "../src/server/api/access";
import {API_BASE_PATH, LEGACY_API_BASE_PATH} from "../src/shared/ApiVersion";
import {OPENAPI_DOCUMENT} from "../src/shared/OpenApiDocument";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const apiRoot = path.join(repositoryRoot, "src", "pages", "api");

/** `/api/v1` and `/api`, longest first so the versioned prefix wins. */
const BASE_PREFIXES = [API_BASE_PATH.replace(/\/$/u, ""), LEGACY_API_BASE_PATH.replace(/\/$/u, "")];

/** Exemption class 2: the four App-internal channels outside AppBookRequest. */
const APP_CHANNEL_PATHS = new Set([
  "/api/app/version",
  "/api/app/announcements",
  "/api/app/search-permission",
  "/api/app/mingci-permission",
]);

/**
 * 豁免类 4：规范与生成的文档元端点。两个 base 都列入，因为参考界面既以旧
 * base（`/api/openapi.html`）发布，也以带版本 base（`/api/v1/openapi.html`，
 * 一条 `.astro` 路由）发布；而带版本 base 本身（`/api/v1/`，`index.astro`）
 * 是该界面的 landing page——扮演的角色与下方的 `/api/` 相同。
 */
const META_DOC_PATHS = new Set([
  "/api/openapi.html",
  "/api/openapi.json",
  "/api/openapi.yaml",
  "/api/llms.txt",
  "/api/llms-full.txt",
  `${API_BASE_PATH}openapi.html`,
  `${API_BASE_PATH}openapi.json`,
  `${API_BASE_PATH}openapi.yaml`,
  `${API_BASE_PATH}llms.txt`,
  `${API_BASE_PATH}llms-full.txt`,
  API_BASE_PATH,
]);

/**
 * `src/pages/api/` 下的 handler 文件可携带的后缀。Astro 路由是 `.astro` 文件——
 * API 参考界面就位于其中两条——而端点本身是 `.ts`，普通脚本路由可能是 `.js`。
 * 扫描若漏掉三种后缀中的任一，就会静默跳过一条可达路由，这正是本门禁要堵住的缺口。
 */
function isHandlerFile(name: string): boolean {
  if (name.endsWith(".test.ts") || name.endsWith(".test.js")) return false;
  return /\.(ts|js|astro)$/u.test(name);
}

function stripExtension(name: string): string {
  return name.replace(/\.(ts|js|astro)$/u, "");
}

/**
 * 将 handler 文件路径转换为其公开路由，例如：
 *   src/pages/api/v1/items/[itemId]/index.ts -> /api/v1/items/{itemId}/
 *   src/pages/api/openapi.json.ts            -> /api/openapi.json
 *   src/pages/api/index.ts                   -> /api/
 *   src/pages/api/v1/openapi.html.astro      -> /api/v1/openapi.html
 * 目录路由（文件为 `index.*`）保留 Astro 的结尾斜杠；具名文件路由
 * （`openapi.json.ts`）则不保留。
 * 对 catch-all 路由（`[...all]`，没有单一路由）返回 null。
 */
function routeFor(absolutePath: string): string | null {
  const relative = path.relative(apiRoot, absolutePath).replace(/\\/gu, "/");
  const withoutExtension = stripExtension(relative);
  if (withoutExtension.includes("[...")) return null;
  const segments = withoutExtension.split("/");
  const isDirectoryRoute = segments[segments.length - 1] === "index";
  const mapped = segments
    .slice(0, isDirectoryRoute ? -1 : segments.length)
    .map((segment) => segment.replace(/^\[(.+)\]$/u, "{$1}"));
  const joined = mapped.join("/");
  if (!isDirectoryRoute) return `/api/${joined}`;
  return joined ? `/api/${joined}/` : "/api/";
}

const openApiPaths = new Set(Object.keys(OPENAPI_DOCUMENT.paths ?? {}));

const handlerFiles = walk(apiRoot, isHandlerFile);
const appBookRequestRoot = path.join(apiRoot, "AppBookRequest");
const appBookRequestFiles = walk(appBookRequestRoot, isHandlerFile);
const publicHandlerFiles = handlerFiles.filter((file) => !file.startsWith(appBookRequestRoot));

const matchedOpenApiPaths = new Set<string>();
let openApiHandlerCount = 0;
let exemptHandlerCount = 0;

for (const file of publicHandlerFiles) {
  const relative = path.relative(repositoryRoot, file).replace(/\\/gu, "/");
  const route = routeFor(file);

  // 整棵 `/api/auth/*` 树（无论 catch-all 还是具名）都由 better-auth 自管。
  // 按文件路径判定，因此将来新增的 `auth/foo.ts` 也会被豁免——
  // 仅按路由判定会在此处误报。
  if (relative.startsWith("src/pages/api/auth/")) {
    exemptHandlerCount++;
    continue;
  }

  if (route === null) {
    report(relative, "ENDPOINT-003", "unrecognised catch-all route shape");
    continue;
  }

  const base = BASE_PREFIXES.find((prefix) => route === prefix || route.startsWith(`${prefix}/`));
  const contractPath = base ? route.slice(base.length) || "/" : null;

  if (contractPath !== null && openApiPaths.has(contractPath)) {
    matchedOpenApiPaths.add(contractPath);
    openApiHandlerCount++;
    continue;
  }
  if (APP_CHANNEL_PATHS.has(route)) {
    exemptHandlerCount++;
    continue;
  }
  if (META_DOC_PATHS.has(route)) {
    exemptHandlerCount++;
    continue;
  }
  if (route === "/api/") {
    exemptHandlerCount++;
    continue;
  }
  report(
    relative,
    "ENDPOINT-001",
    `handler is neither in the OpenAPI contract (no path "${contractPath ?? route}") nor in a documented exemption class`,
  );
}

// Reverse check: an OpenAPI path with no handler is a stale contract entry.
for (const contractPath of [...openApiPaths].sort()) {
  if (!matchedOpenApiPaths.has(contractPath)) {
    report(
      "src/shared/OpenApiDocument.ts",
      "ENDPOINT-002",
      `contract path "${contractPath}" has no handler under src/pages/api/`,
    );
  }
}

// The App namespace: the registry is the canonicalisation authority, so the
// check runs both ways and also asserts the auth split.
const routesLower = new Set(APP_BOOK_REQUEST_ROUTES.map((route) => route.toLowerCase()));
const contentLower = new Set(
  [...APP_BOOK_REQUEST_CONTENT_SUFFIXES]
    .map((suffix) => suffix.replace(/^AppBookRequest\//u, "").replace(/\/$/u, ""))
    .map((name) => name.toLowerCase()),
);
// Single source of truth for the anonymous routes lives in `access.ts` next to
// the other two registries; `tests/unit/api-permissions.test.ts` reads the same
// list, so there is no second hand-maintained copy.
const anonymousLower = new Set(
  APP_BOOK_REQUEST_ANONYMOUS_ROUTES.map((route) => route.toLowerCase()),
);

for (const file of appBookRequestFiles) {
  const relative = path.relative(repositoryRoot, file).replace(/\\/gu, "/");
  const routeName = stripExtension(path.basename(file));
  const routeLower = routeName.toLowerCase();
  if (!routesLower.has(routeLower)) {
    report(
      relative,
      "ENDPOINT-004",
      "handler is not in APP_BOOK_REQUEST_ROUTES; the middleware would not canonicalise its casing",
    );
    continue;
  }
  if (!contentLower.has(routeLower) && !anonymousLower.has(routeLower)) {
    report(
      relative,
      "ENDPOINT-005",
      "handler is registered but is neither a content route (APP_BOOK_REQUEST_CONTENT_SUFFIXES) nor an anonymous route (APP_BOOK_REQUEST_ANONYMOUS_ROUTES)",
    );
  }
}
const HANDLER_EXTENSIONS = [".ts", ".js", ".astro"];
for (const route of APP_BOOK_REQUEST_ROUTES) {
  // 三种 handler 后缀中的任一都算满足该路由；若只要求 `.ts`，遇到以
  // `.js` 或 `.astro` 发布的 handler 会误报。
  const present = HANDLER_EXTENSIONS.some((extension) =>
    existsSync(path.join(appBookRequestRoot, `${route}${extension}`)),
  );
  if (!present) {
    report(
      "src/server/api/access.ts",
      "ENDPOINT-006",
      `APP_BOOK_REQUEST_ROUTES lists "${route}" but no src/pages/api/AppBookRequest/${route}.{ts,js,astro} exists`,
    );
  }
}

finish("endpoint registration");

console.log(
  `OK: ${handlerFiles.length} handlers — ` +
  `${publicHandlerFiles.length} public (${openApiHandlerCount} map to ${matchedOpenApiPaths.size} OpenAPI paths, ` +
  `all ${openApiPaths.size} contract paths covered; ${exemptHandlerCount} in exemption classes), ` +
  `${appBookRequestFiles.length} AppBookRequest (all registered).`,
);
