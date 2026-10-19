// `nameKey`, not `name`: this module is imported by server code, so it must stay
// free of `@/client/*` imports. The sidebar resolves the key through i18next.
export const ADMIN_SETTINGS_SECTIONS = [
  {
    icon: "code",
    id: "custom-code",
    nameKey: "settings.websiteAppearance",
  },
  {
    icon: "activity",
    id: "tracking-urls",
    nameKey: "settings.trackingUrls",
  },
  {
    icon: "shield",
    id: "access-control",
    nameKey: "settings.accessControl",
  },
  {
    icon: "list-checks",
    id: "content-review",
    nameKey: "settings.contentReview",
  },
  {
    icon: "cloud",
    id: "cloudflare-token",
    nameKey: "settings.cloudflareToken",
  },
  {
    icon: "rss",
    id: "subscribe-methods",
    nameKey: "settings.subscribeMethods",
  },
  {
    icon: "storage",
    id: "media-file-storage",
    nameKey: "settings.mediaFileStorage",
  },
  {
    icon: "list",
    id: "items-settings",
    nameKey: "settings.itemsSettings",
  },
  {
    icon: "eye",
    id: "item-editor-sections",
    nameKey: "settings.itemEditorSections",
  },
  {
    icon: "image",
    id: "favicon",
    nameKey: "settings.favicon",
  },
  {
    icon: "globe",
    id: "site",
    nameKey: "settings.site",
  },
] as const;

export type AdminSettingsSection = typeof ADMIN_SETTINGS_SECTIONS[number];

/**
 * `label` resolves a section to its displayed name, so the search matches what
 * the user actually sees rather than the i18n key.
 */
export function filterAdminSettingsSections(
  query: string,
  label: (section: AdminSettingsSection) => string,
): readonly AdminSettingsSection[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return ADMIN_SETTINGS_SECTIONS;
  }

  return ADMIN_SETTINGS_SECTIONS.filter((section) =>
    label(section).toLocaleLowerCase().includes(normalizedQuery)
  );
}

/** 从 `#hash`（可带或不带 `#`）解析设置分区；未命中返回 null。 */
export function settingsSectionFromHash(
  hash: string,
): AdminSettingsSection["id"] | null {
  const id = hash.replace(/^#/u, "");
  return ADMIN_SETTINGS_SECTIONS.find((section) => section.id === id)?.id ?? null;
}
