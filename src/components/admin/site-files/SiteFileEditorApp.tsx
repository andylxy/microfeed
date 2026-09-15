import {useEffect, useRef, useState} from "react";
import {ExternalLinkIcon, RefreshCwIcon, RotateCcwIcon, SaveIcon, Trash2Icon} from "lucide-react";

import i18n, {useTranslation} from "@/client/i18n";
import {preventCloseWhenChanged} from "@/client/BrowserUtils";
import {showToast} from "@/client/ToastUtils";
import AdminCodeEditor from "@/components/admin/shared/AdminCodeEditor";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {Textarea} from "@/components/ui/textarea";
import {ADMIN_URLS, PUBLIC_URLS} from "@/shared/StringUtils";
import {
  normalizeSiteFilenameInput,
  SITE_FILE_MAX_NAME_LENGTH,
  SITE_FILE_MEDIA_TYPES,
  type SiteFileMediaType,
  type SiteFileRecord,
} from "@/shared/SiteFiles";

interface Draft {
  content_type: SiteFileMediaType;
  draft_content: string;
  enabled: boolean;
  filename: string;
}

interface Preview {
  content_type: SiteFileMediaType;
  rendered_content: string;
  valid: true;
}

export function siteFileEditorLanguage(
  contentType: SiteFileMediaType,
): string | undefined {
  if (contentType === "text/plain") return undefined;
  if (contentType === "application/json" ||
      contentType === "application/manifest+json") return "json";
  if (contentType === "application/xml" ||
      contentType === "application/rss+xml") return "xml";
  if (contentType === "text/markdown") return "markdown";
  if (contentType === "text/yaml") return "yaml";
  if (contentType === "text/css") return "css";
  return "csv";
}

async function responseJson(response: Response): Promise<any> {
  const data = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok) throw new Error(data.error ?? i18n.t("siteFiles.operationFailed"));
  return data;
}

