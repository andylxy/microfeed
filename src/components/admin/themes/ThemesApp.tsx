import {useEffect, useState, type ReactNode} from "react";
import {CircleHelpIcon, CopyIcon, SearchIcon} from "lucide-react";

import i18n, {useTranslation} from "@/client/i18n";
import {formatAdminTimestamp} from "@/client/admin-date-format";
import {showToast} from "@/client/ToastUtils";
import ThemeInstallHelpDialog from "@/components/admin/themes/ThemeInstallHelpDialog";
import ThemePreviewDialog from "@/components/admin/themes/ThemePreviewDialog";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {ADMIN_URLS} from "@/shared/StringUtils";
import {
  MICROFEED_MANAGE_COMMAND,
  managementCommand,
} from "@/shared/ManagementCli";
import type {
  BuiltInThemeGroup,
  ThemeAdminTab,
  ThemeListResponse,
  ThemeListSort,
  ThemeState,
  ThemeVersionSummary,
} from "@/shared/themes/ThemeContract";

interface Props {
  initialListing: ThemeListResponse;
  initialQuery: string;
  initialSort: ThemeListSort;
  initialTab: ThemeAdminTab;
  instanceName: string;
  siteUrl: string;
}

interface Preview {
  description?: string;
  hasPreviewFixture: boolean;
  label: string;
  supportsPagesAndSearch: boolean;
  url: string;
}

async function requestJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, {
    ...init,
    headers: {"content-type": "application/json", ...init?.headers},
  });
  const body = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok) throw new Error(body.error ?? i18n.t("themes.operationFailed"));
  return body;
}

function Status({state, theme}: {state: ThemeState; theme: ThemeVersionSummary}) {
  if (state.activeThemeId === theme.id) {
    return <span className="rounded-full bg-emerald-100 px-2 py-1 text-xs text-emerald-800">{i18n.t("themes.statusActive")}</span>;
  }
  if (state.previousThemeId === theme.id) {
    return <span className="rounded-full bg-amber-100 px-2 py-1 text-xs text-amber-800">{i18n.t("themes.statusPrevious")}</span>;
  }
  return <span className="rounded-full bg-muted px-2 py-1 text-xs">{i18n.t("themes.statusInactive")}</span>;
}

function InstalledAt({value}: {value: string}) {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/u.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const date = new Date(normalized);
  const valid = !Number.isNaN(date.getTime());
  return (
    <p className="mt-1 text-xs text-muted-foreground">
      {i18n.t("themes.installedAt")}{" "}
      <time dateTime={valid ? date.toISOString() : value}>
        {valid ? formatAdminTimestamp(date) : value}
      </time>
    </p>
  );
}

function originThemeLabel(theme: ThemeVersionSummary): string {
  if (!theme.originThemeId) return "—";
  if (theme.originThemeName && theme.originThemeVersion) {
    return `${theme.originThemeName} · ${theme.originThemeVersion}`;
  }
  return i18n.t("themes.originUnavailable");
}

interface VersionCardProps {
  builtIn?: boolean;
  builtInSource?: string | null;
  busy: boolean;
  children?: ReactNode;
  copy: (value: string) => Promise<void>;
  currentVersion?: string | null;
  instanceName: string;
  onActivate: (theme: ThemeVersionSummary) => void;
  onCreateVersion: (themeId: string) => void;
  onDelete: (theme: ThemeVersionSummary) => void;
  onPreview: (theme: ThemeVersionSummary) => void;
  siteUrl: string;
  state: ThemeState;
  theme: ThemeVersionSummary;
}

