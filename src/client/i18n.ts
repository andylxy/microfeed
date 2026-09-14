import i18n from "i18next";
import {initReactI18next} from "react-i18next";

import {
  ADMIN_LANGUAGE_STORAGE_KEY,
  type AdminLanguage,
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

export function detectBrowserLanguage(): AdminLanguage {
  const preference = storedAdminLanguage();
  if (preference !== "en") return preference;
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
