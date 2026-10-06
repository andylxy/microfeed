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

import {apiPathDetails, isIntegrationApiPath} from "@/server/api/access";
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
