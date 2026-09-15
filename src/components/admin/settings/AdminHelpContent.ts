import type {AdminHelpContent} from "@/components/admin/shared/AdminHelpLabel";
import i18n from "@/client/i18n";

export const SETTINGS_CONTROLS = {
  SUBSCRIBE_METHODS: 'subscribe_methods',
  ITEMS_SORT_ORDER: 'items_sort_order',
} as const;

export const CONTROLS_TEXTS_DICT = {
  [SETTINGS_CONTROLS.SUBSCRIBE_METHODS]: {
    linkName: i18n.t("settings.controlSubscribeMethodsLinkName"),
    modalTitle: i18n.t("settings.controlSubscribeMethodsModalTitle"),
    text: i18n.t("settings.controlSubscribeMethodsText"),
    rss: null,
    json: '{ "_microfeed": { "subscribe_methods": [{"name": "RSS", "type": "rss", "url": "https://www.microfeed.org/rss/"}] } }',
  },
  [SETTINGS_CONTROLS.ITEMS_SORT_ORDER]: {
    linkName: i18n.t("settings.controlSortByLinkName"),
    modalTitle: i18n.t("settings.controlItemsSortingModalTitle"),
    text: i18n.t("settings.controlItemsSortOrderText"),
    rss: null,
    json: '{ "_microfeed": { "items_sort": "published_at", "items_order": "desc" } }',
  },
} satisfies Record<
  typeof SETTINGS_CONTROLS[keyof typeof SETTINGS_CONTROLS],
  AdminHelpContent
>;
