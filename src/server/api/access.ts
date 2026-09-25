import {apiKeyScopes, readApiAccessSettings} from "./api-keys";
import {builtInAdminAuthEnabled} from "@/shared/AdminAuth";
import {
  API_BASE_PATH,
  LEGACY_API_BASE_PATH,
  LEGACY_API_DEPRECATION,
} from "@/shared/ApiVersion";
import {OAUTH_SCOPES} from "@/shared/OAuth";
import {verifyOAuthAccessToken} from "@/server/auth/oauth-access";

const PUBLIC_API_REFERENCE_SUFFIXES = new Set([
  "",
  "openapi.html",
  "openapi.json",
  "openapi.yaml",
  "llms.txt",
  "llms-full.txt",
]);

export interface ApiPathDetails {
  canonicalPath: string;
  kind: "integration" | "reference";
  legacy: boolean;
}

export type ApiRequestDecision =
  | "allow-integration"
  | "allow-reference"
  | "insufficient-scope"
  | "not-found"
  | "unauthorized";

function integrationSuffix(suffix: string, legacy: boolean): boolean {
  return suffix === "feed/" ||
    suffix === "items/" ||
    /^items\/[^/]+\/$/u.test(suffix) ||
    /^channels\/[^/]+\/$/u.test(suffix) ||
    suffix === "media_files/presigned_urls/" ||
    (!legacy && (
      // Novel content read API (ADR-0006). Registered inside this guard on
      // purpose: a legacy `/api/content/*` caller then falls through to
      // not-found (404) instead of reaching the OAuth-scope path, where any key
      // holding `content:read` would read every category, book and chapter.
      suffix === "content/categories/" ||
      /^content\/categories\/[^/]+\/books\/$/u.test(suffix) ||
      /^content\/books\/[^/]+\/chapters\/$/u.test(suffix) ||
      /^content\/chapters\/[^/]+\/$/u.test(suffix) ||
      suffix === "search/" ||
      suffix === "pages/" ||
      suffix === "pages/validate/" ||
      /^pages\/[^/]+\/$/u.test(suffix) ||
      suffix === "site-files/" ||
      suffix === "site-files/validate/" ||
      /^site-files\/[^/]+\/$/u.test(suffix) ||
      /^site-files\/[^/]+\/(?:publish|reset)\/$/u.test(suffix)
    ));
}

export function apiPathDetails(pathname: string): ApiPathDetails | null {
  const bases = [
    {base: API_BASE_PATH, legacy: false},
    {base: LEGACY_API_BASE_PATH, legacy: true},
  ] as const;

  for (const {base, legacy} of bases) {
    if (!pathname.startsWith(base)) continue;
    const suffix = pathname.slice(base.length);
    if (PUBLIC_API_REFERENCE_SUFFIXES.has(suffix)) {
      return {
        canonicalPath: `${API_BASE_PATH}${suffix}`,
        kind: "reference",
        legacy,
      };
    }
    if (integrationSuffix(suffix, legacy)) {
      return {
        canonicalPath: `${API_BASE_PATH}${suffix}`,
        kind: "integration",
        legacy,
      };
    }
    return null;
  }
  return null;
}

export function isPublicApiReferencePath(pathname: string): boolean {
  return apiPathDetails(pathname)?.kind === "reference";
}

export function isIntegrationApiPath(pathname: string): boolean {
  return apiPathDetails(pathname)?.kind === "integration";
}

