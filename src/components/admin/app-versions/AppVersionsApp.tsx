import {useCallback, useEffect, useRef, useState} from "react";

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
  normalizeRolloutTarget,
  DEFAULT_APP_VERSION_CONFIG,
  type AppRolloutRule,
  type AppRolloutScope,
  type AppVersionConfig,
} from "@/shared/AppDeviceVersion";
import {ADMIN_URLS} from "@/shared/StringUtils";

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
                        patchRule(rule.id, {
                          scope,
                          target: scope === "all" ? null : rule.target,
                        });
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
                      disabled={!canManage}
                      onChange={(event) =>
                        patchRule(rule.id, {
                          force: event.target.value === "1",
                        })}
                      value={rule.force ? "1" : "0"}
                    >
                      <option value="1">{t("appVersions.forceYes")}</option>
                      <option value="0">{t("appVersions.forceNo")}</option>
                    </select>
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
