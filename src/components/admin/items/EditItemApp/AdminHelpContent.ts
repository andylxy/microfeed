import type {AdminHelpContent} from "@/components/admin/shared/AdminHelpLabel";
import i18n from "@/client/i18n";
import {ADMIN_URLS} from "@/shared/StringUtils";

export const ITEM_CONTROLS = {
  TITLE: 'item_title',
  IMAGE: 'item_image',
  MEDIA_FILE: 'item_media_file',
  PUB_DATE: 'item_pub_date',
  LINK: 'item_link',
  DESCRIPTION: 'item_description',
  GUID: 'item_guid',
  ITUNES_EXPLICIT: 'item_itunes_explicit',
  ITUNES_TITLE: 'item_itunes_title',
  ITUNES_EPISODE_TYPE: 'item_itunes_episode_type',
  ITUNES_SEASON: 'item_itunes_season',
  ITUNES_EPISODE: 'item_itunes_episode',
  ITUNES_BLOCK: 'item_itunes_block',
  STATUS: 'item_status',
} as const;

// Mirrors the key order of ITEM_STATUSES_DICT (ascending status value).
const ITEM_STATUS_HELP_ENTRIES: Array<{
  labelKey: string;
  descKey: string;
}> = [
  {labelKey: "items.statusPublished", descKey: "items.statusPublishedDesc"},
  {labelKey: "items.statusUnpublished", descKey: "items.statusUnpublishedDesc"},
  {labelKey: "items.statusUnlisted", descKey: "items.statusUnlistedDesc"},
];

const itemStatusItemsHtml = ITEM_STATUS_HELP_ENTRIES
  .map(({labelKey, descKey}) =>
    `<li>${i18n.t(labelKey)}: ${
      i18n.t(descKey, {url: ADMIN_URLS.allItems()})
    }</li>`)
  .join('');

