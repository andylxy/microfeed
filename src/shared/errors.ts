// Relative import (not the "@/shared/i18n" alias): this module is pulled into
// the theme-kit CLI, which runs through tsx without the app's path aliases.
import {translate} from "./i18n";

/**
 * Domain error that carries an i18n key instead of a user-facing message.
 *
 * Service and shared layers throw `AppError` with the translation key for the
 * message the admin UI should show. AJAX/API handlers catch it and call
 * `appErrorResponse` (or `localizedError`) to render the message in the
 * request's Accept-Language. Keeping the key on the error (rather than a
 * pre-translated string) means the same thrown error localizes correctly for
 * any viewer.
 *
 * `message` is rendered with the default (English) language so that catch
 * blocks which have not yet been converted to `appErrorResponse` keep showing
 * the original text instead of leaking the raw translation key.
 */
export class AppError extends Error {
  readonly i18nKey: string;
  readonly status: number;
  readonly params?: Record<string, string>;

  constructor(
    i18nKey: string,
    status = 400,
    params?: Record<string, string>,
  ) {
    super(translate(i18nKey, undefined, params));
    this.name = "AppError";
    this.i18nKey = i18nKey;
    this.status = status;
    this.params = params;
  }
}
