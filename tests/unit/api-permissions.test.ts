/**
 * A1 guardrail: every path that `apiPathDetails` classifies as an *integration*
 * path must map to a concrete RBAC code. Before A1 the `pages` / `site-files` /
 * `media_files` domains returned `null`, which the login-credential bearer path
 * treated as "no code required" — i.e. any credential could call them. This test
 * pins the mapping so a future rule deletion fails loudly instead of silently
 * re-opening a domain.
 *
 * The candidates are **derived, not hand-listed**: every method the served
 * OpenAPI document declares becomes a probe, and the classifier
 * (`isIntegrationApiPath`) decides which probes must carry a code. A path added
 * to the document — or a suffix rule added to `access.ts` — is therefore covered
 * the moment it ships, with no list here to keep in sync.
 */

import {describe, expect, it} from "vitest";

import {readdirSync} from "node:fs";
import {fileURLToPath} from "node:url";

import {
  apiPathDetails,
  isIntegrationApiPath,
  APP_BOOK_REQUEST_ROUTES,
  APP_BOOK_REQUEST_CONTENT_SUFFIXES,
} from "@/server/api/access";
import {requiredApiPermission} from "@/server/api/api-permissions";
import {API_BASE_PATH, LEGACY_API_BASE_PATH} from "@/shared/ApiVersion";
import {OPENAPI_DOCUMENT} from "@/shared/OpenApiDocument";
import {canonicalPathname} from "@/shared/StringUtils";

const HTTP_METHODS = ["get", "post", "put", "delete", "patch"] as const;

/** Replace `{param}` templates with a sample segment so the path can be probed. */
function concretize(path: string): string {
  return path.replace(/\{[^}]+\}/gu, "sample-id");
}

/** Every (absolute path, method) pair the OpenAPI document advertises. */
function documentedPairs(): Array<[path: string, method: string]> {
  const base = API_BASE_PATH.replace(/\/$/u, "");
  const pairs: Array<[path: string, method: string]> = [];
  for (const [path, operation] of Object.entries(OPENAPI_DOCUMENT.paths ?? {})) {
    const record = operation as Record<string, unknown>;
    for (const method of HTTP_METHODS) {
      if (method in record) {
        pairs.push([`${base}${concretize(path)}`, method.toUpperCase()]);
      }
    }
  }
  return pairs;
}

describe("every integration path maps to a RBAC code (A1 fail-closed)", () => {
  const documented = documentedPairs();

  it("probes the whole documented surface", () => {
    // A lower bound keeps the scan honest: a rename of `paths` that emptied the
    // derived list would otherwise pass vacuously.
    expect(documented.length).toBeGreaterThanOrEqual(25);
  });

  for (const [path, method] of documented) {
    it(`${method} ${path}`, () => {
      // Only integration paths carry a code requirement; the reference surface
      // (openapi.*, llms.*) stays public on purpose.
      if (isIntegrationApiPath(path)) {
        expect(
          requiredApiPermission(path, method),
          `${method} ${path} is an integration path but maps to no code`,
        ).not.toBeNull();
      }
    });
  }

  it("keeps the legacy base out of the integration class for the content API", () => {
    // Fail-closed is only half the story: a legacy `/api/content/*` caller must
    // fall through to not-found rather than reach the OAuth-scope path, where
    // any key holding `content:read` would read every category, book and chapter.
    expect(
      isIntegrationApiPath(`${LEGACY_API_BASE_PATH}content/chapters/sample-id/`),
    ).toBe(false);
  });

  it("the formerly-unmapped domains now require their manage code", () => {
    expect(requiredApiPermission("/api/v1/pages/", "POST")).toBe(
      "content:page:manage",
    );
    expect(requiredApiPermission("/api/v1/site-files/", "POST")).toBe(
      "content:site_file:manage",
    );
    expect(
      requiredApiPermission("/api/v1/media_files/presigned_urls/", "POST"),
    ).toBe("media:file:manage");
  });

  it("still never returns an api:* code", () => {
    for (const [path, method] of documented) {
      expect(requiredApiPermission(path, method)).not.toMatch(/^api:/u);
    }
  });
});

