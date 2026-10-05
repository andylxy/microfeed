import {useCallback, useEffect, useRef, useState} from "react";

import {CloudUploadIcon} from "lucide-react";

import Requests from "@/client/requests";
import {formatAdminTimestamp} from "@/client/admin-date-format";
import FileUploader from "@/components/admin/shared/AdminFileUploader";

import {
  AdminCollectionError,
  AdminCollectionLoading,
} from "@/components/admin/shared/AdminCollectionState";
import AdminPagination, {
  paginate,
} from "@/components/admin/shared/AdminPagination";
import {Button} from "@/components/ui/button";
import {useTranslation} from "@/client/i18n";
import {
  APP_ROLLOUT_SCOPES,
  canForceRolloutScope,
  isCurrentDownloadTarget,
  normalizeRolloutTarget,
  DEFAULT_APP_VERSION_CONFIG,
  type AppRolloutRule,
  type AppRolloutScope,
  type AppVersionConfig,
  type UploadedApk,
} from "@/shared/AppDeviceVersion";
import {ADMIN_URLS, humanFileSize, randomHex} from "@/shared/StringUtils";

interface BoardResponse {
  config?: AppVersionConfig;
  rules?: AppRolloutRule[];
  error?: string;
}

interface Props {
  canManage?: boolean;
  itemsPerPage?: number;
}

/**
 * A rule being edited. New rows get a negative client-side id — saving replaces
 * the whole set (`saveRolloutRules` deletes and re-inserts), so the id never
 * travels to the server and only has to be unique inside this list.
 */
type DraftRule = Omit<AppRolloutRule, "id"> & {id: number};


/**
 * App version board (`/admin/app-versions/`). Edits the singleton
 * `ext_app_version` row (latest / minimum version, download URL, MD5, changelog)
 * and the `ext_app_rollout` grayscale rules that layer on top of the global
 * floor (spec §6.2 / §6.3, §11 phase two).
 *
 * ⚠️ Raising `min_version_code` force-upgrades every client below it (426) — the
 * new APK must already be downloadable at `downloadUrl` (spec §12 铁律). A rule
 * with `force` off is a *prompt*: it does not raise the hard floor, so it never
 * blocks content.
 */
