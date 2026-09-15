import {useEffect, useState} from "react";

import i18n, {useTranslation} from "@/client/i18n";
import {preventCloseWhenChanged} from "@/client/BrowserUtils";
import {showToast} from "@/client/ToastUtils";
import ThemeBundleEditor, {
  type ThemeEditorLinks,
} from "@/components/admin/code-editor/ThemeBundleEditor";
import AdminDialog from "@/components/admin/shared/AdminDialog";
import AdminHelpLabel from "@/components/admin/shared/AdminHelpLabel";
import AdminRadioGroup from "@/components/admin/shared/AdminRadioGroup";
import ThemePreviewDialog from "@/components/admin/themes/ThemePreviewDialog";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Textarea} from "@/components/ui/textarea";
import {ADMIN_URLS} from "@/shared/StringUtils";
import {
  DEFAULT_THEME_SEARCH_ITEM_DESTINATION,
  THEME_DESCRIPTION_MAX_LENGTH,
  type ThemeDraft,
  type ThemeManifestV1,
  type ThemeSearchItemDestination,
} from "@/shared/themes/ThemeContract";

interface Props {
  draft: ThemeDraft;
  themeEditorLinks: ThemeEditorLinks;
}

type ThemeFieldKey = "author" | "description" | "license" | "microfeed" | "name" | "packageId" | "version";
type ThemeManifestUpdates = Partial<Record<ThemeFieldKey, string>> & {
  searchItemDestination?: ThemeSearchItemDestination;
};

const THEME_FIELD_KEYS: Record<ThemeFieldKey, {descKey: string; labelKey: string}> = {
  author: {descKey: "themes.fieldAuthorDesc", labelKey: "themes.fieldAuthorLabel"},
  description: {descKey: "themes.fieldDescriptionDesc", labelKey: "themes.fieldDescriptionLabel"},
  license: {descKey: "themes.fieldLicenseDesc", labelKey: "themes.fieldLicenseLabel"},
  microfeed: {descKey: "themes.fieldMicrofeedDesc", labelKey: "themes.fieldMicrofeedLabel"},
  name: {descKey: "themes.fieldNameDesc", labelKey: "themes.fieldNameLabel"},
  packageId: {descKey: "themes.fieldPackageIdDesc", labelKey: "themes.fieldPackageIdLabel"},
  version: {descKey: "themes.fieldVersionDesc", labelKey: "themes.fieldVersionLabel"},
};

function ThemeFieldLabel({
  field,
  onExplain,
  required = false,
}: {
  field: ThemeFieldKey;
  onExplain: (field: ThemeFieldKey) => void;
  required?: boolean;
}) {
  const {t} = useTranslation();
  const {labelKey} = THEME_FIELD_KEYS[field];
  return (
    <AdminHelpLabel
      id={`theme-${field}-label`}
      onClick={() => onExplain(field)}
      required={required}
    >
      {t(labelKey)}
    </AdminHelpLabel>
  );
}

async function responseJson(response: Response): Promise<any> {
  const data = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok) throw new Error(data.error ?? i18n.t("themes.draftOperationFailed"));
  return data;
}

