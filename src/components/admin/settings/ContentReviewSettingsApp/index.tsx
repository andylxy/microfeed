import React from 'react';
import AdminRadioGroup from "@/components/admin/shared/AdminRadioGroup";
import SettingsBase from '../SettingsBase';
import {SETTINGS_CATEGORIES} from "@/shared/Constants";
import i18n from "@/client/i18n";

/**
 * The content-review switch.
 *
 * ON: every dashboard save opens a pending version; the change reaches the
 * live site only after someone approves it in the review queue.
 * OFF: a save takes effect immediately, and switching from ON to OFF rejects
 * every still-pending version server-side (their content never went live).
 */
export default class ContentReviewSettingsApp extends React.Component<any, any> {
  constructor(props: any) {
    super(props);

    this.onUpdateEnabled = this.onUpdateEnabled.bind(this);

    const currentType = SETTINGS_CATEGORIES.CONTENT_REVIEW;
    const {feed} = props;
    // Default OFF: a save is live the moment it succeeds. Review is opt-in.
    let contentReview = {enabled: false};
    if (feed.settings && feed.settings[currentType]) {
      contentReview = feed.settings[currentType];
    }
    this.state = {
      contentReview,
      currentType,
    };
  }

  onUpdateEnabled(enabled: boolean) {
    const contentReview = {...this.state.contentReview, enabled};
    this.setState({contentReview}, () => {
      this.props.setChanged();
      void this.props.onSubmit(
        {preventDefault() {}},
        this.state.currentType,
        contentReview,
      );
    });
  }

  render() {
    const t = i18n.t.bind(i18n);
    const {currentType, contentReview} = this.state;
    const {submitting} = this.props;
    return (<SettingsBase
      description={t("settings.contentReviewDescription")}
      title={t("settings.contentReview")}
      currentType={currentType}
    >
      <AdminRadioGroup
        alignment="start"
        ariaLabel={t("settings.contentReview")}
        disabled={submitting}
        name="content-review-enabled"
        value={contentReview.enabled === true ? "on" : "off"}
        onValueChange={(value: string) => this.onUpdateEnabled(value === "on")}
        variant="cards"
        options={[
          {
            value: "off",
            label: t("settings.contentReviewOff"),
            description: t("settings.contentReviewOffDescription"),
          },
          {
            value: "on",
            label: t("settings.contentReviewOn"),
            description: t("settings.contentReviewOnDescription"),
          },
        ]}
      />
    </SettingsBase>);
  }
}
