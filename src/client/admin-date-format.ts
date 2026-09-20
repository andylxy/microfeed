import i18n from "@/client/i18n";

/**
 * Admin UI dates follow the *admin language* rather than the visitor's OS
 * locale. Switching languages reloads the page, so reading the language at call
 * time is stable and keeps dates in step with the surrounding copy. Without
 * this, a Chinese admin on an English machine saw English dates (and vice
 * versa), and the rendered output depended on the OS rather than the setting.
 *
 * Public-site formatting is deliberately NOT routed through here: the public
 * feed follows the visitor's browser locale.
 */
export function adminDateLocale(): string {
  return i18n.language || "en";
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = adminDateLocale();
  const key = `${locale}|${JSON.stringify(options)}`;
  let cached = formatters.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat(locale, options);
    formatters.set(key, cached);
  }
  return cached;
}

/** Format a date in the admin language. Returns "" for an invalid date. */
export function formatAdminDate(
  value: Date | number | string,
  options: Intl.DateTimeFormatOptions = {},
): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? formatter(options).format(date) : "";
}

/** Short date, e.g. "Aug 4, 2026" / "2026年8月4日". */
export function formatAdminShortDate(value: Date | number | string): string {
  return formatAdminDate(value, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Medium date with a long time, used for tooltips and detail rows. */
export function formatAdminTimestamp(
  value: Date | number | string,
  timeStyle: "short" | "long" = "short",
): string {
  return formatAdminDate(value, {dateStyle: "medium", timeStyle});
}

/**
 * 24-hour timestamp. Use where the exact time is the point — an audit trail
 * row, for instance, where "6:29 PM" forces the reader to convert before they
 * can line it up with another row. Still formatted in the admin language.
 */
export function formatAdminDateTime24(value: Date | number | string): string {
  return formatAdminDate(value, {
    dateStyle: "medium",
    timeStyle: "medium",
    hour12: false,
  });
}
