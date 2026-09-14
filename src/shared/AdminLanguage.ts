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
