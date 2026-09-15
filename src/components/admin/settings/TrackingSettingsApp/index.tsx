import React from 'react';
import AdminTextarea from "@/components/admin/shared/AdminTextarea";
import {Button} from "@/components/ui/button";
import {buildAudioUrlWithTracking} from "@/shared/StringUtils";
import SettingsBase from '../SettingsBase';
import {SETTINGS_CATEGORIES} from "@/shared/Constants";
import i18n from "@/client/i18n";

export default class TrackingSettingsApp extends React.Component<any, any> {
  constructor(props: any) {
    super(props);

    const currentType = SETTINGS_CATEGORIES.ANALYTICS;
    const {feed} = props;
    let trackingUrls = '';
    if (feed.settings && feed.settings[currentType]) {
      trackingUrls = feed.settings[currentType].urls || [];
      trackingUrls = (trackingUrls as any).join('\n');
    }
    this.state = {
      trackingUrls,
      savedTrackingUrls: trackingUrls,
      currentType,
    };
  }

  render() {
    const t = i18n.t.bind(i18n);
    const {trackingUrls, savedTrackingUrls, currentType} = this.state;
    const {submitting, submitForType, setChanged} = this.props;
    const urls = trackingUrls.trim() !== '' ? trackingUrls.trim().split(/\n/) : [];
    const changed = trackingUrls !== savedTrackingUrls;
    const submittingForThis = submitForType === currentType;
    const exampleAudio = 'https://example.com/audio.mp3';
    return (<SettingsBase
      title={t("settings.trackingUrls")}
      submitting={submitting}
      submitForType={submitForType}
      currentType={currentType}
    >
      <div>
        <AdminTextarea
          placeholder={t("settings.trackingPlaceholder")}
          value={trackingUrls}
          onChange={(e: any) => this.setState({trackingUrls: e.target.value}, () => setChanged())}
        />
      </div>
      <div className="mt-4 text-xs text-helper-color">
        {t("settings.trackingDescBefore")}<a href="https://op3.dev/">OP3</a>、<a
        href="http://analytics.podtrac.com/">Podtrac</a>...){t("settings.trackingDescMiddle")}<a href="https://lowerstreet.co/blog/podcast-tracking" target="_blank" rel="noopener noreferrer">{t("settings.trackingIndustryPractice")}</a>{t("settings.trackingDescEnd")}
      </div>
      {urls.length > 0 && <div className="mt-4 text-xs break-all text-helper-color">
        <div className="mb-2">
          {t("settings.trackingExample", {example: exampleAudio})}
        </div>
        <b>{buildAudioUrlWithTracking(exampleAudio, urls)}</b>
      </div>}
      {changed && <div className="mt-5 flex justify-end">
        <Button
          disabled={submittingForThis || submitting}
          type="button"
          onClick={(e: any) => {
            const submittedTrackingUrls = trackingUrls;
            void Promise.resolve(this.props.onSubmit(e, currentType, {urls}))
              .then((updated) => {
                if (updated) {
                  this.setState({savedTrackingUrls: submittedTrackingUrls});
                }
              });
          }}
        >
          {submittingForThis ? t("settings.updating") : t("settings.update")}
        </Button>
      </div>}
    </SettingsBase>);
  }
}
