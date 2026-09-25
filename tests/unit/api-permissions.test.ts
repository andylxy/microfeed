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

import {isIntegrationApiPath} from "@/server/api/access";
import {requiredApiPermission} from "@/server/api/api-permissions";
import {API_BASE_PATH, LEGACY_API_BASE_PATH} from "@/shared/ApiVersion";
import {OPENAPI_DOCUMENT} from "@/shared/OpenApiDocument";

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
