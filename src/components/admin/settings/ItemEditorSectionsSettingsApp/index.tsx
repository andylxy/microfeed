import React from 'react';
import AdminRadioGroup from "@/components/admin/shared/AdminRadioGroup";
import SettingsBase from '../SettingsBase';
import {SETTINGS_CATEGORIES} from "@/shared/Constants";
import i18n from "@/client/i18n";

/**
 * Toggles for item-editor sections. Currently only `mediaPodcast`, which shows
 * or hides the media-file card (upload + external URL) and the podcast-fields
 * card on the dashboard item editor.
 *
 * ON: both cards render on the editor (new + edit).
 * OFF: both cards stay hidden; their fields keep saving and stay readable, so
 * flipping this back on restores editing without any data migration.
 */
export default class ItemEditorSectionsSettingsApp extends React.Component<any, any> {
  constructor(props: any) {
    super(props);

    this.onUpdateMediaPodcast = this.onUpdateMediaPodcast.bind(this);

    const currentType = SETTINGS_CATEGORIES.ITEM_EDITOR_SECTIONS;
    const {feed} = props;
    // Default OFF: both cards stay hidden until an operator opts in.
    let itemEditorSections = {mediaPodcast: false};
    if (feed.settings && feed.settings[currentType]) {
      itemEditorSections = feed.settings[currentType];
    }
    this.state = {
      itemEditorSections,
      currentType,
    };
  }

  onUpdateMediaPodcast(mediaPodcast: boolean) {
    const itemEditorSections = {...this.state.itemEditorSections, mediaPodcast};
    this.setState({itemEditorSections}, () => {
      this.props.setChanged();
      void this.props.onSubmit(
        {preventDefault() {}},
        this.state.currentType,
        itemEditorSections,
      );
    });
  }

  render() {
    const t = i18n.t.bind(i18n);
    const {currentType, itemEditorSections} = this.state;
    const {submitting} = this.props;
    return (<SettingsBase
      description={t("settings.itemEditorSectionsDescription")}
      title={t("settings.itemEditorSections")}
      currentType={currentType}
    >
      <AdminRadioGroup
        alignment="start"
        ariaLabel={t("settings.itemEditorSections")}
        disabled={submitting}
        name="item-editor-sections-media-podcast"
        value={itemEditorSections.mediaPodcast === true ? "on" : "off"}
        onValueChange={(value: string) => this.onUpdateMediaPodcast(value === "on")}
        variant="cards"
        options={[
          {
            value: "off",
            label: t("settings.itemEditorSectionsOff"),
            description: t("settings.itemEditorSectionsOffDescription"),
          },
          {
            value: "on",
            label: t("settings.itemEditorSectionsOn"),
            description: t("settings.itemEditorSectionsOnDescription"),
          },
        ]}
      />
    </SettingsBase>);
  }
}
