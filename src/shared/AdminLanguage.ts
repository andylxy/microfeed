export const ADMIN_LANGUAGE_STORAGE_KEY = "microfeed-admin-language";
export const ADMIN_LANGUAGE_COOKIE = "microfeed-admin-language";

export const ADMIN_LANGUAGES = ["en", "zh-CN"] as const;

export type AdminLanguage = (typeof ADMIN_LANGUAGES)[number];
export type AdminLanguageCode = "en" | "zh-CN";

export const ADMIN_LANGUAGE_TAGS: Record<AdminLanguage, string> = {
  "en": "English",
  "zh-CN": "中文",
};

export function parseAdminLanguage(value: string | null): AdminLanguage {
  return ADMIN_LANGUAGES.includes(value as AdminLanguage)
    ? value as AdminLanguage
    : "en";
}

/** Resolve the user's preferred UI language from an Accept-Language header. */
export function languageFromAcceptLanguage(value: string | null): AdminLanguage {
  if (!value) return "en";
  return /(^|,)\s*zh(\b|[-_])/i.test(value) ? "zh-CN" : "en";
}

/**
 * Read the explicit language preference out of a raw `cookie` header value.
 * Returns null when the cookie is absent or holds an unknown language, so callers
 * can tell "never chosen" apart from "explicitly chose English".
 */
export function languageFromCookieHeader(value: string | null): AdminLanguage | null {
  if (!value) return null;
  for (const part of value.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== ADMIN_LANGUAGE_COOKIE) continue;
    const stored = part.slice(separator + 1).trim();
    return ADMIN_LANGUAGES.includes(stored as AdminLanguage)
      ? stored as AdminLanguage
      : null;
  }
  return null;
}

/**
 * Resolve the admin UI language for a request.
 *
 * The explicit preference cookie wins over `accept-language`. The language switcher
 * writes both (see `@/client/admin-language`), and the server has to agree with the
 * client: resolving only from `accept-language` made the first paint render in the
 * wrong language, which showed up as an English-to-Chinese flip after hydration.
 */
export function adminLanguageFromRequest(
  request?: Request | null,
): AdminLanguage {
  return languageFromCookieHeader(request?.headers.get("cookie") ?? null)
    ?? languageFromAcceptLanguage(request?.headers.get("accept-language") ?? null);
}
