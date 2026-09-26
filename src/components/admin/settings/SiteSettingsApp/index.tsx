import React from "react";

import AdminInput from "@/components/admin/shared/AdminInput";
import {SETTINGS_CATEGORIES} from "@/shared/Constants";
import SettingsBase from "../SettingsBase";
import i18n from "@/client/i18n";

export const SITE_TITLE_SUBMIT_KEY = "site-title";

/**
 * novel-cms 自研：站点标题。
 *
 * 控制公开站页眉 logo 的文案，值存在 `settings.webGlobalSettings.siteTitle`。
 * `FeedPublicJsonBuilder` 把它带进 `publicFeed._microfeed.siteTitle`，
 * `ThemeRenderer` 再暴露成顶层模板变量 `site_title`（缺省回退到频道标题）。
 *
 * 2026-09-26：按用户要求从「频道 > 站点」迁到这里，存储同时从
 * `channel._microfeed.siteTitle` 改到 settings —— 站点身份不再和频道绑在一起，
 * 也就不必为了改一行页眉文案去动频道数据。
 */
export default class SiteSettingsApp extends React.Component<any, any> {
  constructor(props: any) {
    super(props);
    const savedSettings = props.feed.settings?.[
      SETTINGS_CATEGORIES.WEB_GLOBAL_SETTINGS
    ] ?? {};
    const savedSiteTitle = typeof savedSettings.siteTitle === "string"
      ? savedSettings.siteTitle
      : "";
    this.state = {savedSiteTitle, siteTitle: savedSiteTitle};
  }

  async save(event: any) {
    const {siteTitle} = this.state;
    const saved = await this.props.onSubmit(
      event,
      SETTINGS_CATEGORIES.WEB_GLOBAL_SETTINGS,
      {siteTitle},
      [],
      SITE_TITLE_SUBMIT_KEY,
    );
    if (saved) {
      this.setState({savedSiteTitle: siteTitle});
    }
  }

  render() {
    const t = i18n.t.bind(i18n);
    const {siteTitle} = this.state;
    const {submitting, submitForType, setChanged} = this.props;

    return (
      <SettingsBase
        currentType={SITE_TITLE_SUBMIT_KEY}
        submitForType={submitForType}
        submitting={submitting}
        title={t("settings.site")}
        onSubmit={(event: any) => void this.save(event)}
      >
        <p className="text-xs text-helper-color">{t("settings.siteIntro")}</p>
        <div className="mt-4">
          <AdminInput
            disabled={submitting}
            label={t("settings.siteTitle")}
            placeholder={t("settings.siteTitlePlaceholder")}
            value={siteTitle}
            onChange={(event: any) => this.setState(
              {siteTitle: event.target.value},
              () => setChanged(),
            )}
          />
        </div>
      </SettingsBase>
    );
  }
}
