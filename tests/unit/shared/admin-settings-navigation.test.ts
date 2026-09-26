import {describe, expect, it} from "vitest";

import i18n from "@/client/i18n";
import {
  ADMIN_SETTINGS_SECTIONS,
  filterAdminSettingsSections,
} from "@/shared/AdminSettingsNavigation";

// The sidebar searches on the rendered label, so the test resolves it the same
// way the component does.
const label = (section: (typeof ADMIN_SETTINGS_SECTIONS)[number]): string =>
  i18n.t(section.nameKey);

describe("admin settings navigation", () => {
  it("keeps section links in page order with their label keys and distinct icons", () => {
    expect(
      ADMIN_SETTINGS_SECTIONS.map(({id, nameKey, icon}) => [id, nameKey, icon]),
    ).toEqual([
      ["custom-code", "settings.websiteAppearance", "code"],
      ["tracking-urls", "settings.trackingUrls", "activity"],
      ["access-control", "settings.accessControl", "shield"],
      ["content-review", "settings.contentReview", "list-checks"],
      ["subscribe-methods", "settings.subscribeMethods", "rss"],
      ["media-file-storage", "settings.mediaFileStorage", "storage"],
      ["items-settings", "settings.itemsSettings", "list"],
      ["favicon", "settings.favicon", "image"],
      ["site", "settings.site", "globe"],
    ]);
  });

  it("resolves every section label key to real copy", () => {
    for (const section of ADMIN_SETTINGS_SECTIONS) {
      expect(i18n.t(section.nameKey)).not.toBe(section.nameKey);
    }
  });

  it("filters sections case-insensitively and restores all on an empty query", () => {
    expect(filterAdminSettingsSections("SUBSCRIBE", label).map(({id}) => id)).toEqual([
      "subscribe-methods",
    ]);
    expect(filterAdminSettingsSections("STORAGE", label).map(({id}) => id)).toEqual([
      "media-file-storage",
    ]);
    expect(filterAdminSettingsSections("APPEARANCE", label).map(({id}) => id)).toEqual([
      "custom-code",
    ]);
    expect(filterAdminSettingsSections("  ", label)).toBe(ADMIN_SETTINGS_SECTIONS);
  });
});