export default function ThemeDraftEditorApp({
  draft: initial,
  themeEditorLinks,
}: Props) {
  const {t} = useTranslation();
  const [draft, setDraft] = useState(initial);
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [helpField, setHelpField] = useState<ThemeFieldKey | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  useEffect(() => preventCloseWhenChanged(() => changed), [changed]);

  const updateManifest = (updates: ThemeManifestUpdates) => {
    setDraft({...draft, manifest: {...draft.manifest, ...updates} as ThemeManifestV1, ...("name" in updates ? {name: updates.name!} : {}), ...("version" in updates ? {version: updates.version!} : {})});
    setChanged(true);
  };
  const validateRequiredMetadata = () => {
    if (!draft.manifest.name.trim()) throw new Error(t("themes.nameRequired"));
    if (!draft.manifest.version.trim()) throw new Error(t("themes.versionRequired"));
    if (
      (draft.manifest.description?.length ?? 0) >
        THEME_DESCRIPTION_MAX_LENGTH
    ) {
      throw new Error(
        t("themes.descTooLong", {max: THEME_DESCRIPTION_MAX_LENGTH}),
      );
    }
  };
  const save = async ({notify = true}: {notify?: boolean} = {}): Promise<ThemeDraft> => {
    validateRequiredMetadata();
    setBusy(true);
    try {
      const {draft: saved} = await responseJson(await fetch(ADMIN_URLS.ajaxThemeDraft(draft.id), {
        body: JSON.stringify({bundle: draft.bundle, manifest: draft.manifest}),
        headers: {"content-type": "application/json"},
        method: "PUT",
      }));
      setDraft(saved);
      setChanged(false);
      setPreviewKey((value) => value + 1);
      if (notify) showToast(t("themes.draftSaved"), "success");
      return saved;
    } finally {
      setBusy(false);
    }
  };
  const run = async (operation: () => Promise<void>) => {
    try { await operation(); } catch (error) { showToast(error instanceof Error ? error.message : t("themes.draftOperationFailed"), "error"); }
  };
  const preview = () => run(async () => {
    if (changed) await save({notify: false});
    setPreviewOpen(true);
  });
  const install = () => run(async () => {
    validateRequiredMetadata();
    if (changed) await save();
    setBusy(true);
    try {
      const {theme} = await responseJson(await fetch(ADMIN_URLS.ajaxThemeDraft(draft.id), {
        body: JSON.stringify({action: "publish"}),
        headers: {"content-type": "application/json"},
        method: "POST",
      }));
      showToast(t("themes.installedToast", {packageId: theme.packageId, version: theme.version}), "success");
      window.location.assign(ADMIN_URLS.themesSettings());
    } finally { setBusy(false); }
  });
  const discard = () => run(async () => {
    if (!window.confirm(
      t("themes.discardConfirm", {name: draft.name, version: draft.version}),
    )) return;
    await responseJson(await fetch(ADMIN_URLS.ajaxThemeDraft(draft.id), {method: "DELETE"}));
    setChanged(false);
    window.location.assign(ADMIN_URLS.themesSettings());
  });

  return <div className="grid min-w-0 gap-5">
    <section className="rounded-[14px] border bg-card p-5 shadow-xs">
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <ThemeFieldLabel field="name" onExplain={setHelpField} required />
          <Input aria-labelledby="theme-name-label" id="theme-name" required value={draft.manifest.name} onChange={(event) => updateManifest({name: event.target.value})} />
        </div>
        <div>
          <ThemeFieldLabel field="version" onExplain={setHelpField} required />
          <Input aria-labelledby="theme-version-label" id="theme-version" required value={draft.manifest.version} onChange={(event) => updateManifest({version: event.target.value})} />
        </div>
      </div>
      <details className="mt-5 border-t pt-4">
        <summary className="cursor-pointer text-sm font-medium">{t("themes.themeDetailsSummary")}</summary>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("themes.themeDetailsNote")}
        </p>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <ThemeFieldLabel field="description" onExplain={setHelpField} />
            <Textarea
              aria-describedby="theme-description-help theme-description-count"
              aria-labelledby="theme-description-label"
              id="theme-description"
              maxLength={THEME_DESCRIPTION_MAX_LENGTH}
              onChange={(event) => updateManifest({description: event.target.value})}
              rows={3}
              value={draft.manifest.description ?? ""}
            />
            <div className="mt-1 flex items-start justify-between gap-3 text-xs text-muted-foreground">
              <p id="theme-description-help">
                {t("themes.describeHint")}
              </p>
              <p className="shrink-0 tabular-nums" id="theme-description-count">
                {(draft.manifest.description ?? "").length}/{THEME_DESCRIPTION_MAX_LENGTH}
              </p>
            </div>
          </div>
          <div>
            <ThemeFieldLabel field="author" onExplain={setHelpField} />
            <Input aria-labelledby="theme-author-label" id="theme-author" value={draft.manifest.author} onChange={(event) => updateManifest({author: event.target.value})} />
          </div>
          <div>
            <ThemeFieldLabel field="license" onExplain={setHelpField} />
            <Input aria-labelledby="theme-license-label" id="theme-license" value={draft.manifest.license} onChange={(event) => updateManifest({license: event.target.value})} />
          </div>
          <div>
            <ThemeFieldLabel field="packageId" onExplain={setHelpField} />
            <Input aria-labelledby="theme-packageId-label" id="theme-package" readOnly value={draft.manifest.packageId} />
          </div>
          <div>
            <ThemeFieldLabel field="microfeed" onExplain={setHelpField} />
            <Input aria-labelledby="theme-microfeed-label" id="theme-compatibility" value={draft.manifest.microfeed} onChange={(event) => updateManifest({microfeed: event.target.value})} />
          </div>
        </div>
        {draft.manifest.formatVersion === 2 && (
          <div className="mt-5 border-t pt-4">
            <h3 className="text-sm font-semibold">{t("themes.searchResultLinksTitle")}</h3>
            <p className="mt-1 mb-4 text-sm text-muted-foreground">
              {t("themes.searchResultLinksDesc")}
            </p>
            <AdminRadioGroup
              alignment="start"
              ariaLabel={t("themes.searchDestAria")}
              name="search-item-destination"
              value={draft.manifest.searchItemDestination ?? DEFAULT_THEME_SEARCH_ITEM_DESTINATION}
              onValueChange={(value) => updateManifest({
                searchItemDestination: value as ThemeSearchItemDestination,
              })}
              variant="cards"
              options={[
                {
                  description: t("themes.searchDestWebDesc", {
                    jsonfeed: "items[]._microfeed.web_url",
                    rss: "<item><link>",
                  }),
                  label: t("themes.searchDestWebLabel"),
                  value: "web",
                },
                {
                  description: t("themes.searchDestUrlDesc", {
                    jsonfeed: "items[].url",
                    rss: "<item><link>",
                  }),
                  label: t("themes.searchDestUrlLabel"),
                  value: "url",
                },
                {
                  description: t("themes.searchDestAttachmentDesc", {
                    jsonfeed: "items[].attachments[0].url",
                    rss: "<item><enclosure url=\"…\">",
                  }),
                  label: t("themes.searchDestAttachmentLabel"),
                  value: "attachment",
                },
              ]}
            />
          </div>
        )}
      </details>
    </section>
    <section className="min-w-0 rounded-[14px] border bg-card p-5 shadow-xs"><ThemeBundleEditor bundle={draft.bundle} links={themeEditorLinks} onChange={(bundle) => {setDraft({...draft, bundle}); setChanged(true);}} /></section>
    <div className="sticky bottom-4 mx-4 flex flex-wrap items-center justify-between gap-2 rounded-[14px] border bg-card/95 p-4 shadow-lg backdrop-blur">
      <Button disabled={busy} variant="destructive" onClick={discard}>
        {t("themes.discardDraft")}
      </Button>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          disabled={busy || !changed}
          variant="outline"
          onClick={() => run(async () => {await save();})}
        >
          {busy ? t("themes.saving") : t("themes.saveDraft")}
        </Button>
        <Button
          className="theme-preview-button"
          disabled={busy}
          onClick={preview}
          variant="outline"
        >
          {t("themes.preview")}
        </Button>
        <Button disabled={busy} onClick={install}>
          {busy ? t("themes.installing") : t("themes.installLabel")}
        </Button>
      </div>
    </div>
    <ThemePreviewDialog
      description={draft.manifest.description}
      hasPreviewFixture={Boolean(draft.manifest.previewFixture)}
      label={`${draft.name} ${draft.version}`}
      onOpenChange={setPreviewOpen}
      open={previewOpen}
      previewUrl={ADMIN_URLS.ajaxThemeDraftPreview(draft.id)}
      revision={previewKey}
      supportsPagesAndSearch={draft.manifest.formatVersion === 2}
    />
    <AdminDialog
      onOpenChange={(open) => {if (!open) setHelpField(null);}}
      open={helpField !== null}
      title={helpField ? t(THEME_FIELD_KEYS[helpField].labelKey) : t("themes.themeFieldTitle")}
    >
      {helpField && <div className="grid gap-4 py-2 text-sm leading-relaxed text-muted-foreground">
        <p>{t(THEME_FIELD_KEYS[helpField].descKey)}</p>
        {helpField === "microfeed" && <p>{t("themes.microfeedExample")}</p>}
        <a className="font-medium text-primary hover:underline" href="https://docs.microfeed.org/dashboard/themes/" rel="noopener noreferrer" target="_blank">{t("themes.themeGuideLink")}</a>
      </div>}
    </AdminDialog>
  </div>;
}
