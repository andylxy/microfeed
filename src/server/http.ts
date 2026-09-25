import {
  adminLanguageFromRequest,
  languageFromAcceptLanguage,
} from "@/shared/AdminLanguage";
import {translate} from "@/shared/i18n";
import {AppError} from "@/shared/errors";

export function jsonResponse(
  data: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json;charset=UTF-8");
  }
  return new Response(JSON.stringify(data), {...init, headers});
}

/**
 * Localized JSON error response for admin AJAX endpoints. Resolves the admin
 * language from the request (explicit preference cookie first, then
 * Accept-Language — same mechanism the Astro admin pages use) and translates
 * the given key.
 */
export function localizedError(
  request: Request,
  key: string,
  status = 400,
  params?: Record<string, string>,
  init: ResponseInit = {},
): Response {
  const language = adminLanguageFromRequest(request);
  return jsonResponse(
    {error: translate(key, language, params)},
    {...init, status},
  );
}

/**
 * Localized JSON error response for PUBLIC, unauthenticated endpoints (e.g.
 * `/report`). Readers are anonymous and have no admin language cookie, so the
 * language follows `Accept-Language` only - the explicit-preference cookie that
 * `localizedError` consults would be wrong (or absent) here and would silently
 * fall back to English for a Chinese reader.
 */
export function publicLocalizedError(
  request: Request,
  key: string,
  status = 400,
  params?: Record<string, string>,
  init: ResponseInit = {},
): Response {
  const language = languageFromAcceptLanguage(
    request.headers.get("accept-language"),
  );
  return jsonResponse(
    {error: translate(key, language, params)},
    {...init, status},
  );
}

/**
 * Renders an {@link AppError} as a localized JSON error response. Use this in
 * AJAX/API catch blocks before falling back to a generic 500 so domain errors
 * keep their translated message instead of leaking the i18n key.
 */
export function appErrorResponse(request: Request, error: AppError): Response {
  return localizedError(request, error.i18nKey, error.status, error.params);
}

/**
 * Render a service-layer error at a caller-decided status. Domain errors
 * ({@link AppError}) contribute their own message; anything else falls back to
 * its message so no i18n key ever reaches the client.
 */
export function localizedServiceError(
  error: unknown,
  status: number,
  request?: Request,
): Response {
  if (error instanceof AppError && request) {
    return localizedError(request, error.i18nKey, status, error.params);
  }
  return jsonResponse({
    error: error instanceof Error ? error.message : String(error),
  }, {status});
}

/**
 * Catch an AppError-like error thrown by an admin handler and turn it into a
 * localized service error response. Returns `undefined` for errors that are
 * not `Error` instances carrying an `i18nKey`, so the caller may re-throw them
 * to the framework's default error handling. Shared by the category ajax
 * routes to avoid the same few lines being copied into each file.
 */
export function serviceError(
  error: unknown,
  fallbackStatus = 400,
): Response | undefined {
  if (error instanceof Error && "i18nKey" in error) {
    return localizedServiceError(
      error,
      (error as {status?: number}).status ?? fallbackStatus,
    );
  }
  return undefined;
}

/**
 * Plain-text counterpart of {@link localizedError}: same language lookup, but
 * the body is the translated string rather than a JSON object.
 * Use it wherever the original response was a plain-text `new Response(...)`
 * so localizing the message does not change the response format.
 */
export function localizedTextError(
  request: Request,
  key: string,
  status = 400,
  params?: Record<string, string>,
  init: ResponseInit = {},
): Response {
  return new Response(
    translate(
      key,
      adminLanguageFromRequest(request),
      params,
    ),
    {...init, status},
  );
}

/**
 * Plain-text counterpart of {@link publicLocalizedError}: same Accept-Language
 * lookup, plain-text body. Use it on public routes whose original response was
 * a plain-text `new Response(...)` so localizing does not change the format.
 */
export function publicLocalizedTextError(
  request: Request,
  key: string,
  status = 400,
  params?: Record<string, string>,
  init: ResponseInit = {},
): Response {
  return new Response(
    translate(
      key,
      languageFromAcceptLanguage(request.headers.get("accept-language")),
      params,
    ),
    {...init, status},
  );
}

/**
 * Localized plain-text 404 response for public routes. The body is translated
 * with the request's language; the status and reason phrase stay the
 * conventional `404` / `Not Found` so clients are unaffected.
 */
export function notFoundResponse(
  request?: Request,
  init: ResponseInit = {},
): Response {
  // B7: this helper serves PUBLIC routes, so the body must follow Accept-Language
  // rather than the admin language cookie (which anonymous readers don't have).
  return new Response(
    translate(
      "errors.general.notFound",
      languageFromAcceptLanguage(request?.headers.get("accept-language") ?? null),
    ),
    {...init, status: 404},
  );
}