function VersionCard({
  builtIn = false,
  builtInSource,
  busy,
  children,
  copy,
  currentVersion,
  instanceName,
  onActivate,
  onCreateVersion,
  onDelete,
  onPreview,
  siteUrl,
  state,
  theme,
}: VersionCardProps) {
  const {t} = useTranslation();
  const canUpdate = builtIn || Boolean(theme.sourceUrl || theme.sourcePath);
  const updateCommand = builtIn && builtInSource
    ? managementCommand(`theme install ${builtInSource} --instance ${instanceName}`)
    : managementCommand(`theme update ${theme.id} --instance ${instanceName}`);
  const exportCommand = managementCommand(
    `theme export ${theme.id} --instance ${instanceName} ` +
      `--output ~/microfeed-themes/${theme.packageId}-${theme.version} --git`,
  );
  const updatePrompt = builtIn
    ? t("themes.updateBuiltInPrompt", {
      command: MICROFEED_MANAGE_COMMAND,
      packageId: theme.packageId,
      siteUrl,
    })
    : t("themes.updateSourcePrompt", {
      command: MICROFEED_MANAGE_COMMAND,
      siteUrl,
      source: theme.sourceUrl ?? theme.sourcePath ?? "",
    });
  const exportPrompt = t("themes.exportPrompt", {
    command: MICROFEED_MANAGE_COMMAND,
    id: theme.id,
    packageId: theme.packageId,
    siteUrl,
    version: theme.version,
  });
  return (
    <article className="rounded-xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium">{theme.name}</h3>
            {builtIn && (
              <span className="rounded-full bg-blue-100 px-2 py-1 text-xs text-blue-800">
                {t("themes.badgeBuiltIn")}
              </span>
            )}
            {currentVersion === theme.version && (
              <span className="rounded-full bg-violet-100 px-2 py-1 text-xs text-violet-800">
                {t("themes.badgeCurrentRelease")}
              </span>
            )}
            {builtIn && theme.manifest.previewFixture && (
              <span className="rounded-full bg-cyan-100 px-2 py-1 text-xs text-cyan-800">
                {t("themes.badgeDemoContent")}
              </span>
            )}
            <Status state={state} theme={theme} />
          </div>
          <code className="text-xs text-muted-foreground">
            {theme.packageId}@{theme.version}
          </code>
          <InstalledAt value={theme.createdAt} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => onCreateVersion(theme.id)} variant="outline">
            {t("themes.createNewVersion")}
          </Button>
          <Button onClick={() => onPreview(theme)} variant="outline">{t("themes.preview")}</Button>
          <Button
            disabled={busy || state.activeThemeId === theme.id}
            onClick={() => onActivate(theme)}
          >
            {t("themes.activate")}
          </Button>
          {!builtIn && (
            <Button
              disabled={busy || state.activeThemeId === theme.id}
              onClick={() => onDelete(theme)}
              variant="destructive"
            >
              {t("themes.delete")}
            </Button>
          )}
        </div>
      </div>

      {theme.manifest.description && (
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          {theme.manifest.description}
        </p>
      )}

      {builtIn && (
        <p className="mt-3 rounded-lg bg-muted/60 p-3 text-xs leading-5 text-muted-foreground">
          {t("themes.builtInNote")}
        </p>
      )}

      <details className="mt-3 border-t pt-3 text-xs">
        <summary className="cursor-pointer font-medium text-muted-foreground">{t("themes.details")}</summary>
        <dl className="mt-3 grid gap-1 text-muted-foreground md:grid-cols-2">
          <div><dt className="inline font-medium text-foreground">{t("themes.detailAuthor")} </dt><dd className="inline">{theme.manifest.author}</dd></div>
          <div><dt className="inline font-medium text-foreground">{t("themes.detailLicense")} </dt><dd className="inline">{theme.manifest.license}</dd></div>
          <div><dt className="inline font-medium text-foreground">{t("themes.detailCompatibility")} </dt><dd className="inline">{theme.manifest.microfeed}</dd></div>
          <div><dt className="inline font-medium text-foreground">{t("themes.detailAssets")} </dt><dd className="inline">{theme.assetCount}</dd></div>
          <div><dt className="inline font-medium text-foreground">{t("themes.detailDemoContent")} </dt><dd className="inline">{theme.manifest.previewFixture ? t("themes.detailIncluded") : t("themes.detailNotProvided")}</dd></div>
          <div><dt className="inline font-medium text-foreground">{t("themes.detailSource")} </dt><dd className="inline break-all">{theme.sourceUrl ?? theme.sourcePath ?? theme.sourceKind}</dd></div>
          <div><dt className="inline font-medium text-foreground">{t("themes.detailCommit")} </dt><dd className="inline break-all">{theme.sourceCommit ?? "—"}</dd></div>
          <div><dt className="inline font-medium text-foreground">{t("themes.detailOriginTheme")} </dt><dd className="inline">{originThemeLabel(theme)}</dd></div>
          <div className="md:col-span-2"><dt className="inline font-medium text-foreground">{t("themes.detailChecksum")} </dt><dd className="inline break-all">{theme.checksumSha256}</dd></div>
        </dl>
        <div className="mt-4 grid gap-3">
          {canUpdate && (
            <div className="rounded-lg border bg-muted/50 p-3">
              <p className="mb-2 text-muted-foreground">
                <strong className="text-foreground">{t("themes.updateWithAgent")}</strong>{" "}
                {builtIn
                  ? t("themes.updateBuiltInHint")
                  : t("themes.updateSourceHint")}
              </p>
              <div className="flex items-center gap-2 rounded-lg bg-muted p-2">
                <p className="min-w-0 flex-1 font-mono text-xs leading-5">{updatePrompt}</p>
                <Button aria-label={t("themes.copyUpdatePromptAria")} onClick={() => copy(updatePrompt)} size="icon-sm" variant="ghost">
                  <CopyIcon />
                </Button>
              </div>
              <details className="mt-2">
                <summary className="cursor-pointer text-muted-foreground">{t("themes.manualCliCommand")}</summary>
                <div className="mt-2 flex items-center gap-2 rounded-lg bg-muted p-2">
                  <code className="min-w-0 flex-1 overflow-x-auto">{updateCommand}</code>
                  <Button aria-label={t("themes.copyUpdateCommandAria")} onClick={() => copy(updateCommand)} size="icon-sm" variant="ghost">
                    <CopyIcon />
                  </Button>
                </div>
              </details>
            </div>
          )}
          <div className="rounded-lg border bg-muted/50 p-3">
            <p className="mb-2 text-muted-foreground">
              <strong className="text-foreground">{t("themes.exportWithAgent")}</strong>{" "}
              {t("themes.exportWithAgentDesc")}
            </p>
            <div className="flex items-center gap-2 rounded-lg bg-muted p-2">
              <p className="min-w-0 flex-1 font-mono text-xs leading-5">{exportPrompt}</p>
              <Button aria-label={t("themes.copyExportPromptAria")} onClick={() => copy(exportPrompt)} size="icon-sm" variant="ghost">
                <CopyIcon />
              </Button>
            </div>
            <details className="mt-2">
              <summary className="cursor-pointer text-muted-foreground">{t("themes.manualCliCommand")}</summary>
              <div className="mt-2 flex items-center gap-2 rounded-lg bg-muted p-2">
                <code className="min-w-0 flex-1 overflow-x-auto">{exportCommand}</code>
                <Button aria-label={t("themes.copyExportCommandAria")} onClick={() => copy(exportCommand)} size="icon-sm" variant="ghost">
                  <CopyIcon />
                </Button>
              </div>
            </details>
          </div>
        </div>
      </details>
      {children}
    </article>
  );
}

