import i18n from "i18next";
import {initReactI18next} from "react-i18next";

import {
  ADMIN_LANGUAGE_STORAGE_KEY,
  type AdminLanguage,
  languageFromCookieHeader,
  parseAdminLanguage,
} from "@/shared/AdminLanguage";
import {translationResources} from "@/shared/i18n";

export function storedAdminLanguage(): AdminLanguage {
  try {
    return parseAdminLanguage(
      window.localStorage.getItem(ADMIN_LANGUAGE_STORAGE_KEY),
    );
  } catch {
    return "en";
  }
}

/**
 * Mirrors the precedence used by `AdminLanguageScript.astro` and by the server
 * (`adminLanguageFromRequest`): stored preference, then the preference cookie,
 * then the language the server already rendered with. All three have to agree,
 * otherwise the first paint and the hydrated UI resolve to different languages
 * and the page flips.
 *
 * The `documentElement.lang` step is what closes the last gap: the server
 * resolves from `Accept-Language`, which is not always identical to
 * `navigator.language`. Going straight to the navigator could therefore disagree
 * with the markup that has already been painted.
 */
export function detectBrowserLanguage(): AdminLanguage {
  const preference = storedAdminLanguage();
  if (preference !== "en") return preference;
  try {
    const fromCookie = languageFromCookieHeader(document.cookie);
    if (fromCookie) return fromCookie;
  } catch {
    // No document (server render) or cookies are blocked; fall through.
  }
  try {
    const rendered = document.documentElement.lang;
    if (rendered === "zh-CN" || rendered === "en") return rendered;
  } catch {
    // No document (server render); fall through to the navigator.
  }
  return /(^|,)\s*zh(\b|[-_])/iu.test(navigator.language)
    ? "zh-CN"
    : "en";
}

void i18n.use(initReactI18next).init({
  resources: translationResources,
  lng: detectBrowserLanguage(),
  fallbackLng: "en",
  interpolation: {escapeValue: false},
  returnNull: false,
});

export default i18n;
export {useTranslation} from "react-i18next";
