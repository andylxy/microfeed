import {
  ADMIN_LANGUAGE_COOKIE,
  ADMIN_LANGUAGE_STORAGE_KEY,
  type AdminLanguage,
  parseAdminLanguage,
} from "@/shared/AdminLanguage";

export const ADMIN_LANGUAGE_CHANGE_EVENT = "microfeed:admin-language-change";

export function currentAdminLanguage(): AdminLanguage {
  try {
    return parseAdminLanguage(
      window.localStorage.getItem(ADMIN_LANGUAGE_STORAGE_KEY),
    );
  } catch {
    return "en";
  }
}

function writeLanguageCookie(language: AdminLanguage): void {
  try {
    document.cookie = `${ADMIN_LANGUAGE_COOKIE}=${language}; path=/; max-age=31536000; samesite=lax`;
  } catch {
    // Cookies may be unavailable; localStorage still carries the preference.
  }
}

export function setAdminLanguage(language: AdminLanguage): void {
  try {
    window.localStorage.setItem(ADMIN_LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Storage may be unavailable; fall through to the cookie only.
  }
  writeLanguageCookie(language);
  window.dispatchEvent(
    new CustomEvent<AdminLanguage>(ADMIN_LANGUAGE_CHANGE_EVENT, {
      detail: language,
    }),
  );
}

export function applyAdminLanguage(language: AdminLanguage): void {
  document.documentElement.lang = language;
  writeLanguageCookie(language);
}
