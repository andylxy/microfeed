import type {AdminHelpContent} from "@/components/admin/shared/AdminHelpLabel";
import i18n from "@/client/i18n";
import {getBuiltInTemplateVariables} from "@/shared/TemplateVariables";

const {current_year: currentYear} = getBuiltInTemplateVariables();

export const CHANNEL_CONTROLS = {
  TITLE: 'channel_title',
  IMAGE: 'channel_image',
  PUBLISHER: 'channel_publisher',
  WEBSITE: 'channel_website',
  CATEGORIES: 'channel_categories',
  LANGUAGE: 'channel_language',
  DESCRIPTION: 'channel_description',
  ITUNES_TYPE: 'channel_itunes_type',
  ITUNES_EMAIL: 'channel_itunes_email',
  COPYRIGHT: 'channel_copyright',
  ITUNES_TITLE: 'channel_itunes_title',
  ITUNES_EXPLICIT: 'channel_itunes_explicit',
  ITUNES_BLOCK: 'channel_itunes_block',
  ITUNES_NEW_RSS_URL: 'channel_itunes_new_rss_url',
  ITUNES_COMPLETE: 'channel_itunes_complete',
} as const;

export const CONTROLS_TEXTS_DICT = {
  [CHANNEL_CONTROLS.TITLE]: {
    linkName: i18n.t("channelHelp.titleLinkName"),
    modalTitle: i18n.t("channelHelp.titleModalTitle"),
    text: i18n.t("channelHelp.titleText"),
    rss: '<channel><title>Title Here</title></channel>',
    json: '{ "title": "Title Here" }',
  },
  [CHANNEL_CONTROLS.IMAGE]: {
    linkName: i18n.t("channelHelp.imageLinkName"),
    modalTitle: i18n.t("channelHelp.imageModalTitle"),
    text: i18n.t("channelHelp.imageText"),
    rss: '<channel><itunes:image href="https://cdn-site.com/img.jpg" /><image><url>https://cdn-site.com/img.jpg</url></image></channel>',
    json: '{ "icon": "https://cdn-site.com/img.jpg" }',
  },
  [CHANNEL_CONTROLS.PUBLISHER]: {
    linkName: i18n.t("channelHelp.publisherLinkName"),
    modalTitle: i18n.t("channelHelp.publisherModalTitle"),
    text: i18n.t("channelHelp.publisherText"),
    rss: '<channel><itunes:author>Publisher Here</itunes:author></channel>',
    json: '{ "authors": [{"name": "Publisher Here"}] }',
  },
  [CHANNEL_CONTROLS.WEBSITE]: {
    linkName: i18n.t("channelHelp.websiteLinkName"),
    modalTitle: i18n.t("channelHelp.websiteModalTitle"),
    text: i18n.t("channelHelp.websiteText"),
    rss: '<channel><link>Website Here</link></channel>',
    json: '{ "home_page_url": "Website Here" }',
  },
  [CHANNEL_CONTROLS.CATEGORIES]: {
    linkName: i18n.t("channelHelp.categoriesLinkName"),
    modalTitle: i18n.t("channelHelp.categoriesModalTitle"),
    text: i18n.t("channelHelp.categoriesText"),
    rss: '<channel><itunes:category text="Arts" /></channel>',
    json: '{ "_microfeed": {"categories": [{"name": "Arts"}]} }',
  },
  [CHANNEL_CONTROLS.LANGUAGE]: {
    linkName: i18n.t("channelHelp.languageLinkName"),
    modalTitle: i18n.t("channelHelp.languageModalTitle"),
    text: i18n.t("channelHelp.languageText"),
    rss: '<channel><language>en-us</language></channel>',
    json: '{ "language": "en-us" }',
  },
  [CHANNEL_CONTROLS.DESCRIPTION]: {
    linkName: i18n.t("channelHelp.descriptionLinkName"),
    modalTitle: i18n.t("channelHelp.descriptionModalTitle"),
    text: i18n.t("channelHelp.descriptionText"),
    rss: '<channel><description><![CDATA[ <p>some html here</p> ]]></description></channel>',
    json: '{ "description": "<p>some html here</p>" }',
  },
  [CHANNEL_CONTROLS.ITUNES_TYPE]: {
    linkName: i18n.t("channelHelp.itunesTypeLinkName"),
    modalTitle: i18n.t("channelHelp.itunesTypeModalTitle"),
    text: i18n.t("channelHelp.itunesTypeText"),
    rss: '<channel><itunes:type>episodic</itunes:type></channel>',
    json: '{ "_microfeed": {"itunes:type": "episodic"} }',
  },
  [CHANNEL_CONTROLS.ITUNES_EMAIL]: {
    linkName: i18n.t("channelHelp.itunesEmailLinkName"),
    modalTitle: i18n.t("channelHelp.itunesEmailModalTitle"),
    text: i18n.t("channelHelp.itunesEmailText"),
    rss: '<channel><itunes:owner><itunes:email>myname@mycompany.com</itunes:email></itunes:owner></channel>',
    json: '{ "_microfeed": {"itunes:email": "myname@mycompany.com"} }',
  },
  [CHANNEL_CONTROLS.COPYRIGHT]: {
    linkName: i18n.t("channelHelp.copyrightLinkName"),
    modalTitle: i18n.t("channelHelp.copyrightModalTitle"),
    text: i18n.t("channelHelp.copyrightText", {year: currentYear}),
    rss: `<channel><copyright>© ${currentYear} Publisher</copyright></channel>`,
    json: `{ "_microfeed": {"copyright": "© ${currentYear} Publisher"} }`,
  },
  [CHANNEL_CONTROLS.ITUNES_TITLE]: {
    linkName: i18n.t("channelHelp.itunesTitleLinkName"),
    modalTitle: i18n.t("channelHelp.itunesTitleModalTitle"),
    text: i18n.t("channelHelp.itunesTitleText"),
    rss: '<channel><itunes:title>a title here</itunes:title></channel>',
    json: '{ "_microfeed": {"itunes:title": "a title here"} }',
  },
  [CHANNEL_CONTROLS.ITUNES_EXPLICIT]: {
    linkName: i18n.t("channelHelp.itunesExplicitLinkName"),
    modalTitle: i18n.t("channelHelp.itunesExplicitModalTitle"),
    text: i18n.t("channelHelp.itunesExplicitText"),
    rss: '<channel><itunes:explicit>true</itunes:explicit></channel>',
    json: '{ "_microfeed": {"itunes:explicit": true} }',
  },
  [CHANNEL_CONTROLS.ITUNES_BLOCK]: {
    linkName: i18n.t("channelHelp.itunesBlockLinkName"),
    modalTitle: i18n.t("channelHelp.itunesBlockModalTitle"),
    text: i18n.t("channelHelp.itunesBlockText"),
    rss: '<channel><itunes:block>Yes</itunes:block></channel>',
    json: '{ "_microfeed": {"itunes:block": true} }',
  },
  [CHANNEL_CONTROLS.ITUNES_COMPLETE]: {
    linkName: i18n.t("channelHelp.itunesCompleteLinkName"),
    modalTitle: i18n.t("channelHelp.itunesCompleteModalTitle"),
    text: i18n.t("channelHelp.itunesCompleteText"),
    rss: '<channel><itunes:complete>Yes</itunes:complete></channel>',
    json: '{ "_microfeed": {"itunes:complete": true} }',
  },
  [CHANNEL_CONTROLS.ITUNES_NEW_RSS_URL]: {
    linkName: i18n.t("channelHelp.itunesNewRssUrlLinkName"),
    modalTitle: i18n.t("channelHelp.itunesNewRssUrlModalTitle"),
    text: i18n.t("channelHelp.itunesNewRssUrlText"),
    rss: '<channel><itunes:new-rss-url>https://a-new-rss-url.com/feed</itunes:new-rss-url></channel>',
    json: '{ "_microfeed": {"itunes:new-rss-url": "https://a-new-rss-url.com/feed"} }',
  },
} satisfies Record<
  typeof CHANNEL_CONTROLS[keyof typeof CHANNEL_CONTROLS],
  AdminHelpContent
>;
