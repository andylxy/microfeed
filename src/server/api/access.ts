import {apiKeyScopes, readApiAccessSettings} from "./api-keys";
import {builtInAdminAuthEnabled} from "@/shared/AdminAuth";
import {
  API_BASE_PATH,
  LEGACY_API_BASE_PATH,
  LEGACY_API_DEPRECATION,
} from "@/shared/ApiVersion";
import {OAUTH_SCOPES} from "@/shared/OAuth";
import {verifyOAuthAccessToken} from "@/server/auth/oauth-access";
import {resolveUserPermissions, RBAC_WILDCARD} from "@/server/rbac/resolve";
import {verifySignedCall} from "./signed-call";
import {requiredApiPermission} from "./api-permissions";

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
// Signed-call path (XiHan BasicApp model). Reached only when `X-Access-Key` is
// present; the legacy bearer path above is left completely untouched.
// ---------------------------------------------------------------------------

export interface ApiAttribution {
  /** `api_keys.id` behind a signed call; `null` on a login-credential call. */
  apiKeyId: string | null;
  /** `ext_login_credentials.id` behind a bearer call; `null` elsewhere. */
  credentialId?: string | null;
  userId: string;
  permissionCode: string;
}

export type SignedApiDecision =
  | {kind: "allow"; attribution: ApiAttribution}
  | {kind: "reference"}
  | {kind: "notFound"}
  | {kind: "unauthorized"}
  | {kind: "forbidden"; attribution: ApiAttribution}
  | {kind: "replay"};

/**
 * Decide a signature-based API request. Verification establishes *which user*
 * owns the key; authorization is delegated to RBAC — the resolved user's
 * permission set must contain the code `requiredApiPermission` returns (or the
 * `*` wildcard). On success the attribution (key + user + permission) is
 * returned so the middleware can write the access log.
 */
export async function decideSignedApiRequest(
  database: D1Database,
  request: Request,
  pathname: string,
): Promise<SignedApiDecision> {
  const details = apiPathDetails(pathname);
  if (!details) return {kind: "notFound"};
  if (details.kind === "reference") return {kind: "reference"};

  const verified = await verifySignedCall(database, request);
  if (!verified.ok) {
    return verified.reason === "replay"
      ? {kind: "replay"}
      : {kind: "unauthorized"};
  }

  const permissionCode = requiredApiPermission(pathname, request.method)
    ?? "api:content:read";
  const permissions = await resolveUserPermissions(
    database,
    verified.identity.userId,
  );
  const attribution: ApiAttribution = {
    apiKeyId: verified.identity.apiKeyId,
    userId: verified.identity.userId,
    permissionCode,
  };
  const granted = permissions.has(RBAC_WILDCARD)
    || permissions.has(permissionCode);
  return granted
    ? {kind: "allow", attribution}
    : {kind: "forbidden", attribution};
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
      attribution.permissionCode,
      granted ? 1 : 0,
      status,
      Date.now(),
    ).run();
  } catch {
    // audit is best-effort
  }
}
