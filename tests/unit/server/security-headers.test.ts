import {describe, expect, it} from "vitest";

import {withSecurityHeaders} from "@/server/security-headers";

/**
 * 安全响应头（ADR-0047 D2）的纯函数行为：头取值、admin 路径 CSP 门控、
 * 已有头跳过、https 门控 HSTS。middleware 导出层的接线是在缓存策略之后
 * 调用本函数，覆盖 handleRequest 全部出口。
 */
function apply(
  path: string,
  options: {
    adminPath?: string;
    headers?: Record<string, string>;
    protocol?: string;
  } = {},
): Headers {
  const protocol = options.protocol ?? "https";
  const request = new Request(`${protocol}://feed.example.com${path}`);
  const response = new Response("body", {headers: options.headers ?? {}});
  return withSecurityHeaders(request, response, {
    adminPath: options.adminPath ?? "admin",
  }).headers;
}

describe("withSecurityHeaders", () => {
  it("adds CSP and the shared headers on admin paths over https", () => {
    const headers = apply("/admin/items");
    expect(headers.get("content-security-policy")).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
        "style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; " +
        "connect-src 'self'; object-src 'none'; base-uri 'self'; " +
        "form-action 'self'; frame-ancestors 'self'",
    );
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(headers.get("strict-transport-security")).toBe("max-age=31536000");
  });

  it("adds the shared headers but no CSP on public paths", () => {
    const headers = apply("/books/abc");
    expect(headers.get("content-security-policy")).toBeNull();
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("omits HSTS on http (local dev) responses", () => {
    const headers = apply("/admin/items", {protocol: "http"});
    expect(headers.get("strict-transport-security")).toBeNull();
    expect(headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("keeps a response-provided CSP (theme preview) untouched", () => {
    const previewCsp = "default-src 'self'; script-src 'self'";
    const headers = apply("/admin/settings", {
      headers: {"content-security-policy": previewCsp},
    });
    expect(headers.get("content-security-policy")).toBe(previewCsp);
    expect(headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("never duplicates a header the response already carries", () => {
    const headers = apply("/media/pic.png", {
      headers: {"x-content-type-options": "nosniff"},
    });
    expect(headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("honours a custom admin path for the CSP gate", () => {
    const headers = apply("/panel/items", {adminPath: "panel"});
    expect(headers.get("content-security-policy")).toContain("frame-ancestors");
    const other = apply("/admin/items", {adminPath: "panel"});
    expect(other.get("content-security-policy")).toBeNull();
  });
});