describe("mobile app namespace (/api/AppBookRequest/…)", () => {
  const CONTENT = [
    "GetNav",
    "GetBookChapter",
    "GetChapterContent",
    "GetBookIdFang",
    "GetAllZhongYao",
    "GetAliaZhongYao",
    "GetAllMingCi",
    "GetTipsStyleConfig",
  ];
  const ANONYMOUS = [
    "login",
    "replaceToken",
    "getPicCaptcha",
    "GetProjectInfo",
    "GetLoginInfo",
    "getAboutInfo",
  ];

  it("classifies only the content endpoints as integration paths", () => {
    for (const name of CONTENT) {
      expect(isIntegrationApiPath(`/api/AppBookRequest/${name}/`)).toBe(true);
    }
    for (const name of ANONYMOUS) {
      expect(isIntegrationApiPath(`/api/AppBookRequest/${name}/`)).toBe(false);
    }
  });

  it("is a non-legacy integration surface (no deprecation headers)", () => {
    expect(apiPathDetails("/api/AppBookRequest/GetNav/")).toEqual({
      canonicalPath: "/api/v1/AppBookRequest/GetNav/",
      kind: "integration",
      legacy: false,
    });
  });

  it("requires the single app:mobile:access code for content endpoints", () => {
    for (const name of CONTENT) {
      expect(
        requiredApiPermission(`/api/AppBookRequest/${name}/`, "GET"),
      ).toBe("app:mobile:access");
    }
    // Pre-auth / config endpoints are not integration paths → no code required
    // (the middleware exempts them from auth rather than mapping a code).
    expect(requiredApiPermission("/api/AppBookRequest/login/", "POST")).toBeNull();
    expect(
      requiredApiPermission("/api/AppBookRequest/GetProjectInfo/", "GET"),
    ).toBeNull();
  });
});

describe("app search-permission endpoint (/api/app/search-permission/)", () => {
  it("is an integration path under the legacy base", () => {
    // 断言的是**中间件真正派发的形态**：鉴权前 `canonicalPathname` 会给无扩展名
    // 路径补尾斜杠并 308，所以注册与断言都必须用带斜杠的形态。
    // 早期版本这里断言无斜杠形态，测试全绿而线上 404 —— 断言必须跟着真实链路走。
    expect(isIntegrationApiPath("/api/app/search-permission/")).toBe(true);
    expect(apiPathDetails("/api/app/search-permission/")).toEqual({
      canonicalPath: "/api/v1/app/search-permission/",
      kind: "integration",
      legacy: false,
    });
  });

  it("survives the canonical trailing-slash redirect the middleware applies", () => {
    // 回归：客户端请求无斜杠形态时，中间件 308 到带斜杠形态。若后端只认无斜杠，
    // 重定向后的请求在 apiPathDetails 里无一分支命中 → not-found(404)，
    // app:mobile:access 门形同虚设。这里锁死「重定向后仍是 integration + 仍需权限码」。
    const requested = "/api/app/search-permission";
    const dispatched = canonicalPathname(requested);
    expect(dispatched).toBe("/api/app/search-permission/");
    expect(isIntegrationApiPath(dispatched)).toBe(true);
    expect(requiredApiPermission(dispatched, "GET")).toBe("app:mobile:access");
  });

  it("requires the app:mobile:access code at the path level", () => {
    // The per-code search decision (global/book) is made by the handler; the
    // middleware only enforces that the caller may use the mobile app at all.
    expect(requiredApiPermission("/api/app/search-permission/", "GET")).toBe(
      "app:mobile:access",
    );
  });

  it("carries no deprecation headers (the /api/v1 successor does not exist)", () => {
    // legacy:false → 中间件不会加 Deprecation / Link rel="successor-version"，
    // 避免把客户端指向并不存在的 /api/v1/app/search-permission/。
    expect(apiPathDetails("/api/app/search-permission/")?.legacy).toBe(false);
  });
});

describe("app mingci-permission endpoint (/api/app/mingci-permission/)", () => {
  // 与上面 search-permission 四例一一对应。ADR-0001 §3.3.5 要求本端点严格镜像
  // search-permission，任何对 search 一侧的改动都应同步到此处。
  it("is an integration path under the legacy base", () => {
    expect(isIntegrationApiPath("/api/app/mingci-permission/")).toBe(true);
    expect(apiPathDetails("/api/app/mingci-permission/")).toEqual({
      canonicalPath: "/api/v1/app/mingci-permission/",
      kind: "integration",
      legacy: false,
    });
  });

  it("survives the canonical trailing-slash redirect the middleware applies", () => {
    const requested = "/api/app/mingci-permission";
    const dispatched = canonicalPathname(requested);
    expect(dispatched).toBe("/api/app/mingci-permission/");
    expect(isIntegrationApiPath(dispatched)).toBe(true);
    expect(requiredApiPermission(dispatched, "GET")).toBe("app:mobile:access");
  });

  it("requires the app:mobile:access code at the path level", () => {
    // 路径级门只管「能不能用 App」；名词解释本身的可见性由 handler 决定。
    expect(requiredApiPermission("/api/app/mingci-permission/", "GET")).toBe(
      "app:mobile:access",
    );
  });

  it("carries no deprecation headers (the /api/v1 successor does not exist)", () => {
    expect(apiPathDetails("/api/app/mingci-permission/")?.legacy).toBe(false);
  });
});

