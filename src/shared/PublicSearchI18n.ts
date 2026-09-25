import {translate} from "./i18n";
import type {PublicSearchStrings} from "./PublicSearch";

/** Resolve the public-search dialog strings in the site/admin language (B23).
 * Kept out of `PublicSearch.ts` itself so the runtime-neutral template module
 * (which theme-kit imports directly) does not pull the i18n catalog into its
 * bundle; only server callers that render the dialog for a request use this. */
export function publicSearchStrings(
  language: Parameters<typeof translate>[1],
): PublicSearchStrings {
  return {
    button: translate("publicSearch.button", language),
    closeSearch: translate("publicSearch.closeSearch", language),
    noResults: translate("publicSearch.noResults", language),
    placeholder: translate("publicSearch.placeholder", language),
    previewWarning: translate("publicSearch.previewWarning", language),
    searching: translate("publicSearch.searching", language),
    startTyping: translate("publicSearch.startTyping", language),
    title: translate("publicSearch.title", language),
    typeMore: translate("publicSearch.typeMore", language),
    unavailable: translate("publicSearch.unavailable", language),
  };
}