export const CONTROLS_TEXTS_DICT = {
  [ITEM_CONTROLS.TITLE]: {
    linkName: i18n.t("itemsHelp.titleLinkName"),
    modalTitle: i18n.t("itemsHelp.titleModalTitle"),
    text: i18n.t("itemsHelp.titleText"),
    rss: '<channel><item><title>Title Here</title></item></channel>',
    json: '{ "items": [{"title": "Title Here"}] }',
  },
  [ITEM_CONTROLS.IMAGE]: {
    linkName: i18n.t("itemsHelp.imageLinkName"),
    modalTitle: i18n.t("itemsHelp.imageModalTitle"),
    text: i18n.t("itemsHelp.imageText"),
    rss: '<channel><item><itunes:image href="https://cdn-site.com/img.jpg" /></item></channel>',
    json: '{ "items": [{"image": "https://cdn-site.com/img.jpg"}] }',
  },
  [ITEM_CONTROLS.MEDIA_FILE]: {
    linkName: i18n.t("itemsHelp.mediaFileLinkName"),
    modalTitle: i18n.t("itemsHelp.mediaFileModalTitle"),
    text: i18n.t("itemsHelp.mediaFileText", {settingsUrl: ADMIN_URLS.settings()}),
    rss: '<channel><item><enclosure url="https://cdn-site.com/audio.mp3" type="audio/mpeg" length="277000"/><itunes:duration>00:21:02</itunes:duration></item></channel>',
    json: '{ "items": [{"attachments": [{"url": "https://cdn-site.com/audio.mp3", "mime_type": "audio/mpeg", "size_in_bytes": 277000, "duration_in_seconds": 1262 }], "_microfeed": {"duration_hhmmss": "00:21:02"}}] }',
  },

  [ITEM_CONTROLS.PUB_DATE]: {
    linkName: i18n.t("itemsHelp.pubDateLinkName"),
    modalTitle: i18n.t("itemsHelp.pubDateModalTitle"),
    text: i18n.t("itemsHelp.pubDateText"),
    rss: '<channel><item><pubDate>Wed, 30 Nov 2022 04:31:48 GMT</pubDate></item></channel>',
    json: '{ "items": [{"date_published": "2022-11-30T04:31:31.867Z", "_microfeed": {"date_published_ms": 1669782691867, "date_published_short": "Tue Nov 29 2022"}}] }',
  },
  [ITEM_CONTROLS.LINK]: {
    linkName: i18n.t("itemsHelp.linkLinkName"),
    modalTitle: i18n.t("itemsHelp.linkModalTitle"),
    text: i18n.t("itemsHelp.linkText"),
    rss: '<channel><item><link>https://example.com/page1.html</link></item></channel>',
    json: '{ "items": [{"url": "https://example.com/page1.html"}] }',
  },
  [ITEM_CONTROLS.DESCRIPTION]: {
    linkName: i18n.t("itemsHelp.descriptionLinkName"),
    modalTitle: i18n.t("itemsHelp.descriptionModalTitle"),
    text: i18n.t("itemsHelp.descriptionText"),
    rss: '<channel><item><description><![CDATA[<p>some text here<br></p>]]></description></item></channel>',
    json: '{ "items": [{"content_html": "<p>some text here<br></p>", "content_text": "some text here"}] }',
  },
  [ITEM_CONTROLS.GUID]: {
    linkName: i18n.t("itemsHelp.guidLinkName"),
    modalTitle: i18n.t("itemsHelp.guidModalTitle"),
    text: i18n.t("itemsHelp.guidText"),
    rss: '<channel><item><guid>z9H7LSkykS1</guid></item></channel>',
    json: '{ "items": [{"_microfeed": {"guid": "z9H7LSkykS1"}}] }',
  },
  [ITEM_CONTROLS.ITUNES_EXPLICIT]: {
    linkName: i18n.t("itemsHelp.itunesExplicitLinkName"),
    modalTitle: i18n.t("itemsHelp.itunesExplicitModalTitle"),
    text: i18n.t("itemsHelp.itunesExplicitText"),
    rss: '<channel><item><itunes:explicit>false</itunes:explicit></item></channel>',
    json: '{ "items": [{"_microfeed": {"itunes:explicit": true}}] }',
  },
  [ITEM_CONTROLS.ITUNES_TITLE]: {
    linkName: i18n.t("itemsHelp.itunesTitleLinkName"),
    modalTitle: i18n.t("itemsHelp.itunesTitleModalTitle"),
    text: i18n.t("itemsHelp.itunesTitleText"),
    rss: '<channel><item><itunes:title>Title Here</itunes:title></item></channel>',
    json: '{ "items": [{"_microfeed": {"itunes:title": "Title Here"}}] }',
  },
  [ITEM_CONTROLS.ITUNES_EPISODE_TYPE]: {
    linkName: i18n.t("itemsHelp.itunesEpisodeTypeLinkName"),
    modalTitle: i18n.t("itemsHelp.itunesEpisodeTypeModalTitle"),
    text: i18n.t("itemsHelp.itunesEpisodeTypeText"),
    rss: '<channel><item><itunes:episodeType>full</itunes:episodeType></item></channel>',
    json: '{ "items": [{"_microfeed": {"itunes:episodeType": "full"}}] }',
  },
  [ITEM_CONTROLS.ITUNES_SEASON]: {
    linkName: i18n.t("itemsHelp.itunesSeasonLinkName"),
    modalTitle: i18n.t("itemsHelp.itunesSeasonModalTitle"),
    text: i18n.t("itemsHelp.itunesSeasonText"),
    rss: '<channel><item><itunes:season>2</itunes:season></item></channel>',
    json: '{ "items": [{"_microfeed": {"itunes:season": 2}}] }',
  },
  [ITEM_CONTROLS.ITUNES_EPISODE]: {
    linkName: i18n.t("itemsHelp.itunesEpisodeLinkName"),
    modalTitle: i18n.t("itemsHelp.itunesEpisodeModalTitle"),
    text: i18n.t("itemsHelp.itunesEpisodeText"),
    rss: '<channel><item><itunes:episode>3</itunes:episode></item></channel>',
    json: '{ "items": [{"_microfeed": {"itunes:episode": 3}}] }',
  },
  [ITEM_CONTROLS.ITUNES_BLOCK]: {
    linkName: i18n.t("itemsHelp.itunesBlockLinkName"),
    modalTitle: i18n.t("itemsHelp.itunesBlockModalTitle"),
    text: i18n.t("itemsHelp.itunesBlockText"),
    rss: '<channel><item><itunes:block>Yes</itunes:block></item></channel>',
    json: '{ "items": [{"_microfeed": {"itunes:block": true}}] }',
  },
  [ITEM_CONTROLS.STATUS]: {
    linkName: i18n.t("itemsHelp.statusLinkName"),
    modalTitle: i18n.t("itemsHelp.statusModalTitle"),
    text: i18n.t("itemsHelp.statusText", {items: itemStatusItemsHtml}),
  },
} satisfies Record<
  typeof ITEM_CONTROLS[keyof typeof ITEM_CONTROLS],
  AdminHelpContent
>;
