/**
 * Verifies that every API endpoint handler is registered somewhere it should be.
 *
 * A handler under `src/pages/api/` must land in exactly one of four buckets
 * (counts as of 2026-10-12: 25 / 14 / 15 / 14 = 54 handlers):
 *
 *   1. OpenAPI — its route maps to a path in `src/shared/OpenApiDocument.ts`.
 *      The contract's paths are relative to `API_BASE_PATH` (`/api/v1/`), so
 *      both the versioned handler and its unversioned legacy alias
 *      (`/api/...`) map to the same path.
 *   2. AppBookRequest — `/api/AppBookRequest/*`, checked against the two App
 *      registries in `src/server/api/access.ts` instead of the contract.
 *   3. One of four exemption classes (AGENTS.md「架构治理 → 新增端点登记」):
 *      - `/api/app/{version,announcements,search-permission,mingci-permission}`
 *      - `/api/auth/*`                                 — better-auth managed
 *      - the contract / doc meta endpoints (`openapi.*`, `llms*.txt`)
 *      - `/api/`                                      — API root landing
 *
 * A handler in none of them is a silent gap: it is reachable over HTTP but
 * absent from the public contract and from every exemption list, so nobody
 * reviewing the API surface would know it exists.
 *
 * The gate also runs two reverse checks, because a one-way check lets the
 * registries rot:
 *   - every OpenAPI path has at least one handler on disk;
 *   - every `APP_BOOK_REQUEST_ROUTES` entry has a handler file, and every
 *     handler file is in that registry (the registry is the case-canonicalisation
 *     authority for the App namespace — a handler missing from it would 404 on
 *     any-cased requests).
 *
 * Both `.ts` and `.js` handlers are walked: an Astro route can be either, and
 * a `.js`-only scan would silently miss one.
 *
 * Run with `yarn endpoints:check`. It exits non-zero when any rule is violated.
 */
import {readdirSync, existsSync, statSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {
  APP_BOOK_REQUEST_ROUTES,
  APP_BOOK_REQUEST_CONTENT_SUFFIXES,
  APP_BOOK_REQUEST_ANONYMOUS_ROUTES,
} from "../src/server/api/access";
import {API_BASE_PATH, LEGACY_API_BASE_PATH} from "../src/shared/ApiVersion";
import {OPENAPI_DOCUMENT} from "../src/shared/OpenApiDocument";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const apiRoot = path.join(repositoryRoot, "src", "pages", "api");

type Finding = {file: string; line: number; rule: string; message: string};

const findings: Finding[] = [];
function report(file: string, rule: string, message: string, line = 1): void {
  findings.push({file, line, rule, message});
}

/** `/api/v1` and `/api`, longest first so the versioned prefix wins. */
const BASE_PREFIXES = [API_BASE_PATH.replace(/\/$/u, ""), LEGACY_API_BASE_PATH.replace(/\/$/u, "")];

/** Exemption class 2: the four App-internal channels outside AppBookRequest. */
const APP_CHANNEL_PATHS = new Set([
  "/api/app/version",
  "/api/app/announcements",
  "/api/app/search-permission",
  "/api/app/mingci-permission",
]);

/** Exemption class 4: the contract and generated-doc endpoints. */
const META_DOC_PATHS = new Set([
  "/api/openapi.html",
  "/api/openapi.json",
  "/api/openapi.yaml",
  "/api/llms.txt",
  "/api/llms-full.txt",
  `${API_BASE_PATH}openapi.json`,
  `${API_BASE_PATH}openapi.yaml`,
  `${API_BASE_PATH}llms.txt`,
  `${API_BASE_PATH}llms-full.txt`,
]);

function walk(directory: string, out: string[] = []): string[] {
  if (!existsSync(directory)) return out;
  for (const name of readdirSync(directory).sort()) {
    const entry = path.join(directory, name);
    if (statSync(entry).isDirectory()) walk(entry, out);
    // Both extensions: an Astro route can be either, and a `.ts`-only scan
    // would silently miss a `.js` handler.
    else if (isHandlerFile(name)) out.push(entry);
  }
  return out;
}

function isHandlerFile(name: string): boolean {
  if (name.endsWith(".test.ts") || name.endsWith(".test.js")) return false;
  return name.endsWith(".ts") || name.endsWith(".js");
}

function stripExtension(name: string): string {
  return name.replace(/\.(ts|js)$/u, "");
}

/**
 * Turn a handler file path into its public route, e.g.
 *   src/pages/api/v1/items/[itemId]/index.ts -> /api/v1/items/{itemId}/
 *   src/pages/api/openapi.json.ts            -> /api/openapi.json
 *   src/pages/api/index.ts                   -> /api/
 * A directory route (the file is `index.ts`) keeps Astro's trailing slash; a
 * named file route (`openapi.json.ts`) does not.
 * Returns null for a catch-all route (`[...all]`), which has no single route.
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

const handlerFiles = walk(apiRoot);
const appBookRequestRoot = path.join(apiRoot, "AppBookRequest");
const appBookRequestFiles = walk(appBookRequestRoot);
const publicHandlerFiles = handlerFiles.filter((file) => !file.startsWith(appBookRequestRoot));

const matchedOpenApiPaths = new Set<string>();
let openApiHandlerCount = 0;
let exemptHandlerCount = 0;

for (const file of publicHandlerFiles) {
  const relative = path.relative(repositoryRoot, file).replace(/\\/gu, "/");
  const route = routeFor(file);

  // better-auth owns the whole `/api/auth/*` tree, catch-all or named. Match on
  // the file path rather than the derived route so a future `auth/foo.ts` is
  // exempt too — a route-only check would false-positive on it.
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
const preAuthLower = new Set(
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
  if (!contentLower.has(routeLower) && !preAuthLower.has(routeLower)) {
    report(
      relative,
      "ENDPOINT-005",
      "handler is registered but is neither a content route (APP_BOOK_REQUEST_CONTENT_SUFFIXES) nor an anonymous route (APP_BOOK_REQUEST_ANONYMOUS_ROUTES)",
    );
  }
}
for (const route of APP_BOOK_REQUEST_ROUTES) {
  if (!existsSync(path.join(appBookRequestRoot, `${route}.ts`))) {
    report(
      "src/server/api/access.ts",
      "ENDPOINT-006",
      `APP_BOOK_REQUEST_ROUTES lists "${route}" but src/pages/api/AppBookRequest/${route}.ts does not exist`,
    );
  }
}

if (findings.length > 0) {
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line} [${finding.rule}] ${finding.message}`);
  }
  console.error(`\n${findings.length} endpoint registration violation(s).`);
  process.exit(1);
}

console.log(
  `OK: ${handlerFiles.length} handlers — ` +
  `${publicHandlerFiles.length} public (${openApiHandlerCount} map to ${matchedOpenApiPaths.size} OpenAPI paths, ` +
  `all ${openApiPaths.size} contract paths covered; ${exemptHandlerCount} in exemption classes), ` +
  `${appBookRequestFiles.length} AppBookRequest (all registered).`,
);
