import {describe, expect, it} from "vitest";

import {
  adminDateLocale,
  formatAdminDate,
  formatAdminDateTime24,
} from "@/client/admin-date-format";
import i18n from "@/client/i18n";

/**
 * Admin dates must follow the dashboard's language, not the machine's locale:
 * a Chinese admin on an English OS used to see English dates, and the same data
 * rendered differently on two machines. `tests/unit/i18n-setup.ts` pins the
 * language to English for every other component test, so these assertions stay
 * deterministic.
 */
describe("admin date formatting", () => {
  it("formats in the admin language rather than the OS locale", async () => {
    const date = new Date(2026, 7, 4, 18, 30, 0);
    await i18n.changeLanguage("en");
    const english = formatAdminDate(date, {dateStyle: "medium"});
    expect(adminDateLocale()).toBe("en");
    expect(english).toContain("2026");

    await i18n.changeLanguage("zh-CN");
    const chinese = formatAdminDate(date, {dateStyle: "medium"});
    expect(adminDateLocale()).toBe("zh-CN");
    // Same instant, different language — proving the locale is read per call.
    expect(chinese).not.toBe(english);
    await i18n.changeLanguage("en");
  });

  it("renders a 24-hour clock so audit rows line up", () => {
    // 18:30 local: the whole point of the 24-hour helper is that this reads
    // "18:30" and never "6:30 PM" / "下午6:30".
    const evening = new Date(2026, 8, 20, 18, 30, 0);
    const formatted = formatAdminDateTime24(evening);
    expect(formatted).toContain("18:30");
    expect(formatted).not.toMatch(/PM|AM/u);
  });

  it("returns an empty string for an unparseable date", () => {
    expect(formatAdminDate("not a date")).toBe("");
    expect(formatAdminDate(Number.NaN)).toBe("");
  });
});