function currentBuiltInVersion(group: BuiltInThemeGroup): ThemeVersionSummary {
  return group.versions.find(({version}) => version === group.currentVersion) ??
    group.versions[0]!;
}

export default function ThemesApp({
  initialListing,
  initialQuery,
  initialSort,
  initialTab,
  instanceName,
  siteUrl,
}: Props) {
  const {t} = useTranslation();
  const [listing, setListing] = useState(initialListing);
  const [query, setQuery] = useState(initialQuery);
  const [sort, setSort] = useState<ThemeListSort>(initialSort);
  const [page, setPage] = useState(initialListing.pagination.page);
  const [tab, setTab] = useState<ThemeAdminTab>(initialTab);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [installHelpOpen, setInstallHelpOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);

  useEffect(() => {
    const parameters = new URLSearchParams({tab});
    if (tab === "custom") {
      if (query.trim()) parameters.set("q", query.trim());
      if (sort !== "status") parameters.set("sort", sort);
      if (page !== 1) parameters.set("page", String(page));
    }
    window.history.replaceState(null, "", `${window.location.pathname}?${parameters}`);
    if (tab === "built-in") {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setLoading(true);
      try {
        const next = await requestJson(
          `${ADMIN_URLS.ajaxThemes()}?${parameters}`,
          {signal: controller.signal},
        ) as ThemeListResponse;
        setListing(next);
      } catch (error) {
        if (!controller.signal.aborted) {
          showToast(error instanceof Error ? error.message : t("themes.loadFailed"), "error");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [page, query, sort, tab]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    try {
      await operation();
    } catch (error) {
      showToast(error instanceof Error ? error.message : t("themes.operationFailed"), "error");
      setBusy(false);
    }
  };
  const createVersion = (themeId: string) => run(async () => {
    const {draft} = await requestJson(ADMIN_URLS.ajaxThemes(), {
      body: JSON.stringify({action: "customize", originKind: "theme", themeId}),
      method: "POST",
    });
    window.location.assign(ADMIN_URLS.themeDraft(draft.id));
  });
  const activate = (theme: ThemeVersionSummary) => {
    const details = [
      t("themes.activateConfirmTitle", {packageId: theme.packageId, version: theme.version}),
      t("themes.activateConfirmOrigin", {origin: theme.sourceUrl ?? theme.sourceKind}),
      theme.originThemeId ? t("themes.activateConfirmOriginTheme", {label: originThemeLabel(theme)}) : null,
      theme.sourceCommit ? t("themes.activateConfirmCommit", {commit: theme.sourceCommit}) : null,
      t("themes.activateConfirmChecksum", {checksum: theme.checksumSha256}),
    ].filter(Boolean).join("\n");
    if (!window.confirm(details)) return;
    run(async () => {
      await requestJson(ADMIN_URLS.ajaxThemes(), {
        body: JSON.stringify({action: "activate", themeId: theme.id}),
        method: "POST",
      });
      window.location.reload();
    });
  };
  const deleteTheme = (theme: ThemeVersionSummary) => {
    if (!window.confirm(t("themes.deleteConfirm", {
      id: theme.id,
      packageId: theme.packageId,
      version: theme.version,
    }))) return;
    run(async () => {
      await requestJson(ADMIN_URLS.ajaxTheme(theme.id), {method: "DELETE"});
      window.location.reload();
    });
  };
  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value);
    showToast(t("themes.copied"), "success");
  };
  const previewTheme = (theme: ThemeVersionSummary) => setPreview({
    description: theme.manifest.description,
    hasPreviewFixture: Boolean(theme.manifest.previewFixture),
    label: `${theme.name} ${theme.version}`,
    supportsPagesAndSearch: theme.manifest.formatVersion === 2,
    url: ADMIN_URLS.ajaxThemePreview(theme.id),
  });
  const openTab = (next: ThemeAdminTab) => {
    setPage(1);
    setTab(next);
  };
  const tabKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    current: ThemeAdminTab,
  ) => {
    let next: ThemeAdminTab | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      next = current === "built-in" ? "custom" : "built-in";
    } else if (event.key === "Home") {
      next = "built-in";
    } else if (event.key === "End") {
      next = "custom";
    }
    if (!next) return;
    event.preventDefault();
    openTab(next);
    document.getElementById(`${next}-theme-tab`)?.focus();
  };

  const builtInThemeWord = listing.counts.builtInThemes === 1 ? t("themes.theme") : t("themes.themes");
  const builtInVersionWord = listing.counts.builtInVersions === 1 ? t("themes.version") : t("themes.versions");
  const customVersionWord = listing.counts.customVersions === 1 ? t("themes.version") : t("themes.versions");

  const cardProps = {
    busy,
    copy,
    instanceName,
    onActivate: activate,
    onCreateVersion: createVersion,
    onDelete: deleteTheme,
    onPreview: previewTheme,
    siteUrl,
    state: listing.state,
  };

  return (
    <div className="grid gap-5">
      <p className="rounded-xl border bg-muted/30 p-4 text-sm text-muted-foreground">
        {t("themes.intro")}
      </p>
      <section className="rounded-[14px] border bg-card p-5 shadow-xs">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{t("themes.heading")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("themes.subheading")}
            </p>
          </div>
          <Button onClick={() => setInstallHelpOpen(true)} variant="outline">
            <CircleHelpIcon aria-hidden="true" />
            {t("themes.howToInstall")}
          </Button>
        </div>

        <div aria-label={t("themes.tablistAria")} className="mt-5 flex gap-2 border-b" role="tablist">
          <Button
            aria-controls="built-in-theme-panel"
            aria-selected={tab === "built-in"}
            className="rounded-b-none"
            id="built-in-theme-tab"
            onKeyDown={(event) => tabKeyDown(event, "built-in")}
            onClick={() => openTab("built-in")}
            role="tab"
            tabIndex={tab === "built-in" ? 0 : -1}
            variant={tab === "built-in" ? "default" : "ghost"}
          >
            {t("themes.builtInTab", {
              themeWord: builtInThemeWord,
              themes: listing.counts.builtInThemes,
              versionWord: builtInVersionWord,
              versions: listing.counts.builtInVersions,
            })}
          </Button>
          <Button
            aria-controls="custom-theme-panel"
            aria-selected={tab === "custom"}
            className="rounded-b-none"
            id="custom-theme-tab"
            onKeyDown={(event) => tabKeyDown(event, "custom")}
            onClick={() => openTab("custom")}
            role="tab"
            tabIndex={tab === "custom" ? 0 : -1}
            variant={tab === "custom" ? "default" : "ghost"}
          >
            {t("themes.customTab", {
              versionWord: customVersionWord,
              versions: listing.counts.customVersions,
            })}
          </Button>
        </div>

        {tab === "built-in" && (
          <div aria-labelledby="built-in-theme-tab" className="mt-5 grid gap-3" id="built-in-theme-panel" role="tabpanel">
            <p className="text-sm text-muted-foreground">
              {t("themes.builtInIntro")}
            </p>
            {listing.builtInGroups.length === 0 && (
              <div className="rounded-xl border border-dashed p-10 text-center">
                <h3 className="font-medium">{t("themes.noBuiltInTitle")}</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("themes.noBuiltInBody")}
                </p>
              </div>
            )}
            {listing.builtInGroups.map((group) => {
              const current = currentBuiltInVersion(group);
              const history = group.versions.filter(({id}) => id !== current.id);
              return (
                <VersionCard {...cardProps} builtIn builtInSource={group.source} currentVersion={group.currentVersion} key={group.packageId} theme={current}>
                  {history.length > 0 && (
                    <details className="mt-4 border-t pt-3">
                      <summary className="cursor-pointer text-sm font-medium text-muted-foreground">
                        {t("themes.versionHistory", {count: history.length})}
                      </summary>
                      <div className="mt-3 grid gap-3">
                        {history.map((theme) => (
                          <VersionCard {...cardProps} builtIn builtInSource={group.source} currentVersion={group.currentVersion} key={theme.id} theme={theme} />
                        ))}
                      </div>
                    </details>
                  )}
                </VersionCard>
              );
            })}
          </div>
        )}

        {tab === "custom" && (
          <div aria-labelledby="custom-theme-tab" className="mt-5 grid gap-5" id="custom-theme-panel" role="tabpanel">
            {listing.drafts.length > 0 && (
              <section className="rounded-xl border p-4">
                <div>
                  <h3 className="font-semibold">{t("themes.versionDrafts")}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t("themes.draftSlots", {limit: listing.limits.drafts, used: listing.drafts.length})}
                  </p>
                </div>
                <div className="mt-4 grid gap-3">
                  {listing.drafts.map((draft) => (
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4" key={draft.id}>
                      <div>
                        <div className="font-medium">{draft.name}</div>
                        <code className="text-xs text-muted-foreground">{draft.packageId}@{draft.version}</code>
                      </div>
                      <Button render={<a href={ADMIN_URLS.themeDraft(draft.id)} />} variant="outline">{t("themes.editDraft")}</Button>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section>
              <div>
                <h3 className="font-semibold">{t("themes.installedCustom")}</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("themes.customQuota", {limit: listing.limits.customInstalled, used: listing.counts.customVersions})}
                </p>
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_14rem]">
                <label className="relative">
                  <span className="sr-only">{t("themes.searchAria")}</span>
                  <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    className="pl-9"
                    maxLength={100}
                    onChange={(event) => {setQuery(event.target.value); setPage(1);}}
                    placeholder={t("themes.searchPlaceholder")}
                    type="search"
                    value={query}
                  />
                </label>
                <label>
                  <span className="sr-only">{t("themes.sortAria")}</span>
                  <select
                    className="h-10 w-full cursor-pointer rounded-[10px] border border-input bg-background px-3 text-sm"
                    onChange={(event) => {setSort(event.target.value as ThemeListSort); setPage(1);}}
                    value={sort}
                  >
                    <option value="status">{t("themes.sortStatus")}</option>
                    <option value="installed-desc">{t("themes.sortNewest")}</option>
                    <option value="installed-asc">{t("themes.sortOldest")}</option>
                    <option value="name-asc">{t("themes.sortNameAsc")}</option>
                    <option value="name-desc">{t("themes.sortNameDesc")}</option>
                  </select>
                </label>
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
                <p>{loading ? t("themes.updating") : (listing.pagination.total === 1 ? t("themes.resultOne", {count: listing.pagination.total}) : t("themes.resultOther", {count: listing.pagination.total}))}</p>
                {listing.pagination.totalPages > 0 && <p>{t("themes.pageOf", {page: listing.pagination.page, total: listing.pagination.totalPages})}</p>}
              </div>
              <div className="mt-4 grid gap-3">
                {listing.customThemes.length === 0 && (
                  <div className="rounded-xl border border-dashed p-10 text-center">
                    <h3 className="font-medium">{t("themes.noCustomTitle")}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t("themes.noCustomBody")}
                    </p>
                  </div>
                )}
                {listing.customThemes.map((theme) => <VersionCard {...cardProps} key={theme.id} theme={theme} />)}
              </div>
              {listing.pagination.totalPages > 1 && (
                <nav aria-label={t("themes.paginationAria")} className="mt-5 flex justify-between gap-3">
                  <Button disabled={loading || listing.pagination.page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} variant="outline">{t("themes.previous")}</Button>
                  <Button disabled={loading || listing.pagination.page >= listing.pagination.totalPages} onClick={() => setPage((value) => value + 1)} variant="outline">{t("themes.next")}</Button>
                </nav>
              )}
            </section>
          </div>
        )}
      </section>

      <ThemeInstallHelpDialog instanceName={instanceName} onOpenChange={setInstallHelpOpen} open={installHelpOpen} />

      {preview && (
        <ThemePreviewDialog
          description={preview.description}
          hasPreviewFixture={preview.hasPreviewFixture}
          label={preview.label}
          onOpenChange={(open) => {if (!open) setPreview(null);}}
          open
          previewUrl={preview.url}
          supportsPagesAndSearch={preview.supportsPagesAndSearch}
        />
      )}
    </div>
  );
}