export function addLegacyApiDeprecationHeaders(
  response: Response,
  requestUrl: URL,
  pathname: string,
): Response {
  const details = apiPathDetails(pathname);
  if (!details?.legacy) return response;

  const successor = new URL(details.canonicalPath, requestUrl);
  successor.search = requestUrl.search;
  const headers = new Headers(response.headers);
  headers.set("deprecation", LEGACY_API_DEPRECATION);
  headers.append(
    "link",
    `<${successor.toString()}>; rel="successor-version"`,
  );
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export function providedApiKey(request: Request): string | null {
  const authorization = request.headers.get("authorization")?.trim();
  if (authorization) {
    const bearer = /^Bearer(?:\s+(.+))?$/iu.exec(authorization);
    if (bearer) {
      return bearer[1]?.trim() || "";
    }
  }
  return request.headers.get("x-microfeedapi-key")?.trim() || null;
}

export async function decideApiRequest(
  database: D1Database,
  request: Request,
  pathname: string,
  adminAuthMode?: string,
): Promise<ApiRequestDecision> {
  const settings = await readApiAccessSettings(database);
  const details = apiPathDetails(pathname);
  if (details?.kind === "reference") {
    return settings.enabled && settings.publicDocsEnabled
      ? "allow-reference"
      : "not-found";
  }
  if (details?.kind !== "integration" || !settings.enabled) {
    return "not-found";
  }
  const apiKey = providedApiKey(request);
  if (!apiKey) return "unauthorized";
  const requiredScope = ["GET", "HEAD"].includes(request.method.toUpperCase())
    ? OAUTH_SCOPES.READ
    : OAUTH_SCOPES.WRITE;
  const integrationScopes = await apiKeyScopes(database, apiKey);
  if (integrationScopes) {
    return integrationScopes.has(requiredScope)
      ? "allow-integration"
      : "insufficient-scope";
  }
  if (!builtInAdminAuthEnabled(adminAuthMode)) {
    return "unauthorized";
  }
  const grant = await verifyOAuthAccessToken(database, apiKey);
  if (!grant) return "unauthorized";
  return grant.scopes.has(requiredScope)
    ? "allow-integration"
    : "insufficient-scope";
}

// ---------------------------------------------------------------------------
// Shared by the login-credential bearer path (`credential-bearer.ts`) and the
// middleware: the attribution of a decided API request, plus the access-log
// writer. The legacy bearer path above is left completely untouched.
// ---------------------------------------------------------------------------

export interface ApiAttribution {
  /** `api_keys.id` of a signed call. Always `null` since the signed-call path
   *  was removed (ADR-0008); kept so the access-log column stays populated. */
  apiKeyId: string | null;
  /** `ext_login_credentials.id` behind a bearer call; `null` elsewhere. */
  credentialId?: string | null;
  userId: string;
  /** The RBAC code the request was checked against, or `null` when the path
   *  requires no code (an upstream-owned domain — see `api-permissions.ts`). */
  permissionCode: string | null;
}

/**
 * Best-effort, non-blocking audit row linking a call to whoever made it: the API
 * key behind a signed call, or the login credential behind a sessionless bearer.
 * Both the allow and the deny paths write one, so denied calls are auditable
 * too. Swallows errors so logging never fails a request.
 */
export async function writeApiAccessLog(
  database: D1Database,
  attribution: ApiAttribution,
  method: string,
  path: string,
  granted: boolean,
  status: number,
): Promise<void> {
  // B6: `permission_code` is NOT NULL, so a null attribution would make the
  // insert fail and be silently swallowed by the catch below. Write an explicit
  // sentinel for "no code was mapped" instead of null, so the row always lands.
  const permissionCode = attribution.permissionCode ?? "__unmapped__";
  try {
    await database.prepare(
      "INSERT INTO ext_api_access_log " +
        "(id, api_key_id, credential_id, user_id, method, path, permission_code, granted, status, created_at_ms) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      crypto.randomUUID(),
      attribution.apiKeyId,
      attribution.credentialId ?? null,
      attribution.userId,
      method,
      path,
      permissionCode,
      granted ? 1 : 0,
      status,
      Date.now(),
    ).run();
  } catch (error) {
    // Audit is best-effort, but a failure here is a real signal (schema drift,
    // quota, …) and must not be invisible — surface it instead of swallowing.
    console.error("api access log write failed", {path, method, status, granted, error});
  }
}