describe("AppBookRequest route registry is fail-open-safe (ADR-0011 D2)", () => {
  // Routes that are deliberately anonymous (pre-auth / config). The middleware
  // skips the /api/ auth block for any AppBookRequest path that is NOT an
  // integration path, so these MUST be explicitly listed — an unlisted addition
  // would silently become anonymous (fail-open). This set is the human-owned
  // counterpart to `APP_BOOK_REQUEST_ROUTES`; the assertions below pin the two
  // together so a new route can never land in a gap.
  const ANONYMOUS = new Set([
    "login",
    "replaceToken",
    "getPicCaptcha",
    "GetProjectInfo",
    "GetLoginInfo",
    "getAboutInfo",
  ]);
  const ANONYMOUS_LOWER = new Set([...ANONYMOUS].map((name) => name.toLowerCase()));

  // `APP_BOOK_REQUEST_CONTENT_SUFFIXES` preserves the canonical (mixed-case)
  // route casing; `isIntegrationApiPath` only matches that exact casing, because
  // the middleware canonicalises the path before dispatching. So the path probe
  // uses the original-case names, while the set-membership checks compare
  // case-insensitively (the registry itself is case-insensitive at runtime).
  const CONTENT_PREFIX = "AppBookRequest/";
  const contentNames = [...APP_BOOK_REQUEST_CONTENT_SUFFIXES].map((suffix) =>
    suffix.slice(CONTENT_PREFIX.length, -1),
  );
  const contentLower = new Set(contentNames.map((name) => name.toLowerCase()));
  const routesLower = new Set(APP_BOOK_REQUEST_ROUTES.map((route) => route.toLowerCase()));

  it("every registered route is content (auth-required) or explicitly anonymous", () => {
    for (const route of routesLower) {
      expect(
        contentLower.has(route) || ANONYMOUS_LOWER.has(route),
        `route "${route}" is neither a content route (in APP_BOOK_REQUEST_CONTENT_SUFFIXES) nor an explicitly anonymous pre-auth/config route`,
      ).toBe(true);
    }
  });

  it("content and anonymous sets partition the registry exactly (no silent gap)", () => {
    for (const route of contentLower) {
      expect(ANONYMOUS_LOWER.has(route), `${route} is both content and anonymous`).toBe(false);
    }
    for (const route of routesLower) {
      expect(
        contentLower.has(route) || ANONYMOUS_LOWER.has(route),
        `${route} is in the registry but neither content nor anonymous`,
      ).toBe(true);
    }
    for (const route of ANONYMOUS_LOWER) {
      expect(routesLower.has(route), `${route} is anonymous but missing from the registry`).toBe(true);
    }
    for (const route of contentLower) {
      expect(routesLower.has(route), `${route} is a content suffix but missing from the registry`).toBe(true);
    }
  });

  it("classifies each route the way the middleware will", () => {
    for (const name of contentNames) {
      expect(isIntegrationApiPath(`/api/AppBookRequest/${name}/`)).toBe(true);
    }
    for (const name of ANONYMOUS) {
      expect(isIntegrationApiPath(`/api/AppBookRequest/${name}/`)).toBe(false);
    }
  });

  // The runtime fail-open decision keys off `APP_BOOK_REQUEST_CONTENT_SUFFIXES`
  // (see `middleware.ts`: `!isIntegrationApiPath(pathname) → next()`), NOT this
  // registry. So the real D2 gap is a handler file that exists under
  // `src/pages/api/AppBookRequest/` yet is absent from the content suffix set —
  // it would be served anonymously. Enumerate the on-disk handlers so that gap
  // fails CI, and pin the registry to exactly that set.
  const HANDLER_DIR = fileURLToPath(
    new URL("../../src/pages/api/AppBookRequest", import.meta.url),
  );
  const handlerRoutes = readdirSync(HANDLER_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => name.slice(0, -".ts".length));

  it("every on-disk handler is content (auth-required) or explicitly anonymous", () => {
    for (const route of handlerRoutes) {
      const lower = route.toLowerCase();
      expect(
        contentLower.has(lower) || ANONYMOUS_LOWER.has(lower),
        `handler ${route}.ts is neither a content route (in APP_BOOK_REQUEST_CONTENT_SUFFIXES → auth) nor an explicitly anonymous pre-auth/config route — the middleware would serve it anonymously (fail-open)`,
      ).toBe(true);
    }
  });

  it("the registry and the on-disk handlers are the same set", () => {
    const handlers = handlerRoutes.map((name) => name.toLowerCase()).sort();
    expect(handlers).toEqual([...routesLower].sort());
  });
});