export default function SiteFileEditorApp({file}: {file?: SiteFileRecord}) {
  const {t} = useTranslation();
  const [record, setRecord] = useState(file);
  const [draft, setDraft] = useState<Draft>({
    content_type: file?.content_type ?? "text/plain",
    draft_content: file?.draft_content ?? "",
    enabled: file?.enabled ?? false,
    filename: file?.filename ?? "",
  });
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<"source" | "preview">("source");
  const [preview, setPreview] = useState<Preview>();
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const changedRef = useRef(false);
  useEffect(() => preventCloseWhenChanged(() => changedRef.current), []);
  const markChanged = (value: boolean) => {
    changedRef.current = value;
    setChanged(value);
  };
  const update = (value: Partial<Draft>) => {
    setDraft((current) => ({...current, ...value}));
    markChanged(true);
    setPreview(undefined);
    setPreviewError("");
  };
  const applyRecord = (next: SiteFileRecord) => {
    setRecord(next);
    setDraft({
      content_type: next.content_type,
      draft_content: next.draft_content,
      enabled: next.enabled,
      filename: next.filename,
    });
    markChanged(false);
    setPreview(undefined);
    setPreviewError("");
  };
  const previewPayload = () => ({
    ...draft,
    ...(record ? {site_file_id: record.id} : {}),
  });
  const run = async (operation: () => Promise<SiteFileRecord>, success: string) => {
    setBusy(true);
    try {
      const next = await operation();
      applyRecord(next);
      showToast(success, "success");
      return next;
    } catch (error) {
      showToast(error instanceof Error ? error.message : t("siteFiles.operationFailed"), "error");
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!draft.filename.trim()) {
      showToast(t("siteFiles.filenameRequired"), "error");
      return;
    }
    const next = await run(async () => {
      if (draft.enabled) {
        await responseJson(await fetch(
          ADMIN_URLS.ajaxPreviewSiteFile(),
          {
            body: JSON.stringify(previewPayload()),
            headers: {"content-type": "application/json"},
            method: "POST",
          },
        ));
      }
      let saved = await responseJson(await fetch(
        record ? ADMIN_URLS.ajaxSiteFile(record.id) : ADMIN_URLS.ajaxSiteFiles(),
        {body: JSON.stringify(draft), headers: {"content-type": "application/json"}, method: record ? "PUT" : "POST"},
      )) as SiteFileRecord;
      if (draft.enabled) {
        saved = await responseJson(await fetch(
          ADMIN_URLS.ajaxPublishSiteFile(saved.id),
          {method: "POST"},
        )) as SiteFileRecord;
      }
      return saved;
    }, record ? t("siteFiles.fileSaved") : t("siteFiles.fileCreated"));
    if (!record && next) window.location.assign(ADMIN_URLS.editSiteFile(next.id));
    return next;
  };
  const refreshPreview = async () => {
    setPreviewBusy(true);
    setPreviewError("");
    try {
      setPreview(await responseJson(await fetch(
        ADMIN_URLS.ajaxPreviewSiteFile(),
        {
          body: JSON.stringify(previewPayload()),
          headers: {"content-type": "application/json"},
          method: "POST",
        },
      )) as Preview);
    } catch (error) {
      setPreview(undefined);
      setPreviewError(
        error instanceof Error ? error.message : t("siteFiles.previewFailed"),
      );
    } finally {
      setPreviewBusy(false);
    }
  };
  const selectPreview = () => {
    setActiveTab("preview");
    void refreshPreview();
  };
  const reset = async () => {
    if (
      !record ||
      !window.confirm(
        t("siteFiles.resetConfirm", {filename: record.filename}),
      )
    ) return;
    await run(async () => responseJson(await fetch(ADMIN_URLS.ajaxResetSiteFile(record.id), {method: "POST"})), t("siteFiles.defaultRestored"));
  };
  const remove = async () => {
    if (!record || !window.confirm(t("siteFiles.deleteConfirm", {filename: record.filename}))) return;
    setBusy(true);
    try {
      await responseJson(await fetch(ADMIN_URLS.ajaxSiteFile(record.id), {method: "DELETE"}));
      markChanged(false);
      window.location.assign(ADMIN_URLS.siteFiles());
    } catch (error) {
      showToast(error instanceof Error ? error.message : t("siteFiles.deleteFailed"), "error");
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-5">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="rounded-[14px] border bg-card p-5 shadow-xs">
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div aria-label={t("siteFiles.editorViewAria")} className="flex gap-1" role="tablist">
                <Button aria-selected={activeTab === "source"} onClick={() => setActiveTab("source")} role="tab" size="sm" type="button" variant={activeTab === "source" ? "default" : "outline"}>{t("siteFiles.source")}</Button>
                <Button aria-selected={activeTab === "preview"} onClick={selectPreview} role="tab" size="sm" type="button" variant={activeTab === "preview" ? "default" : "outline"}>{t("siteFiles.preview")}</Button>
              </div>
              {activeTab === "preview" && (
                <Button disabled={previewBusy} onClick={() => void refreshPreview()} size="sm" type="button" variant="outline"><RefreshCwIcon aria-hidden="true" /> {t("siteFiles.refresh")}</Button>
              )}
            </div>
            {activeTab === "source" ? (
              <div aria-labelledby="site-file-source-label" role="tabpanel">
                <Label id="site-file-source-label">
                  <a
                    className="text-primary underline-offset-4 hover:underline"
                    href="https://mustache.github.io/"
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    Mustache
                  </a>{" "}
                  {t("siteFiles.template")}
                </Label>
                <div className="mt-2">
                  {siteFileEditorLanguage(draft.content_type) ? (
                    <AdminCodeEditor
                      ariaLabel={t("siteFiles.editorAria")}
                      code={draft.draft_content}
                      language={siteFileEditorLanguage(draft.content_type)!}
                      minHeight="28rem"
                      onChange={(event) => update({draft_content: event.target.value})}
                      placeholder={t("siteFiles.editorPlaceholder")}
                    />
                  ) : (
                    <Textarea className="min-h-[28rem] font-mono text-sm" id="site-file-content" spellCheck={false} value={draft.draft_content} onChange={(event) => update({draft_content: event.target.value})} />
                  )}
                </div>
              </div>
            ) : (
              <div aria-live="polite" role="tabpanel">
                <Label>{t("siteFiles.renderedOutput")}</Label>
                <div className="mt-2">
                  {previewBusy ? (
                    <div className="flex min-h-[28rem] items-center justify-center rounded-[10px] border bg-muted/30 text-sm text-muted-foreground">{t("siteFiles.renderingPreview")}</div>
                  ) : previewError ? (
                    <div className="min-h-[10rem] rounded-[10px] border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">{previewError}</div>
                  ) : preview && siteFileEditorLanguage(preview.content_type) ? (
                    <AdminCodeEditor ariaLabel={t("siteFiles.previewAria")} code={preview.rendered_content} language={siteFileEditorLanguage(preview.content_type)!} minHeight="28rem" readOnly />
                  ) : preview ? (
                    <Textarea aria-label={t("siteFiles.previewAria")} className="min-h-[28rem] bg-muted/60 font-mono text-sm" readOnly spellCheck={false} value={preview.rendered_content} />
                  ) : null}
                </div>
              </div>
            )}
            <details className="rounded-[10px] border bg-muted/20 p-3 text-sm">
              <summary className="cursor-pointer font-medium">{t("siteFiles.templateVariables")}</summary>
              <div className="mt-2 grid gap-2 text-muted-foreground">
                <p>
                  {t("siteFiles.templateVars1Before")}
                  <a
                    className="font-medium text-primary underline-offset-4 hover:underline"
                    href={PUBLIC_URLS.jsonFeed()}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    JSON Feed
                  </a>
                  {t("siteFiles.templateVars1After")}
                </p>
                <p>{t("siteFiles.templateVars2")}</p>
                <p>{t("siteFiles.templateVars3")}</p>
                <p>{t("siteFiles.templateVars4")}</p>
                <p>
                  <a
                    className="font-medium text-primary underline-offset-4 hover:underline"
                    href="https://mustache.github.io/"
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    Mustache
                  </a>
                  {t("siteFiles.templateVars5After")}
                </p>
              </div>
            </details>
          </div>
        </section>
        <aside className="grid content-start gap-4">
          <section className="rounded-[14px] border bg-card p-5 shadow-xs">
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="site-file-name">{t("siteFiles.nameLabel")}</Label>
                <Input
                  aria-describedby={draft.filename
                    ? "site-file-name-help site-file-name-preview"
                    : "site-file-name-help"}
                  disabled={Boolean(record)}
                  id="site-file-name"
                  maxLength={SITE_FILE_MAX_NAME_LENGTH}
                  onChange={(event) => update({
                    filename: normalizeSiteFilenameInput(event.target.value),
                  })}
                  placeholder={`${t("common.examplePrefix")}security.txt`}
                  required
                  value={draft.filename}
                />
                <p className="text-xs text-muted-foreground" id="site-file-name-help">
                  {t("siteFiles.nameHelp")}
                </p>
                {draft.filename && (
                  <p className="text-xs font-medium" id="site-file-name-preview">/{draft.filename}</p>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="site-file-type">{t("siteFiles.typeLabel")}</Label>
                <select className="h-10 cursor-pointer rounded-md border bg-background px-3 text-sm" id="site-file-type" value={draft.content_type} onChange={(event) => update({content_type: event.target.value as SiteFileMediaType})}>
                  {SITE_FILE_MEDIA_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="site-file-visibility">{t("siteFiles.visibilityLabel")}</Label>
                <select
                  className="h-10 cursor-pointer rounded-md border bg-background px-3 text-sm"
                  id="site-file-visibility"
                  onChange={(event) => update({enabled: event.target.value === "published"})}
                  value={draft.enabled ? "published" : "draft"}
                >
                  <option value="draft">{t("siteFiles.draftOption")}</option>
                  <option value="published">{t("siteFiles.publishedOption")}</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  {t("siteFiles.visibilityHelp")}
                </p>
              </div>
            </div>
          </section>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || !changed && Boolean(record)} onClick={() => void save()}><SaveIcon aria-hidden="true" /> {record ? t("siteFiles.saveFile") : t("siteFiles.createFile")}</Button>
            {record?.enabled && (record.mode === "generated" || record.date_published) && <Button render={<a href={record.url} target="_blank" rel="noreferrer" />} variant="outline"><ExternalLinkIcon aria-hidden="true" /> {t("siteFiles.view")}</Button>}
            {record && !record.system && <Button disabled={busy} onClick={() => void remove()} variant="destructive"><Trash2Icon aria-hidden="true" /> {t("siteFiles.delete")}</Button>}
          </div>
          {record?.mode === "override" && record.generator && (
            <section className="mt-2 rounded-[14px] border bg-card p-5 shadow-xs">
              <div className="grid gap-3">
                <h2 className="font-semibold">{t("siteFiles.defaultFileTitle")}</h2>
                <p className="text-sm text-muted-foreground">
                  {t("siteFiles.defaultFileDesc")}
                </p>
                <div>
                  <Button disabled={busy} onClick={() => void reset()} variant="outline">
                    <RotateCcwIcon aria-hidden="true" /> {t("siteFiles.restoreDefault")}
                  </Button>
                </div>
              </div>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
