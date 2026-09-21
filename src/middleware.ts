import {cache, env} from "cloudflare:workers";
import {defineMiddleware} from "astro:middleware";

import {builtInAdminAuthEnabled} from "@/shared/AdminAuth";
import {
  adminBasePath,
  adminUrl,
  isAdminPathname,
  normalizeAdminPath,
} from "@/shared/AdminPath";
import {STATUSES} from "@/shared/Constants";
import {
  adminLanguageFromRequest,
  languageFromAcceptLanguage,
} from "@/shared/AdminLanguage";
import {translate} from "@/shared/i18n";
import {apiWebhookContextHeadersSchema} from "@/shared/ApiSchemas";
import {itemQueryForStatusFilter} from "@/shared/ItemList";
import {ITEM_ORDERS, ITEM_SORTS} from "@/shared/ItemPagination";
import {
  canonicalPathname,
  resolvePublicBucketUrl,
} from "@/shared/StringUtils";
import {
  isAdminCollectionListPath,
  isExistingItemEditorPath,
  isPublicPageCandidateForDynamicAdminRoute,
} from "./server/admin-routes";
import {adminProtectionStatus} from "@/server/auth/admin-protection";
import {
  createMicrofeedAuth,
  withAuthSessionCookies,
} from "@/server/auth/better-auth";
import {
  adminDashboardLockedResponse,
  hasAdminOwner,
} from "@/server/auth/admin-owner";
import {isAdminPasswordSetupPath} from "@/server/auth/password-setup";
import {
  addLegacyApiDeprecationHeaders,
  decideApiRequest,
} from "@/server/api/access";
import {resolveRbacContext, RBAC_WILDCARD} from "@/server/rbac/resolve";
import {requireAppVersion} from "@/server/rbac/guard";
import {createFeedCrud, loadFeed} from "@/server/feed/feed";
import {applyWorkerCachePolicy} from "@/server/cache/public-cache";
import {publicSiteFileResponse} from "@/server/site-files/public";

const AUTH_BASE_PATH = "/api/auth";
// These two answer public `/api/*` callers, so they resolve the language from
// `accept-language` only: an API client has no admin preference cookie, and
// letting that cookie steer a public response would be a contract change.
function apiNotFoundResponse(request: Request): Response {
  return new Response(
    translate(
      "errors.general.notFound",
      languageFromAcceptLanguage(request.headers.get("accept-language")),
    ),
    {headers: {"content-type": "text/plain; charset=utf-8"}, status: 404},
  );
}

function apiUnauthorizedResponse(request: Request): Response {
  return new Response(
    translate(
      "errors.api.unauthorized",
      languageFromAcceptLanguage(request.headers.get("accept-language")),
    ),
    {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "www-authenticate": 'Bearer realm="microfeed"',
      },
      status: 401,
    },
  );
}

function apiInsufficientScopeResponse(): Response {
  return Response.json(
    {error: "insufficient_scope"},
    {
      headers: {
        "www-authenticate":
          'Bearer realm="microfeed", error="insufficient_scope"',
      },
      status: 403,
    },
  );
}

function isBetterAuthPath(pathname: string): boolean {
  return pathname === AUTH_BASE_PATH ||
    pathname.startsWith(`${AUTH_BASE_PATH}/`);
}

function rootSiteFilename(pathname: string): string | undefined {
  const match = /^\/([a-z0-9][a-z0-9._-]*\.(?:atom|css|csv|json|md|rss|txt|webmanifest|xml|ya?ml))$/u
    .exec(pathname);
  const filename = match?.[1];
  return filename && filename !== "search.json" && filename !== "favicon.ico"
    ? filename
    : undefined;
}

function isAdminAjax(pathname: string, adminPath: string): boolean {
  return pathname.startsWith(adminUrl("ajax", adminPath));
}

function isUnsafeMethod(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

function isSameOrigin(request: Request, expectedOrigin: string): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === expectedOrigin;
}

function wantsJson(request: Request, pathname: string): boolean {
  return pathname.includes("/ajax/") ||
    request.headers.get("accept")?.includes("application/json") === true;
}

