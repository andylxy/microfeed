import {describe, expect, it} from "vitest";

import {formatAdminDateTime} from "@/client/admin-date-format";

/**
 * Admin dates use one fixed numeric format (站点要求, 2026-10-14): the dashboard
 * must render the same string regardless of language or OS locale, so audit and
 * log rows line up. The vitest env pins `TZ=UTC`, so local time == UTC here, and
 * these assertions stay deterministic.
 */
describe("admin date formatting", () => {
  it("formats a timestamp as YYYY-MM-DD HH:mm:ss", () => {
    expect(formatAdminDateTime(new Date(2026, 7, 4, 18, 30, 42))).toBe(
      "2026-08-04 18:30:42",
    );
  });

  it("zero-pads every field and uses a 24-hour clock", () => {
    // 03:05:07, never "3:05:07" and never "3:05:07 AM".
    expect(formatAdminDateTime(new Date(2026, 0, 9, 3, 5, 7))).toBe(
      "2026-01-09 03:05:07",
    );
  });

  it("returns an empty string for an unparseable value", () => {
    expect(formatAdminDateTime("not a date")).toBe("");
    expect(formatAdminDateTime(Number.NaN)).toBe("");
  });
});
