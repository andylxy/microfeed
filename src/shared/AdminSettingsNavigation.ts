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
    icon: "image",
    id: "favicon",
    nameKey: "settings.favicon",
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