const handleRequest = defineMiddleware(async (context, next) => {
  const {pathname} = context.url;
  let authSessionHeaders: Headers | undefined;
  const adminPath = normalizeAdminPath(env.MICROFEED_ADMIN_PATH);
  const builtInAuthEnabled = builtInAdminAuthEnabled(
    env.MICROFEED_ADMIN_AUTH_MODE,
  );
  const canonicalPath = isBetterAuthPath(pathname)
    ? pathname
    : canonicalPathname(pathname);
  if (canonicalPath !== pathname) {
    const canonicalUrl = new URL(context.url);
    canonicalUrl.pathname = canonicalPath;
    return Response.redirect(canonicalUrl, 308);
  }

  const siteFilename = rootSiteFilename(pathname);
  if (siteFilename) {
    return publicSiteFileResponse(env, context.request, siteFilename);
  }

  if (
    context.params.adminPath !== undefined &&
    context.params.adminPath !== adminPath &&
    !isPublicPageCandidateForDynamicAdminRoute(
      pathname,
      context.params.adminPath,
      adminPath,
    )
  ) {
    return apiNotFoundResponse(context.request);
  }

  if (isBetterAuthPath(pathname)) {
    return builtInAuthEnabled
      ? next()
      : apiNotFoundResponse(context.request);
  }

  if (pathname.startsWith("/api/")) {
    const decision = await decideApiRequest(
      env.FEED_DB,
      context.request,
      pathname,
      env.MICROFEED_ADMIN_AUTH_MODE,
    );
    if (decision === "allow-reference") {
      return addLegacyApiDeprecationHeaders(
        await next(),
        context.url,
        pathname,
      );
    }
    if (decision === "not-found") {
      return apiNotFoundResponse(context.request);
    }
    if (decision === "unauthorized") {
      return addLegacyApiDeprecationHeaders(
        apiUnauthorizedResponse(context.request),
        context.url,
        pathname,
      );
    }
    if (decision === "insufficient-scope") {
      return addLegacyApiDeprecationHeaders(
        apiInsufficientScopeResponse(),
        context.url,
        pathname,
      );
    }

    if (isUnsafeMethod(context.request.method)) {
      const automationContext = apiWebhookContextHeadersSchema.safeParse({
        "Microfeed-Causation-Id":
          context.request.headers.get("Microfeed-Causation-Id") ?? undefined,
        "Microfeed-Correlation-Id":
          context.request.headers.get("Microfeed-Correlation-Id") ?? undefined,
      });
      if (!automationContext.success) {
        return Response.json(
          {error: "Invalid microfeed automation context header."},
          {status: 400},
        );
      }
    }

    const loaded = await loadFeed(env, context.request, undefined, cache);
    const webGlobalSettings = loaded.content.settings?.webGlobalSettings ?? {};
    context.locals.feedDb = loaded.database;
    context.locals.feedContent = loaded.content;
    context.locals.feedCrud = createFeedCrud(
      loaded.content,
      loaded.database,
      context.request,
    );
    context.locals.publicBucketUrl = resolvePublicBucketUrl(
      webGlobalSettings.publicBucketUrl,
      context.url.hostname,
    );
    return addLegacyApiDeprecationHeaders(
      await next(),
      context.url,
      pathname,
    );
  } else if (isAdminPathname(pathname, adminPath)) {
    // Version gate runs first, ahead of auth and RBAC (ADR-001 D-010: the gate
    // belongs in the middleware). Web admin sends no `App-Version` header and is
    // skipped, so the browser dashboard is untouched.
    const versionGate = requireAppVersion(context.request);
    if (versionGate) {
      return versionGate;
    }
    const loginPath = adminUrl("login", adminPath);
    const passwordSetupPath = isAdminPasswordSetupPath(pathname, adminPath);
    if (!builtInAuthEnabled && passwordSetupPath) {
      return apiNotFoundResponse(context.request);
    }
    let protection = adminProtectionStatus(context.request, false);
    if (builtInAuthEnabled) {
      if (passwordSetupPath) {
        return next();
      }
      const auth = createMicrofeedAuth(env, context.request);
      const sessionResult = await auth.api.getSession({
        headers: context.request.headers,
        returnHeaders: true,
      });
      const authSession = sessionResult.response;
      authSessionHeaders = sessionResult.headers;
      if (!authSession && !await hasAdminOwner(env.FEED_DB)) {
        return withAuthSessionCookies(
          adminDashboardLockedResponse(
            !wantsJson(context.request, pathname),
            {
              instanceName: env.MICROFEED_INSTANCE_NAME,
              local: !env.MICROFEED_CLOUDFLARE_ACCOUNT_ID?.trim(),
              // `manage auth` targets production unless `--preview` is explicit,
              // so the lock screen has to say which site it is talking about.
              preview: env.DEPLOYMENT_ENVIRONMENT === "preview",
            },
            adminLanguageFromRequest(context.request),
          ),
          authSessionHeaders,
        );
      }
      if (pathname === loginPath) {
        if (authSession) {
          return withAuthSessionCookies(
            Response.redirect(
              new URL(adminBasePath(adminPath), context.url),
              302,
            ),
            authSessionHeaders,
          );
        }
        return withAuthSessionCookies(await next(), authSessionHeaders);
      }
      if (!authSession) {
        if (wantsJson(context.request, pathname)) {
          // Stays a bare 401: this path never carried content-type or
          // www-authenticate, and adding the Bearer challenge would make
          // browsers pop a native auth dialog.
          return withAuthSessionCookies(
            new Response(
              translate(
                "errors.api.unauthorized",
                languageFromAcceptLanguage(
                  context.request.headers.get("accept-language"),
                ),
              ),
              {status: 401},
            ),
            authSessionHeaders,
          );
        }
        const loginUrl = new URL(loginPath, context.url);
        loginUrl.searchParams.set(
          "redirect",
          `${context.url.pathname}${context.url.search}`,
        );
        return withAuthSessionCookies(
          Response.redirect(loginUrl, 302),
          authSessionHeaders,
        );
      }
      context.locals.authSession = authSession.session;
      context.locals.authUser = authSession.user;
      // RBAC: resolve fine-grained permissions + device + must-change flag for
      // the authenticated session (D-03 / D-09).
      {
        const rbac = await resolveRbacContext(
          env.FEED_DB,
          authSession.user.id,
          context.request,
        );
        context.locals.rbacPermissions = rbac.permissions;
        context.locals.rbacMustChangePassword = rbac.mustChangePassword;
        context.locals.rbacDeviceRevoked = rbac.deviceRevoked;
        context.locals.rbacBanned = rbac.banned;
      }
      protection = adminProtectionStatus(context.request, true);
    } else if (pathname === loginPath) {
      return Response.redirect(
        new URL(adminBasePath(adminPath), context.url),
        302,
      );
    }
    context.locals.adminProtection = protection;

    // RBAC: when authentication is disabled the admin area is fully open, so a
    // wildcard permission set keeps the guarded endpoints passing and preserves
    // the prior behavior. When auth is enabled, the session branch above has
    // already resolved the real permission set (and a 401/redirect returns
    // before we get here for unauthenticated requests).
    if (!builtInAuthEnabled) {
      context.locals.rbacPermissions = new Set([RBAC_WILDCARD]);
      context.locals.rbacMustChangePassword = false;
      context.locals.rbacDeviceRevoked = false;
      context.locals.rbacBanned = false;
    }

    if (
      isUnsafeMethod(context.request.method) &&
      !isSameOrigin(context.request, context.url.origin)
    ) {
      return new Response(
        translate(
          "errors.api.forbidden",
          adminLanguageFromRequest(context.request),
        ),
        {status: 403},
      );
    }

    if (isAdminAjax(pathname, adminPath)) {
      const response = await next();
      return authSessionHeaders
        ? withAuthSessionCookies(response, authSessionHeaders)
        : response;
    }

    // The item-edit page loads one item itself so deleted items can return a
    // precise 404 without fetching the default list first.
    const editingExistingItem = isExistingItemEditorPath(pathname, adminPath);
    if (!editingExistingItem) {
      const collectionLoadsWithAjax = isAdminCollectionListPath(
        pathname,
        adminPath,
      );
      let query;
      let itemsOrder;
      let itemsSort;
      if (
        !collectionLoadsWithAjax &&
        pathname.startsWith(adminUrl("items/list", adminPath))
      ) {
        query = itemQueryForStatusFilter(
          context.url.searchParams.get("status"),
        );
        itemsOrder = ITEM_ORDERS.DESC;
        itemsSort = ITEM_SORTS.UPDATED_AT;
      } else if (
        pathname.startsWith(adminUrl("feed/json", adminPath))
      ) {
        query = {"status__!=": STATUSES.DELETED};
      } else if (
        pathname.startsWith(adminUrl("settings/code-editor", adminPath))
      ) {
        query = {"status__!=": STATUSES.DELETED};
      }
      const loaded = await loadFeed(
        env,
        context.request,
        {
          adminProtection: protection,
          includeItems: !collectionLoadsWithAjax,
          itemsOrder,
          itemsSort,
          ...(query
            ? {
                limit: pathname.startsWith(
                  adminUrl("settings/code-editor", adminPath),
                )
                  ? 1
                  : undefined,
                queryKwargs: query,
              }
            : {}),
        },
        cache,
      );
      context.locals.feedDb = loaded.database;
      context.locals.feedContent = loaded.content;
      context.locals.onboardingResult = loaded.onboarding;
    }
  }

  const response = await next();
  return authSessionHeaders
    ? withAuthSessionCookies(response, authSessionHeaders)
    : response;
});

export const onRequest = defineMiddleware(async (context, next) => {
  const response = await handleRequest(context, next);
  if (!(response instanceof Response)) {
    throw new TypeError("microfeed middleware did not return a response");
  }
  return applyWorkerCachePolicy(context.request, response, {
    adminPath: normalizeAdminPath(env.MICROFEED_ADMIN_PATH),
    deploymentEnvironment: env.DEPLOYMENT_ENVIRONMENT,
  });
});
