/**
 * `GET /api/app/version` — the App's upgrade descriptor (spec §6.5).
 *
 * Anonymous on purpose: a client that has been force-upgraded (or never logged
 * in) still needs this to learn *that* it must upgrade and *where* to download
 * the new build. It therefore reads the floor but **never** answers 426 — the
 * 426 lives only on the content namespace `/api/AppBookRequest/*` (ADR-0005).
 *
 * Not part of the legacy `AppBookRequest` envelope (`{code,data,msg}`) and not
 * registered in the OpenAPI contract: it is an App-internal channel, not a
 * public feed API — the same carve-out AGENTS.md「API 契约与文档」names for
 * `/api/AppBookRequest/*`, extended to this path explicitly because it sits
 * outside that prefix. Its runtime contract is locked by
 * `tests/worker/app-version-routes.test.ts` and `tests/unit/app-version.test.ts`
 * instead. It is also excluded from the middleware's canonicalisation so the
 * exact `/api/app/version` URL is served directly.
 */

import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {readAppVersionConfig} from "@/server/app-version/config";
import {
  compareVersionCode,
  parseAppVersionCode,
  resolveMinVersionForRequest,
} from "@/server/app-version/resolve";
import {deviceIdFromRequest} from "@/server/rbac/resolve";
import {jsonResponse} from "@/server/http";

export const GET: APIRoute = async ({request}) => {
  const db = env.FEED_DB;
  const [config, resolved] = await Promise.all([
    readAppVersionConfig(db),
    resolveMinVersionForRequest(db, {deviceId: deviceIdFromRequest(request)}),
  ]);
  // `force` answers "must **this caller** upgrade", not "is there a floor":
  // below the hard floor (or no version reported at all) is a hard block;
  // anything else — including a newer release being available — is a soft
  // prompt. The App trusts this value verbatim and must not recompute it from
  // `minVersionCode` (ADR-0008 §5).
  const headerCode = parseAppVersionCode(request.headers.get("app-version"));
  const force = headerCode === null ||
    compareVersionCode(headerCode, resolved.minVersionCode) < 0;
  return jsonResponse(
    {
      downloadUrl: config.downloadUrl,
      force,
      latestVersionCode: config.latestVersionCode,
      latestVersionName: config.latestVersionName,
      md5: config.md5,
      minVersionCode: resolved.minVersionCode,
      updateLog: config.updateLog,
    },
    {headers: {"cache-control": "no-store"}},
  );
};

export const HEAD = GET;
