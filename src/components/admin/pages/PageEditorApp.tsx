import {useCallback, useEffect, useRef, useState} from "react";
import {
  ExternalLinkIcon,
  SaveIcon,
  Trash2Icon,
} from "lucide-react";

import {preventCloseWhenChanged} from "@/client/BrowserUtils";
import {showToast} from "@/client/ToastUtils";
import {nativeWebMcpAvailable} from "@/client/webmcp/feature-detection";
import type {SavePageDraftInput} from "@/client/webmcp/schemas";
import {
  mergePageWebMcpDraft,
  pageWebMcpDraftEligible,
  type PageEditorDraft,
} from "@/client/webmcp/page-editor-state";
import AdminHelpLabel from "@/components/admin/shared/AdminHelpLabel";
import AdminRichEditor from "@/components/admin/shared/AdminRichEditor";
import {Button} from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {Switch} from "@/components/ui/switch";
import {Textarea} from "@/components/ui/textarea";
import {ADMIN_URLS, PUBLIC_URLS} from "@/shared/StringUtils";
import {
  normalizePageSlugInput,
  PAGE_META_DESCRIPTION_MAX_LENGTH,
  PAGE_SLUG_MAX_LENGTH,
  pageNavigationEnabledForStatus,
  type PageRecord,
} from "@/shared/Pages";
import {WEBMCP_INTERACTION_HEADERS} from "@/shared/WebMcp";
import i18n, {useTranslation} from "@/client/i18n";

type Draft = PageEditorDraft;

const EMPTY_PAGE: Draft = {
  content_html: "",
  meta_description: "",
  navigation_label: "",
  show_in_navigation: true,
  slug: "",
  status: "unpublished",
  title: "",
};

const PAGE_CREATED_TOAST_KEY = "microfeed.page-created";

type HelpTopic = "description" | "navigation" | "visibility";

