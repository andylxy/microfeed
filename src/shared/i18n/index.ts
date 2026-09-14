import {
  ADMIN_LANGUAGES,
  type AdminLanguage,
} from "../AdminLanguage";
import {en, type TranslationKey} from "./en";
import {zhCN} from "./zh-CN";

export type {TranslationKey} from "./en";

export const translationResources: Record<AdminLanguage, {translation: TranslationKey}> = {
  en: {translation: en},
  "zh-CN": {translation: zhCN},
};

export const DEFAULT_ADMIN_LANGUAGE: AdminLanguage = "en";

export type TranslationLeaf = string;

type NestedRecord = {
  [key: string]: string | NestedRecord;
};

/** Flatten a nested translation object into dotted keys ("common.home"). */
export function flatten(
  value: string | NestedRecord,
  prefix = "",
  out: Record<string, string> = {},
): Record<string, string> {
  for (const [key, entry] of Object.entries(value as NestedRecord)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof entry === "string") {
      out[path] = entry;
    } else {
      flatten(entry, path, out);
    }
  }
  return out;
}

const flattened = Object.fromEntries(
  (Object.keys(translationResources) as AdminLanguage[]).map((language) => [
    language,
    flatten(translationResources[language].translation),
  ]),
) as Record<AdminLanguage, Record<string, string>>;

/** Replace `{{name}}` placeholders in a template string. */
export function interpolate(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return template;
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/gu, (match, name: string) =>
    params[name] !== undefined ? String(params[name]) : match,
  );
}

/**
 * Server-side / runtime-neutral translation lookup used by Astro pages and
 * non-React code. React components should use the i18next hooks instead.
 */
export function translate(
  key: string,
  language: AdminLanguage = DEFAULT_ADMIN_LANGUAGE,
  params?: Record<string, string | number>,
): string {
  const table = flattened[language] ?? flattened[DEFAULT_ADMIN_LANGUAGE];
  const template = table[key] ?? flattened[DEFAULT_ADMIN_LANGUAGE][key] ?? key;
  return interpolate(template, params);
}

export {ADMIN_LANGUAGES};
