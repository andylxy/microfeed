import React from "react";

import {showToast} from "@/client/ToastUtils";
import AdminInput from "@/components/admin/shared/AdminInput";
import {Button} from "@/components/ui/button";
import {SETTINGS_CATEGORIES} from "@/shared/Constants";
import {
  isLocalDevelopmentHostname,
  isValidPublicBucketUrl,
  normalizePublicBucketUrl,
  resolvePublicBucketUrl,
} from "@/shared/StringUtils";
import SettingsBase from "../SettingsBase";
import i18n from "@/client/i18n";

export const MEDIA_FILE_STORAGE_SUBMIT_KEY = "media-file-storage";

export default class MediaFileStorageSettingsApp extends React.Component<any, any> {
  constructor(props: any) {
    super(props);

    const savedSettings = props.feed.settings?.[
      SETTINGS_CATEGORIES.WEB_GLOBAL_SETTINGS
    ] ?? {};
    const isLocalDevelopment = isLocalDevelopmentHostname(
      window.location.hostname,
    );
    const publicBucketUrl = resolvePublicBucketUrl(
      savedSettings.publicBucketUrl || "/media/",
      window.location.hostname,
    );
    this.state = {
      isLocalDevelopment,
      publicBucketUrl,
      savedPublicBucketUrl: publicBucketUrl,
    };
  }

  render() {
    const t = i18n.t.bind(i18n);
    const {
      isLocalDevelopment,
      publicBucketUrl,
      savedPublicBucketUrl,
    } = this.state;
    const {submitting, submitForType, setChanged} = this.props;
    const changed = publicBucketUrl !== savedPublicBucketUrl;
    const submittingForThis = submitForType === MEDIA_FILE_STORAGE_SUBMIT_KEY;

    return (
      <SettingsBase
        currentType={MEDIA_FILE_STORAGE_SUBMIT_KEY}
        submitForType={submitForType}
        submitting={submitting}
        title={t("settings.mediaFileStorage")}
      >
        <AdminInput
          customClass="text-xs"
          customLabelClass="m-input-label-small"
          disabled={isLocalDevelopment}
          extraParams={{
            inputMode: "url",
            spellCheck: false,
          }}
          label={t("settings.r2PublicBucketUrl")}
          type="text"
          value={publicBucketUrl}
          onChange={(event: any) => this.setState(
            {publicBucketUrl: event.target.value},
            () => setChanged(),
          )}
        />
        <p className="mt-2 text-xs text-helper-color">
          {isLocalDevelopment
            ? t("settings.mediaLocalDev")
            : <>
              {t("settings.mediaKeepMedia")}<a
                className="underline"
                href="https://developers.cloudflare.com/r2/buckets/public-buckets/#custom-domains"
                rel="noopener noreferrer"
                target="_blank"
              >
                {t("settings.mediaCustomDomain")}
              </a>{t("settings.mediaEnterUrl")}
            </>}
        </p>
        {changed && (
          <div className="mt-5 flex justify-end">
            <Button
              disabled={submittingForThis || submitting}
              type="button"
              onClick={async (event) => {
                const normalizedPublicBucketUrl = normalizePublicBucketUrl(
                  publicBucketUrl,
                );
                if (
                  normalizedPublicBucketUrl &&
                  !isValidPublicBucketUrl(normalizedPublicBucketUrl)
                ) {
                  showToast(
                    t("settings.mediaInvalidUrl"),
                    "error",
                    5000,
                  );
                  return;
                }
                const saved = await this.props.onSubmit(
                  event,
                  SETTINGS_CATEGORIES.WEB_GLOBAL_SETTINGS,
                  {publicBucketUrl: normalizedPublicBucketUrl},
                  [],
                  MEDIA_FILE_STORAGE_SUBMIT_KEY,
                );
                if (saved) {
                  this.setState({
                    publicBucketUrl: normalizedPublicBucketUrl,
                    savedPublicBucketUrl: normalizedPublicBucketUrl,
                  });
                }
              }}
            >
              {submittingForThis ? t("settings.updating") : t("settings.update")}
            </Button>
          </div>
        )}
      </SettingsBase>
    );
  }
}