function PageHelpDialog({
  onOpenChange,
  topic,
}: {
  onOpenChange: (open: boolean) => void;
  topic: HelpTopic | null;
}) {
  const {t} = useTranslation();
  const content = topic === "description"
    ? {
        description: t("pages.helpDescriptionDescription"),
        title: t("pages.helpDescriptionTitle"),
      }
    : topic === "visibility"
    ? {
        description: t("pages.helpVisibilityDescription"),
        title: t("pages.helpVisibilityTitle"),
      }
    : {
        description: t("pages.helpNavigationDescription"),
        title: t("pages.helpNavigationTitle"),
      };
  return (
    <Dialog onOpenChange={onOpenChange} open={topic !== null}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{content.title}</DialogTitle>
          <DialogDescription>{content.description}</DialogDescription>
        </DialogHeader>
        {topic === "description" ? (
          <div className="grid gap-4 text-sm leading-relaxed">
            <p>
              {t("pages.helpDescriptionBody", {count: PAGE_META_DESCRIPTION_MAX_LENGTH})}
            </p>
            <section className="grid gap-2">
              <h3 className="font-medium">{t("pages.helpDescriptionPublicHtml")}</h3>
              <code className="block overflow-x-auto rounded-lg bg-muted px-3 py-2 text-xs">
                {t("pages.helpDescriptionSample")}
              </code>
              <p className="text-muted-foreground">
                {t("pages.helpDescriptionMetaNote")}
              </p>
            </section>
          </div>
        ) : topic === "visibility" ? (
          <div className="grid gap-4 text-sm leading-relaxed">
            <section className="grid gap-1">
              <h3 className="font-medium">{t("pages.statusPublished")}</h3>
              <p className="text-muted-foreground">
                {t("pages.statusPublishedDescription")}
              </p>
            </section>
            <section className="grid gap-1 border-t pt-4">
              <h3 className="font-medium">{t("pages.statusUnlisted")}</h3>
              <p className="text-muted-foreground">
                {t("pages.statusUnlistedDescription")}
              </p>
            </section>
            <section className="grid gap-1 border-t pt-4">
              <h3 className="font-medium">{t("pages.statusDraft")}</h3>
              <p className="text-muted-foreground">
                {t("pages.statusDraftDescription")}
              </p>
            </section>
          </div>
        ) : (
          <div className="grid gap-5 text-sm leading-relaxed">
            <section className="grid gap-2">
              <h3 className="font-medium">{t("pages.helpNavPublicWebsite")}</h3>
              <p className="text-muted-foreground">
                {t("pages.helpNavAddedToData")}
              </p>
              <p className="text-muted-foreground">
                {t("pages.helpNavUnlistedCantAppear")}
              </p>
              <p className="text-muted-foreground">
                {t("pages.helpNavChangeOrder")}
              </p>
            </section>
            <section className="grid gap-2 border-t pt-4">
              <h3 className="font-medium">{t("pages.helpNavRssJson")}</h3>
              <p className="text-muted-foreground">
                {t("pages.helpNavRssJsonNote")}<a href={PUBLIC_URLS.rssFeed()} rel="noreferrer" target="_blank">RSS feed</a>{t("pages.helpNavRssJsonOr")}<a href={PUBLIC_URLS.jsonFeed()} rel="noreferrer" target="_blank">JSON Feed</a>{t("pages.helpNavRssJsonEnd")}
              </p>
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

async function responseJson(response: Response): Promise<any> {
  const data = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok) throw new Error(data.error ?? i18n.t("pages.operationFailed"));
  return data;
}

export default function PageEditorApp({
  page,
  themeSupportsPages,
}: {
  page?: PageRecord;
  themeSupportsPages: boolean;
}) {
  const {t} = useTranslation();
  const initialDraft = page ?? EMPTY_PAGE;
  const [draft, setDraft] = useState<Draft>({
    ...initialDraft,
    show_in_navigation: pageNavigationEnabledForStatus(
      initialDraft.status,
      initialDraft.show_in_navigation,
    ),
  });
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [helpTopic, setHelpTopic] = useState<HelpTopic | null>(null);
  const [savedPage, setSavedPage] = useState<PageRecord | undefined>(page);
  const changedRef = useRef(false);
  const busyRef = useRef(false);
  const draftRef = useRef(draft);
  const isNotFoundPage = Boolean(page?.is_not_found_page);
  useEffect(() => preventCloseWhenChanged(() => changedRef.current), []);
  useEffect(() => {
    if (!page || window.sessionStorage.getItem(PAGE_CREATED_TOAST_KEY) !== page.id) {
      return;
    }
    window.sessionStorage.removeItem(PAGE_CREATED_TOAST_KEY);
    showToast(t("pages.created"), "success");
  }, [page]);
  const markChanged = useCallback((value: boolean) => {
    changedRef.current = value;
    setChanged(value);
  }, []);
  const update = (value: Partial<Draft>) => {
    setDraft((current) => {
      const next = {...current, ...value};
      draftRef.current = next;
      return next;
    });
    markChanged(true);
  };

  const persistDraft = useCallback(async (
    nextDraft: Draft,
    options: {signal?: AbortSignal; webMcp?: boolean} = {},
  ): Promise<PageRecord> => {
    if (busyRef.current) {
      throw new Error(t("pages.saveInProgress"));
    }
    if (!nextDraft.title.trim()) {
      throw new Error(t("pages.needTitle"));
    }
    if (!isNotFoundPage && !nextDraft.slug.trim()) {
      throw new Error(t("pages.needUrlPath"));
    }
    if (
      !isNotFoundPage && nextDraft.show_in_navigation &&
      !nextDraft.navigation_label.trim()
    ) {
      throw new Error(
        t("pages.needNavLabel"),
      );
    }
    if (
      !isNotFoundPage && !themeSupportsPages &&
      nextDraft.status !== "unpublished"
    ) {
      throw new Error(
        t("pages.activateThemeToPublish"),
      );
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const saved = await responseJson(await fetch(
        page ? ADMIN_URLS.ajaxPage(page.id) : ADMIN_URLS.ajaxPages(),
        {
          body: JSON.stringify(nextDraft),
          headers: {
            "content-type": "application/json",
            ...(options.webMcp ? WEBMCP_INTERACTION_HEADERS : {}),
          },
          method: page ? "PUT" : "POST",
          signal: options.signal,
        },
      )) as PageRecord;
      markChanged(false);
      draftRef.current = saved;
      setDraft(saved);
      setSavedPage(saved);
      return saved;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [isNotFoundPage, markChanged, page, themeSupportsPages]);

  const save = async () => {
    try {
      const saved = await persistDraft(draft);
      if (!page) {
        window.sessionStorage.setItem(PAGE_CREATED_TOAST_KEY, saved.id);
        window.location.assign(ADMIN_URLS.editPage(saved.id));
      } else {
        showToast(t("pages.saved"), "success");
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : t("pages.operationFailed"), "error");
    }
  };

  useEffect(() => {
    const eligible = pageWebMcpDraftEligible({
      draftStatus: draft.status,
      isNotFoundPage,
      savedStatus: page ? savedPage?.status : undefined,
    });
    if (!eligible || !nativeWebMcpAvailable()) return;
    const controller = new AbortController();
    void import("@/client/webmcp/editor-tools").then(
      ({registerPageDraftTool}) => registerPageDraftTool(
        controller.signal,
        async (input: SavePageDraftInput, signal) => {
          const current = draftRef.current;
          if (
            current.status !== "unpublished" ||
            (page && savedPage?.status !== "unpublished")
          ) {
            throw new Error(
              t("pages.webmcpOnlyUnpublished"),
            );
          }
          const next = mergePageWebMcpDraft(current, input);
          draftRef.current = next;
          setDraft(next);
          markChanged(true);
          const saved = await persistDraft(next, {signal, webMcp: true});
          const editorUrl = new URL(
            ADMIN_URLS.editPage(saved.id),
            window.location.origin,
          ).toString();
          if (!page) {
            window.sessionStorage.setItem(PAGE_CREATED_TOAST_KEY, saved.id);
            setTimeout(() => window.location.assign(editorUrl), 0);
          } else {
            showToast(t("pages.saved"), "success");
          }
          return {
            content_html: saved.content_html,
            editor_url: editorUrl,
            id: saved.id,
            meta_description: saved.meta_description ?? "",
            navigation_label: saved.navigation_label,
            show_in_navigation: saved.show_in_navigation,
            slug: saved.slug,
            status: "unpublished",
            title: saved.title,
          };
        },
      ),
    ).catch((error) => {
      if (!controller.signal.aborted) {
        controller.abort();
        console.warn(error);
      }
    });
    return () => controller.abort();
  }, [
    draft.status,
    isNotFoundPage,
    markChanged,
    page,
    persistDraft,
    savedPage?.status,
  ]);

  const remove = async () => {
    if (!page || !window.confirm(t("pages.deleteConfirm", {title: page.title}))) return;
    setBusy(true);
    try {
      await responseJson(await fetch(ADMIN_URLS.ajaxPage(page.id), {method: "DELETE"}));
      window.location.assign(ADMIN_URLS.pages());
    } catch (error) {
      showToast(error instanceof Error ? error.message : t("pages.deleteFailed"), "error");
      setBusy(false);
    }
  };

  return (
    <>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <section className="rounded-[14px] border bg-card p-5 shadow-xs">
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="page-title">{t("pages.title")}</Label>
            <Input id="page-title" value={draft.title} onChange={(event) => update({title: event.target.value})} />
          </div>
          <AdminRichEditor
            label={t("pages.content")}
            value={draft.content_html}
            onChange={(value: string) => update({content_html: value})}
          />
          <div className="grid gap-2">
            <AdminHelpLabel
              id="page-description-label"
              onClick={() => setHelpTopic("description")}
            >
              {t("pages.helpDescriptionTitle")}
            </AdminHelpLabel>
            <Textarea
              aria-describedby="page-description-help page-description-count"
              aria-labelledby="page-description-label"
              id="page-description"
              maxLength={PAGE_META_DESCRIPTION_MAX_LENGTH}
              onChange={(event) => update({meta_description: event.target.value})}
              value={draft.meta_description ?? ""}
            />
            <div className="flex items-start justify-between gap-4 text-xs text-muted-foreground">
              <p id="page-description-help">{t("pages.descriptionHelp")}</p>
              <p className="shrink-0 tabular-nums" id="page-description-count">
                {(draft.meta_description ?? "").length}/{PAGE_META_DESCRIPTION_MAX_LENGTH}
              </p>
            </div>
          </div>
        </div>
      </section>
      <aside className="grid content-start gap-4">
        <section className="rounded-[14px] border bg-card p-5 shadow-xs">
          <div className="grid gap-4">
            {isNotFoundPage ? (
              <div className="grid gap-2 text-sm">
                <p className="font-medium">{t("pages.default404Page")}</p>
                <p className="text-muted-foreground">
                  {t("pages.default404Description")}
                </p>
              </div>
            ) : (
              <>
                <div className="grid gap-2">
                  <AdminHelpLabel
                    id="page-status-label"
                    onClick={() => setHelpTopic("visibility")}
                  >
                    {t("pages.visibility")}
                  </AdminHelpLabel>
                  <select
                    aria-labelledby="page-status-label"
                    className="h-10 cursor-pointer rounded-md border bg-background px-3 text-sm"
                    id="page-status"
                    value={draft.status}
                    onChange={(event) => {
                      const status = event.target.value as Draft["status"];
                      update({
                        show_in_navigation: pageNavigationEnabledForStatus(
                          status,
                          draft.show_in_navigation,
                        ),
                        status,
                      });
                    }}
                  >
                    <option value="published" disabled={!themeSupportsPages}>{t("pages.statusPublished")}</option>
                    <option value="unlisted" disabled={!themeSupportsPages}>{t("pages.statusUnlisted")}</option>
                    <option value="unpublished">{t("pages.statusDraft")}</option>
                  </select>
                  {!themeSupportsPages && <p className="text-xs text-muted-foreground">{t("pages.publishingUnlocks")}</p>}
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="page-slug">
                    {t("pages.urlPath")} <span aria-hidden="true" className="text-destructive">*</span>
                  </Label>
                  <Input
                    aria-describedby={draft.slug
                      ? "page-slug-help page-slug-preview"
                      : "page-slug-help"}
                    id="page-slug"
                    maxLength={PAGE_SLUG_MAX_LENGTH}
                    onChange={(event) => update({slug: normalizePageSlugInput(event.target.value)})}
                    placeholder={t("pages.urlPathPlaceholder")}
                    required
                    value={draft.slug}
                  />
                  <p className="text-xs text-muted-foreground" id="page-slug-help">
                    {t("pages.urlPathHelp")}
                  </p>
                  {draft.slug && (
                    <p className="text-xs font-medium" id="page-slug-preview">/{draft.slug}/</p>
                  )}
                </div>
              </>
            )}
          </div>
        </section>
        {!isNotFoundPage && (
          <section className="rounded-[14px] border bg-card p-5 shadow-xs">
            <AdminHelpLabel
              className="mb-4 text-base font-semibold"
              onClick={() => setHelpTopic("navigation")}
            >
              {t("pages.navigation")}
            </AdminHelpLabel>
            <div className="grid gap-4">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="page-navigation">{t("pages.showInNavigation")}</Label>
                <Switch
                  checked={draft.show_in_navigation}
                  disabled={draft.status === "unlisted"}
                  id="page-navigation"
                  onCheckedChange={(checked) => update({show_in_navigation: checked})}
                />
              </div>
              {draft.status === "unlisted" && (
                <p className="text-xs text-muted-foreground">
                  {t("pages.unlistedNeverInNavigation")}
                </p>
              )}
              <div className="grid gap-2">
                <Label htmlFor="page-navigation-label">
                  {t("pages.navigationLabel")}
                  {draft.show_in_navigation && (
                    <span aria-hidden="true" className="text-destructive"> *</span>
                  )}
                </Label>
                <Input
                  disabled={!draft.show_in_navigation}
                  id="page-navigation-label"
                  onChange={(event) => update({navigation_label: event.target.value})}
                  placeholder={t("pages.navigationLabelPlaceholder")}
                  required={draft.show_in_navigation}
                  value={draft.navigation_label}
                />
                <p className="text-xs text-muted-foreground">{t("pages.navigationLabelHelp")}</p>
              </div>
            </div>
          </section>
        )}
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || !changed && Boolean(page)} onClick={() => void save()}>
            <SaveIcon aria-hidden="true" /> {page ? t("pages.savePage") : t("pages.createPage")}
          </Button>
          {savedPage && savedPage.status !== "unpublished" && <Button render={<a href={savedPage.url} target="_blank" rel="noreferrer" />} variant="outline"><ExternalLinkIcon aria-hidden="true" /> {t("pages.view")}</Button>}
          {page && !isNotFoundPage && <Button disabled={busy} onClick={() => void remove()} variant="destructive"><Trash2Icon aria-hidden="true" /> {t("pages.delete")}</Button>}
        </div>
      </aside>
      </div>
      <PageHelpDialog
        onOpenChange={(open) => {
          if (!open) setHelpTopic(null);
        }}
        topic={helpTopic}
      />
    </>
  );
}
