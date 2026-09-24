/**
 * Tests for the API integration permission mapping.
 *
 * `requiredApiPermission` maps an integration request to the RBAC permission
 * code it requires. Since ADR-0009 the codes are the dashboard's own
 * `content:*:*` codes, split by HTTP method, and a path with no rule requires no
 * code at all (`null`).
 *
 * (Formerly part of `api-credentials.test.ts`; the signed-call half of that
 * suite was removed with the signed-call path — see ADR-0008.)
 */

import {describe, expect, it} from "vitest";

import {requiredApiPermission} from "@/server/api/api-permissions";

describe("requiredApiPermission mapping", () => {
  it("maps the article domain by HTTP method", () => {
    expect(requiredApiPermission("/api/v1/items/", "GET")).toBe(
      "content:chapter:read",
    );
    expect(requiredApiPermission("/api/v1/items/", "POST")).toBe(
      "content:chapter:create",
    );
    expect(requiredApiPermission("/api/v1/items/abc123/", "PUT")).toBe(
      "content:chapter:update",
    );
    expect(requiredApiPermission("/api/v1/items/abc123/", "PATCH")).toBe(
      "content:chapter:update",
    );
    expect(requiredApiPermission("/api/v1/items/abc123/", "DELETE")).toBe(
      "content:chapter:delete",
    );
  });

  it("treats HEAD as a read", () => {
    expect(requiredApiPermission("/api/v1/items/", "HEAD")).toBe(
      "content:chapter:read",
    );
  });

  it("maps the legacy base path the same way as the versioned one", () => {
    // The compatibility base (`/api/`) must not fall through to "no code
    // required": that would let a credential read or delete content with no
    // content permission at all.
    expect(requiredApiPermission("/api/items/", "GET")).toBe(
      "content:chapter:read",
    );
    expect(requiredApiPermission("/api/items/abc123/", "DELETE")).toBe(
      "content:chapter:delete",
    );
    expect(requiredApiPermission("/api/feed/", "GET")).toBe(
      "content:chapter:read",
    );
  });

  it("maps the item validation endpoint as a create", () => {
    expect(requiredApiPermission("/api/v1/items/validate/", "POST")).toBe(
      "content:chapter:create",
    );
  });

  it("maps the read-only content endpoints to the article read code", () => {
    expect(requiredApiPermission("/api/v1/feed/", "GET")).toBe(
      "content:chapter:read",
    );
    expect(requiredApiPermission("/api/v1/search/", "GET")).toBe(
      "content:chapter:read",
    );
  });

  it("maps the channel domain to the channel manage code", () => {
    expect(requiredApiPermission("/api/v1/channels/primary/", "PUT")).toBe(
      "content:channel:manage",
    );
    expect(requiredApiPermission("/api/v1/channels/primary/", "GET")).toBe(
      "content:channel:manage",
    );
  });

  it("maps the content read API to the dashboard codes", () => {
    expect(requiredApiPermission("/api/v1/content/categories/", "GET")).toBe(
      "content:category:read",
    );
    expect(
      requiredApiPermission("/api/v1/content/categories/abc/books/", "GET"),
    ).toBe("content:category:read");
    expect(
      requiredApiPermission("/api/v1/content/books/abc/chapters/", "GET"),
    ).toBe("content:book:read");
  });

  it("requires no code for the legacy content base", () => {
    // The content paths are registered v1-only, so a legacy caller is reported as
    // not-found by `apiPathDetails` before the RBAC mapping is consulted.
    expect(requiredApiPermission("/api/content/categories/", "GET")).toBeNull();
  });

  it("requires no code for upstream-owned domains", () => {
    // pages / site-files / media keep the upstream OAuth-scope model, so the
    // RBAC mapping deliberately has no rule for them.
    expect(requiredApiPermission("/api/v1/pages/", "GET")).toBeNull();
    expect(requiredApiPermission("/api/v1/pages/", "POST")).toBeNull();
    expect(requiredApiPermission("/api/v1/site-files/", "POST")).toBeNull();
    expect(
      requiredApiPermission("/api/v1/media_files/presigned_urls/", "POST"),
    ).toBeNull();
  });

  it("maps the novel content read endpoints by resource", () => {
    expect(requiredApiPermission("/api/v1/content/categories/", "GET")).toBe(
      "content:category:read",
    );
    expect(
      requiredApiPermission("/api/v1/content/categories/abc/books/", "GET"),
    ).toBe("content:category:read");
    expect(
      requiredApiPermission("/api/v1/content/books/abc/chapters/", "GET"),
    ).toBe("content:book:read");
    expect(requiredApiPermission("/api/v1/content/chapters/abc/", "GET")).toBe(
      "content:chapter:read",
    );
  });

  it("requires no code for non-integration paths", () => {
    expect(requiredApiPermission("/api/v1/unknown/", "GET")).toBeNull();
    expect(requiredApiPermission("/admin/", "GET")).toBeNull();
    expect(requiredApiPermission("/api/v1/openapi.json", "GET")).toBeNull();
  });

  it("never returns an api:* code", () => {
    for (const [path, method] of [
      ["/api/v1/items/", "GET"],
      ["/api/v1/items/", "POST"],
      ["/api/v1/items/abc123/", "DELETE"],
      ["/api/v1/feed/", "GET"],
      ["/api/v1/channels/primary/", "PUT"],
    ] as const) {
      expect(requiredApiPermission(path, method)).not.toMatch(/^api:/u);
    }
  });
});
