import React from 'react';
import {ArrowRightIcon} from "lucide-react";

import {Button} from "@/components/ui/button";
import {ADMIN_URLS} from "@/shared/StringUtils";
import SettingsBase from '../SettingsBase';
import {SETTINGS_CATEGORIES} from "@/shared/Constants";
import i18n from "@/client/i18n";

function NavBlock({url, text}: {url: string; text: string}) {
  return (
    <Button
      className="h-auto min-h-14 w-full justify-between whitespace-normal px-5 py-4 text-left text-base"
      render={<a href={url} />}
      size="lg"
      variant="outline"
    >
      <span>{text}</span>
      <ArrowRightIcon aria-hidden="true" className="size-5" />
    </Button>
  );
}

export default class CustomCodeSettingsApp extends React.Component<any, any> {
  constructor(props: any) {
    super(props);
    this.state = {
      currentType: SETTINGS_CATEGORIES.CUSTOM_CODE,
    }
  }

  render() {
    const t = i18n.t.bind(i18n);
    const {submitting, submitForType} = this.props;
    const {currentType} = this.state;
    return (<SettingsBase
      title={t("settings.websiteAppearance")}
      submitting={submitting}
      submitForType={submitForType}
      currentType={currentType}
    >
      <div className="grid gap-6">
        <div>
          <NavBlock
            url={ADMIN_URLS.codeEditorSettings()}
            text={t("settings.editSharedHtml")}
          />
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {t("settings.editSharedHtmlDescription")}
          </p>
        </div>

        <div>
          <NavBlock
            url={ADMIN_URLS.themesSettings()}
            text={t("settings.manageThemesLink")}
          />
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {t("settings.manageThemesDescription")}
          </p>
        </div>
      </div>
    </SettingsBase>);
  }
}