export default function AppVersionsApp({canManage = false, itemsPerPage}: Props) {
  const {t} = useTranslation();
  const [config, setConfig] = useState<AppVersionConfig>(DEFAULT_APP_VERSION_CONFIG);
  // 仅用于「尚未保存」的草稿行；真实规则以数据库 id 为准。
  const draftId = useRef(-1);
  const [rules, setRules] = useState<DraftRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [rulesSaved, setRulesSaved] = useState(false);
  const [page, setPage] = useState(0);
  // APK 上传（走与「条目 → 媒体文件」同一条 R2 通道）
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  // 历史包（R2 里上传过的 APK）。R2 是唯一事实来源，不建表。
  const [apks, setApks] = useState<UploadedApk[]>([]);
  const [apksLoading, setApksLoading] = useState(true);
  const [apksError, setApksError] = useState<string | null>(null);
  const [busyApkKey, setBusyApkKey] = useState<string | null>(null);

  // 定义在 uploadApk 之前：上传成功后要刷新列表，而 useCallback 的依赖数组在渲染期求值，
  // 引用后面才声明的 const 会踩 TDZ。
  const loadApks = useCallback(async () => {
    setApksLoading(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxAppVersionsApks());
      const data = await response.json().catch(() => ({})) as {
        apks?: UploadedApk[];
        error?: string;
      };
      if (!response.ok) {
        throw new Error(data.error ?? t("appVersions.apkHistoryLoadFailed"));
      }
      setApks(Array.isArray(data.apks) ? data.apks : []);
      setApksError(null);
    } catch (loadError) {
      setApksError(
        loadError instanceof Error
          ? loadError.message
          : t("appVersions.apkHistoryLoadFailed"),
      );
    } finally {
      setApksLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadApks();
  }, [loadApks]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxAppVersions());
      const data = await response.json().catch(() => ({})) as BoardResponse;
      if (!response.ok) {
        throw new Error(data.error ?? t("appVersions.loadFailed"));
      }
      setConfig(data.config ?? DEFAULT_APP_VERSION_CONFIG);
      setRules(Array.isArray(data.rules) ? data.rules : []);
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : t("appVersions.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 上传 APK 到 R2，并把**下载地址与 MD5 自动填进表单**。
   *
   * 复用「条目 → 媒体文件」那条既有通道（`Requests.upload` → 取签名 URL → PUT 到
   * `/media-upload/<key>`），所以存储、鉴权、大小上限、公开 URL 规则与媒体文件完全一致，
   * 没有第二套上传实现。
   *
   * MD5 来自 R2 返回的 ETag —— 单段 PUT 的 ETag **就是内容的 MD5**（本地实测一致），
   * 因此不必再对几十 MB 的包算一遍哈希。
   *
   * 只填表单、**不自动保存**：抬高 `min_version_code` 会强制升级所有旧客户端（spec §12 铁律），
   * 必须由人看一眼再点保存。
   */
  const uploadApk = useCallback((file: File) => {
    setUploading(true);
    setUploadProgress(0);
    setUploadError(null);
    setUploadNote(null);
    // 命名沿用媒体通道的约定（`media/…`、`images/…`），前缀 `app/`；
    // 保留原文件名的可读部分，便于在 bucket 里辨认是哪个包。
    const base = (file.name.split(/[\\/]/).pop() ?? "app")
      .replace(/\.[^.]*$/u, "")
      .replace(/[^A-Za-z0-9._-]/gu, "_")
      .slice(0, 48) || "app";
    const objectKey = `app/${base}-${randomHex(8)}.apk`;
    // 两种失败（PUT 失败、取签名 URL 失败）对用户是同一件事，共用一个处理。
    const onUploadFailed = () => {
      setUploading(false);
      setUploadError(t("appVersions.uploadFailed"));
    };

    Requests.upload(
      file,
      objectKey,
      (percentage: number) => setUploadProgress(percentage),
      (mediaUrl: string, _buffer: unknown, etag: string | null) => {
        // `mediaUrl` 形如 `development/app/xxx.apk`（R2 对象键），
        // 公开地址 = 站点 `/media/<对象键>`。
        const publicPath = `/media/${mediaUrl}`;
        setConfig((prev) => ({
          ...prev,
          downloadUrl: new URL(publicPath, window.location.origin).toString(),
          // 服务端没回 MD5 时必须**清空**而不是沿用旧值：旧值属于上一个包，
          // 留着会与刚上传的包不匹配 → App 下载后 md5 校验失败（比留空更难查）。
          md5: etag ?? "",
        }));
        setUploading(false);
        setUploadProgress(1);
        setUploadNote(
          etag
            ? t("appVersions.uploadDone")
            : t("appVersions.uploadDoneNoMd5"),
        );
        // 新包要立刻出现在「历史包」里，否则用户以为没传上去。
        void loadApks();
      },
      onUploadFailed,
      onUploadFailed,
    );
  }, [loadApks, t]);

  /** 把某个历史包的地址与 MD5 填回表单（**不自动保存**，与上传后一致）。 */
  const reuseApk = useCallback((apk: UploadedApk) => {
    setConfig((prev) => ({
      ...prev,
      // 与上传后填的是同一种地址：站点 `/media/<对象键>`。
      downloadUrl: new URL(`/media/${apk.key}`, window.location.origin).toString(),
      md5: apk.md5,
    }));
    setUploadError(null);
    setUploadNote(t("appVersions.apkReused", {name: apk.name}));
  }, [t]);

  const removeApk = useCallback(async (apk: UploadedApk) => {
    if (!window.confirm(t("appVersions.apkDeleteConfirm", {name: apk.name}))) {
      return;
    }
    setBusyApkKey(apk.key);
    setApksError(null);
    try {
      const response = await fetch(ADMIN_URLS.ajaxAppVersionsApks(), {
        body: JSON.stringify({key: apk.key}),
        headers: {"content-type": "application/json"},
        method: "DELETE",
      });
      const data = await response.json().catch(() => ({})) as {error?: string};
      if (!response.ok) {
        throw new Error(data.error ?? t("appVersions.apkDeleteFailed"));
      }
      await loadApks();
    } catch (deleteError) {
      setApksError(
        deleteError instanceof Error
          ? deleteError.message
          : t("appVersions.apkDeleteFailed"),
      );
    } finally {
      setBusyApkKey(null);
    }
  }, [loadApks, t]);

  const saveConfig = useCallback(async () => {
    setBusy(true);
    setFormError(null);
    setSaved(false);
    try {
      const response = await fetch(ADMIN_URLS.ajaxAppVersionsSave(), {
        body: JSON.stringify({config}),
        headers: {"content-type": "application/json"},
        method: "POST",
      });
      if (!response.ok) {
        // 只在失败时解析 body，并把服务端给出的原因原样带出去；解析不出来就让它抛，
        // 由下面的 catch 统一兜住——不静默吞成空对象（AGENTS.md 行为：不 fallback）。
        const data = (await response.json()) as {error?: string};
        throw new Error(data.error ?? t("appVersions.saveFailed"));
      }
      setSaved(true);
      await load();
    } catch (saveError) {
      setFormError(
        saveError instanceof Error
          ? saveError.message
          : t("appVersions.saveFailed"),
      );
    } finally {
      setBusy(false);
    }
  }, [config, load, t]);

  const patchRule = useCallback((id: number, patch: Partial<DraftRule>) => {
    setRules((prev) =>
      prev.map((rule) => (rule.id === id ? {...rule, ...patch} : rule)),
    );
    setRulesSaved(false);
  }, []);

  const addRule = useCallback(() => {
    setRules((prev) => [
      ...prev,
      {
        force: true,
        // 未入库的行用组件内递减的负数 id 临时标识；放在模块级会让多个实例共享计数器，
        // 且热重载后并不稳定（与旧注释的说法相反）。
        id: draftId.current--,
        minVersionCode: 0,
        scope: "all" as AppRolloutScope,
        target: null,
      },
    ]);
    setRulesSaved(false);
  }, []);

  const removeRule = useCallback((id: number) => {
    setRules((prev) => prev.filter((rule) => rule.id !== id));
    setRulesSaved(false);
  }, []);

  /**
   * 发送前先归一化并校验。服务端也会校验（返回 400），但为了「百分比必须在 0–100」
   * 走一趟网络，体验上更差。归一化规则复用 `normalizeRolloutTarget` —— 与服务端
   * 同一份实现，避免两边规则漂移。
   */
  const saveRules = useCallback(async () => {
    const normalised: Array<Omit<AppRolloutRule, "id">> = [];
    for (const rule of rules) {
      const target = normalizeRolloutTarget(rule.scope, rule.target);
      if (!target.ok) {
        setRulesError(t("appVersions.invalidRule"));
        return;
      }
      normalised.push({
        force: rule.force,
        minVersionCode: rule.minVersionCode,
        scope: rule.scope,
        target: target.value,
      });
    }

    setBusy(true);
    setRulesError(null);
    setRulesSaved(false);
    try {
      const response = await fetch(ADMIN_URLS.ajaxAppVersionsSave(), {
        body: JSON.stringify({rules: normalised}),
        headers: {"content-type": "application/json"},
        method: "POST",
      });
      if (!response.ok) {
        // 只在失败时解析 body，并把服务端给出的原因原样带出去；解析不出来就让它抛，
        // 由下面的 catch 统一兜住——不静默吞成空对象（AGENTS.md 行为：不 fallback）。
        const data = (await response.json()) as {error?: string};
        throw new Error(data.error ?? t("appVersions.saveFailed"));
      }
      setRulesSaved(true);
      await load();
    } catch (rulesSaveError) {
      setRulesError(
        rulesSaveError instanceof Error
          ? rulesSaveError.message
          : t("appVersions.saveFailed"),
      );
    } finally {
      setBusy(false);
    }
  }, [load, rules, t]);

  // Client-side paging over the rollout table, size sourced from
  // Settings → Items "每页条目数" (webGlobalSettings.itemsPerPage).
  const {
    pageRows: pageRules,
    safePage,
    totalPages,
  } = paginate(rules, itemsPerPage, page);

  /** Rollout scopes are an enum on the wire; never render the raw value. */
  const scopeLabel = (scope: string): string => {
    switch (scope) {
      case "all":
        return t("appVersions.scopeAll");
      case "user":
        return t("appVersions.scopeUser");
      case "device":
        return t("appVersions.scopeDevice");
      case "percent":
        return t("appVersions.scopePercent");
      default:
        // A scope a newer server knows and this build does not: show it raw
        // rather than blank, so the operator can still see what is configured.
        return scope;
    }
  };

  const numberField = (
    label: string,
    key: "latestVersionCode" | "minVersionCode",
  ) => (
    <label className="grid gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <input
        className="rounded-md border bg-background px-3 py-2 text-sm"
        disabled={!canManage}
        min={0}
        onChange={(event) =>
          setConfig((prev) => ({
            ...prev,
            [key]: Number.parseInt(event.target.value, 10) || 0,
          }))}
        type="number"
        value={config[key]}
      />
    </label>
  );

  const textField = (
    label: string,
    key: "latestVersionName" | "downloadUrl" | "md5",
  ) => (
    <label className="grid gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <input
        className="rounded-md border bg-background px-3 py-2 text-sm"
        disabled={!canManage}
        onChange={(event) =>
          setConfig((prev) => ({...prev, [key]: event.target.value}))}
        value={config[key]}
      />
    </label>
  );

  if (loading) {
    return <AdminCollectionLoading label={t("appVersions.title")} />;
  }

  if (error) {
    return <AdminCollectionError message={error} retry={() => void load()} />;
  }

  return (
    <div className="grid gap-5">
      <div>
        <h1 className="text-xl font-semibold">{t("appVersions.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("appVersions.intro")}
        </p>
      </div>

      <section className="grid gap-3 rounded-[14px] border bg-card p-4 shadow-xs">
        <div className="grid gap-3 md:grid-cols-2">
          {textField(t("appVersions.latestVersion"), "latestVersionName")}
          {numberField(t("appVersions.latestVersionCode"), "latestVersionCode")}
          {numberField(t("appVersions.minVersion"), "minVersionCode")}
          {textField(t("appVersions.downloadUrl"), "downloadUrl")}
          {textField(t("appVersions.md5"), "md5")}
        </div>
        {/* APK 上传：与「条目 → 媒体文件」用**同一套**上传件（`lh-upload-wrapper` +
            `lh-upload-box`，见 MediaManager / AdminImageUploaderApp），所以外观与交互跟其他页面一致；
            盒子按内容撑开，不占满整行。上传后自动填下载地址与 MD5。
            只填表单、不自动保存 —— 抬高地板会强制升级所有旧客户端（spec §12 铁律）。 */}
        <div className="grid gap-2">
          <div className="lh-upload-wrapper">
            <FileUploader
              classes="lh-upload-fileinput"
              disabled={!canManage || uploading}
              handleChange={uploadApk}
              name="apkUploader"
              // 拖/选到非 .apk 时给一句提示：否则既不上传也没反馈，看起来像控件坏了。
              onRejected={() => {
                setUploadNote(null);
                setUploadError(t("appVersions.uploadWrongType"));
              }}
              types={["apk"]}
            >
              {/* 尺寸刻意给足：`w-72 h-24`（288×96）—— 翻倍了原来的投放区，
                  同时 `h-24` 与「媒体文件」页那个上传盒同高，视觉上是一套。
                  显式定尺寸而不是靠 padding 撑：padding 撑不出确定的投放面积。 */}
              <div className="lh-upload-box inline-flex h-24 w-72 items-center justify-center gap-2 text-sm text-brand-light">
                <CloudUploadIcon className="w-4" />
                <span>
                  {uploading
                    ? t("appVersions.uploading", {
                      percent: Math.round(uploadProgress * 100),
                    })
                    : t("appVersions.chooseApk")}
                </span>
              </div>
            </FileUploader>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("appVersions.uploadHint")}
          </p>
          {uploadError && (
            <p className="text-xs text-destructive">{uploadError}</p>
          )}
          {uploadNote && (
            <p className="text-xs text-muted-foreground">{uploadNote}</p>
          )}
        </div>
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">
            {t("appVersions.updateLog")}
          </span>
          <textarea
            className="min-h-24 rounded-md border bg-background px-3 py-2 text-sm"
            disabled={!canManage}
            onChange={(event) =>
              setConfig((prev) => ({...prev, updateLog: event.target.value}))}
            value={config.updateLog}
          />
        </label>
        {formError && <p className="text-xs text-destructive">{formError}</p>}
        <div className="flex items-center gap-3">
          <Button
            disabled={!canManage || busy}
            onClick={() => void saveConfig()}
            size="sm"
            type="button"
          >
            {t("appVersions.save")}
          </Button>
          {saved && (
            <span className="text-xs text-muted-foreground">
              {t("appVersions.saved")}
            </span>
          )}
        </div>
      </section>

      {/* 历史包：R2 里上传过的 APK。R2 是唯一事实来源（不建表），
          「当前在用」由 `downloadUrl` 比对得出（`isCurrentDownloadTarget`，两端同一份实现）。 */}
      <section className="overflow-hidden rounded-[14px] border bg-card shadow-xs">
        <header className="border-b bg-muted/40 px-4 py-2">
          <h2 className="text-sm font-medium">{t("appVersions.apkHistory")}</h2>
        </header>
        {apksError && (
          <p className="px-4 py-3 text-xs text-destructive">{apksError}</p>
        )}
        {apks.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            {apksLoading
              ? t("appVersions.apkHistoryLoading")
              : t("appVersions.apkHistoryEmpty")}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">
                  {t("appVersions.apkName")}
                </th>
                <th className="px-4 py-2 font-medium">
                  {t("appVersions.apkSize")}
                </th>
                <th className="px-4 py-2 font-medium">
                  {t("appVersions.apkUploadedAt")}
                </th>
                <th className="px-4 py-2 font-medium">
                  {t("appVersions.md5")}
                </th>
                <th className="px-4 py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {apks.map((apk) => {
                const inUse = isCurrentDownloadTarget(config.downloadUrl, apk.key);
                return (
                  <tr key={apk.key} className={inUse ? "bg-muted/40" : undefined}>
                    <td className="px-4 py-2">
                      <span className="font-mono text-xs">{apk.name}</span>
                      {inUse && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {t("appVersions.apkInUse")}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {humanFileSize(apk.size)}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {formatAdminTimestamp(apk.uploadedAt)}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">
                      {apk.md5.slice(0, 8)}…
                    </td>
                    <td className="px-4 py-2">
                      {canManage && (
                        <div className="flex justify-end gap-1">
                          <Button
                            disabled={busyApkKey === apk.key}
                            onClick={() => reuseApk(apk)}
                            size="sm"
                            type="button"
                            variant="ghost"
                          >
                            {t("appVersions.apkReuse")}
                          </Button>
                          <Button
                            disabled={busyApkKey === apk.key || inUse}
                            onClick={() => void removeApk(apk)}
                            size="sm"
                            title={inUse
                              ? t("appVersions.apkDeleteBlocked")
                              : undefined}
                            type="button"
                            variant="ghost"
                          >
                            {t("appVersions.apkDelete")}
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="overflow-hidden rounded-[14px] border bg-card shadow-xs">
        <header className="flex items-center justify-between border-b bg-muted/40 px-4 py-2">
          <h2 className="text-sm font-medium">
            {t("appVersions.rolloutRules")}
          </h2>
          {canManage && (
            <Button onClick={addRule} size="sm" type="button" variant="ghost">
              {t("appVersions.addRule")}
            </Button>
          )}
        </header>
        {rules.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            {t("appVersions.rulesEmpty")}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">
                  {t("appVersions.scope")}
                </th>
                <th className="px-4 py-2 font-medium">
                  {t("appVersions.target")}
                </th>
                <th className="px-4 py-2 font-medium">
                  {t("appVersions.minVersion")}
                </th>
                <th className="px-4 py-2 font-medium">
                  {t("appVersions.force")}
                </th>
                <th className="px-4 py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {pageRules.map((rule) => (
                <tr key={rule.id}>
                  <td className="px-4 py-2">
                    <select
                      className="rounded-md border bg-background px-2 py-1 text-sm"
                      disabled={!canManage}
                      onChange={(event) => {
                        const scope = event.target.value as AppRolloutScope;
                        // `all` carries no target; switching to it must clear
                        // whatever was there, or the saved row keeps a
                        // meaningless target.
                        const next = {scope, target: scope === "all" ? null : rule.target};
                        // 切到不支持强制的 scope 时把 force 归位：否则这条规则带着
                        // 非法组合走到保存，才被服务端拒 400（票据 23）。
                        if (!canForceRolloutScope(scope) && rule.force) {
                          patchRule(rule.id, {...next, force: false});
                          return;
                        }
                        patchRule(rule.id, next);
                      }}
                      value={rule.scope}
                    >
                      {APP_ROLLOUT_SCOPES.map((scope) => (
                        <option key={scope} value={scope}>
                          {scopeLabel(scope)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-2">
                    <input
                      className="w-full rounded-md border bg-background px-2 py-1 font-mono text-xs disabled:opacity-50"
                      disabled={!canManage || rule.scope === "all"}
                      onChange={(event) =>
                        patchRule(rule.id, {target: event.target.value})}
                      placeholder={t("appVersions.targetPlaceholder")}
                      value={rule.target ?? ""}
                    />
                  </td>
                  <td className="px-4 py-2">
                    <input
                      className="w-24 rounded-md border bg-background px-2 py-1 text-sm"
                      disabled={!canManage}
                      min={0}
                      onChange={(event) => {
                        // 清空输入时 parseInt 得到 NaN，显式回落 0，
                        // 而不是靠 `|| 0` 兜（AGENTS.md 行为：不静默 fallback）。
                        const next = Number.parseInt(event.target.value, 10);
                        patchRule(rule.id, {
                          minVersionCode: Number.isNaN(next) ? 0 : next,
                        });
                      }}
                      type="number"
                      value={rule.minVersionCode}
                    />
                  </td>
                  <td className="px-4 py-2">
                    <select
                      className="rounded-md border bg-background px-2 py-1 text-sm"
                      disabled={!canManage || !canForceRolloutScope(rule.scope)}
                      onChange={(event) =>
                        patchRule(rule.id, {
                          force: event.target.value === "1",
                        })}
                      title={
                        canForceRolloutScope(rule.scope)
                          ? undefined
                          : t("appVersions.forceUnsupportedScope")
                      }
                      value={rule.force ? "1" : "0"}
                    >
                      <option value="1">{t("appVersions.forceYes")}</option>
                      <option value="0">{t("appVersions.forceNo")}</option>
                    </select>
                    {!canForceRolloutScope(rule.scope) && (
                      <p className="mt-1 max-w-40 text-xs text-muted-foreground">
                        {t("appVersions.forceUnsupportedScope")}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {canManage && (
                      <Button
                        onClick={() => removeRule(rule.id)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        {t("appVersions.removeRule")}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {canManage && (
          <div className="flex items-center gap-3 border-t px-4 py-3">
            <Button
              disabled={busy}
              onClick={() => void saveRules()}
              size="sm"
              type="button"
            >
              {t("appVersions.saveRules")}
            </Button>
            {rulesSaved && (
              <span className="text-xs text-muted-foreground">
                {t("appVersions.rulesSaved")}
              </span>
            )}
            {rulesError && (
              <span className="text-xs text-destructive">{rulesError}</span>
            )}
          </div>
        )}
      </section>

      {rules.length > 0 && (
        <AdminPagination
          onChange={setPage}
          page={safePage}
          totalPages={totalPages}
        />
      )}
    </div>
  );
}
