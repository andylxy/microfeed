import {useCallback, useEffect, useMemo, useState} from "react";

import {formatAdminDateTime} from "@/client/admin-date-format";
import {useTranslation} from "@/client/i18n";
import {
  AdminCollectionError,
  AdminCollectionLoading,
} from "@/components/admin/shared/AdminCollectionState";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Switch} from "@/components/ui/switch";
import {
  APP_CACHE_BUCKETS,
  APP_CACHE_TTL_RANGES,
  APP_CACHE_TTL_TIERS,
  MAX_MAX_ENTRY_BYTES,
  MIN_MAX_ENTRY_BYTES,
  PURGE_DAILY_MAX,
  PURGE_MIN_INTERVAL_MS,
  TTL_TIER_OF,
  type AppCacheBucket,
  type AppCacheControl,
  type AppCacheTtlTier,
} from "@/shared/AppCacheControl";
import {ADMIN_URLS} from "@/shared/StringUtils";

interface BoardResponse {
  control?: AppCacheControl;
  error?: string;
}

type PurgeScope = AppCacheBucket | "all";

/** 桶名 → i18n 文案键。桶名带连字符，i18n 用驼峰。 */
const BUCKET_LABEL_KEY: Record<AppCacheBucket, string> = {
  nav: "appCache.bucket.nav",
  chapters: "appCache.bucket.chapters",
  content: "appCache.bucket.content",
  fang: "appCache.bucket.fang",
  zhongyao: "appCache.bucket.zhongyao",
  aliases: "appCache.bucket.aliases",
  style: "appCache.bucket.style",
  identity: "appCache.bucket.identity",
  version: "appCache.bucket.version",
  "login-methods": "appCache.bucket.loginMethods",
};

const TIER_LABEL_KEY: Record<AppCacheTtlTier, string> = {
  nav: "appCache.tierNav",
  content: "appCache.tierContent",
  config: "appCache.tierConfig",
  rule: "appCache.tierRule",
};

/**
 * 清空该桶后重建全部条目所需的内容行读（方案 5.6，本机快照）。登录方式一行
 * 未计入 22,013 的合计，页面上照实标出来。
 */
const BUCKET_REBUILD_ROWS: Record<AppCacheBucket, number> = {
  nav: 20,
  chapters: 920,
  content: 17_026,
  fang: 1_618,
  zhongyao: 1_212,
  aliases: 1_104,
  style: 16,
  identity: 96,
  version: 1,
  "login-methods": 1,
};

function formatRows(value: number): string {
  return value.toLocaleString("en-US");
}

/** 本地 miniflare 不支持 purge；这条提示只在 localhost 打开的页面上显示。 */
const IS_LOCAL_DEV =
  typeof window !== "undefined" &&
  /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);

/** 只比较可编辑字段：清空计数变化不算「未保存的修改」。 */
function editableKey(control: AppCacheControl): string {
  return JSON.stringify({
    buckets: control.buckets,
    enabled: control.enabled,
    maxEntryBytes: control.maxEntryBytes,
    ttls: control.ttls,
  });
}

function numbersValid(control: AppCacheControl): boolean {
  const ttlsInRange = APP_CACHE_TTL_TIERS.every((tier) => {
    const value = control.ttls[tier];
    const range = APP_CACHE_TTL_RANGES[tier];
    return Number.isSafeInteger(value) && value >= range.min && value <= range.max;
  });
  return ttlsInRange
    && Number.isSafeInteger(control.maxEntryBytes)
    && control.maxEntryBytes >= MIN_MAX_ENTRY_BYTES
    && control.maxEntryBytes <= MAX_MAX_ENTRY_BYTES;
}

/**
 * App 缓存控制面（`/admin/cache/`，方案第 5 节）。一个表单页：总开关、四档
 * 缓存时间、按桶开关、单条体积上限，以及「清空全部」与「清空单个桶」。
 *
 * 清空走 `cache.purge({tags})`（服务端 `cache-purge.ts`）：跨机房一次生效。
 * 10 秒节流与 30 次/日上限在服务端判定，页面按返回的 429 显示原因；按钮在
 * 受理后本地禁用 10 秒，省掉必然被拒的重复点击。
 */
export default function AppCacheApp() {
  const {t} = useTranslation();
  const [control, setControl] = useState<AppCacheControl | null>(null);
  const [draft, setDraft] = useState<AppCacheControl | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [purging, setPurging] = useState<PurgeScope | null>(null);
  const [purgeNote, setPurgeNote] = useState<string | null>(null);
  const [purgeError, setPurgeError] = useState<string | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxCache());
      const data = await response.json().catch(() => ({})) as BoardResponse;
      if (!response.ok || !data.control) {
        throw new Error(data.error ?? t("appCache.loadFailed"));
      }
      setControl(data.control);
      setDraft(data.control);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("appCache.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [cooldownUntil]);

  const patchDraft = useCallback(
    (update: (current: AppCacheControl) => AppCacheControl) => {
      setDraft((current) => (current ? update(current) : current));
      setSaved(false);
      setSaveError(null);
    },
    [],
  );

  const dirty = useMemo(
    () => control !== null && draft !== null
      && editableKey(control) !== editableKey(draft),
    [control, draft],
  );

  const save = useCallback(async () => {
    if (!draft) return;
    if (!numbersValid(draft)) {
      setSaveError(t("appCache.invalidNumber"));
      return;
    }
    setBusy(true);
    setSaved(false);
    setSaveError(null);
    try {
      const response = await fetch(ADMIN_URLS.ajaxCacheSave(), {
        body: JSON.stringify({
          patch: {
            buckets: draft.buckets,
            enabled: draft.enabled,
            maxEntryBytes: draft.maxEntryBytes,
            ttls: draft.ttls,
          },
        }),
        headers: {"content-type": "application/json"},
        method: "POST",
      });
      const data = await response.json().catch(() => ({})) as BoardResponse;
      if (!response.ok || !data.control) {
        throw new Error(data.error ?? t("appCache.saveFailed"));
      }
      setControl(data.control);
      setDraft(data.control);
      setSaved(true);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : t("appCache.saveFailed"));
    } finally {
      setBusy(false);
    }
  }, [draft, t]);

  const purge = useCallback(async (scope: PurgeScope) => {
    setPurging(scope);
    setPurgeNote(null);
    setPurgeError(null);
    try {
      const response = await fetch(ADMIN_URLS.ajaxCachePurge(), {
        body: JSON.stringify({scope}),
        headers: {"content-type": "application/json"},
        method: "POST",
      });
      const data = await response.json().catch(() => ({})) as BoardResponse;
      if (!response.ok || !data.control) {
        throw new Error(data.error ?? t("appCache.purgeFailed"));
      }
      const next = data.control;
      setControl(next);
      setDraft((current) => current
        ? {
            ...current,
            lastPurgedAtMs: next.lastPurgedAtMs,
            purgedOnDay: next.purgedOnDay,
            purgedToday: next.purgedToday,
          }
        : next);
      setPurgeNote(t("appCache.purgeAccepted"));
      setCooldownUntil(Date.now() + PURGE_MIN_INTERVAL_MS);
      setNowMs(Date.now());
    } catch (cause) {
      setPurgeError(cause instanceof Error ? cause.message : t("appCache.purgeFailed"));
    } finally {
      setPurging(null);
    }
  }, [t]);

  if (loading) {
    return <AdminCollectionLoading label={t("appCache.title")} />;
  }
  if (error || !control || !draft) {
    return (
      <AdminCollectionError
        message={error ?? t("appCache.loadFailed")}
        retry={() => void load()}
      />
    );
  }

  const cooldownSeconds = Math.max(
    0,
    Math.ceil((cooldownUntil - nowMs) / 1_000),
  );
  const purgeLocked = purging !== null || cooldownSeconds > 0;
  const todayKey = new Date(nowMs).toISOString().slice(0, 10);
  const purgedToday = control.purgedOnDay === todayKey ? control.purgedToday : 0;

  const numberValue = (value: number): number | "" =>
    Number.isFinite(value) ? value : "";

  const parseNumber = (raw: string): number => {
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) ? Number.NaN : parsed;
  };

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">{t("appCache.intro")}</p>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">{t("appCache.masterTitle")}</h2>
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={draft.enabled}
            onCheckedChange={(checked) =>
              patchDraft((current) => ({...current, enabled: checked}))}
          />
          <span>{t("appCache.masterLabel")}</span>
        </label>
        <p className="text-xs text-muted-foreground">{t("appCache.masterHint")}</p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">{t("appCache.ttlTitle")}</h2>
        <p className="text-xs text-muted-foreground">{t("appCache.ttlHint")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {APP_CACHE_TTL_TIERS.map((tier) => {
            const range = APP_CACHE_TTL_RANGES[tier];
            return (
              <label className="grid gap-1 text-sm" key={tier}>
                <span>{t(TIER_LABEL_KEY[tier])}</span>
                <div className="flex items-center gap-2">
                  <Input
                    className="w-32"
                    max={range.max}
                    min={range.min}
                    onChange={(event) =>
                      patchDraft((current) => ({
                        ...current,
                        ttls: {
                          ...current.ttls,
                          [tier]: parseNumber(event.target.value),
                        },
                      }))}
                    type="number"
                    value={numberValue(draft.ttls[tier])}
                  />
                  <span className="text-xs text-muted-foreground">
                    {t("appCache.ttlSeconds")}
                    {" · "}
                    {t("appCache.tierRange", {
                      max: String(range.max),
                      min: String(range.min),
                    })}
                  </span>
                </div>
              </label>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">{t("appCache.bucketsTitle")}</h2>
        <p className="text-xs text-muted-foreground">{t("appCache.bucketsHint")}</p>
        <div className="flex flex-col divide-y rounded-md border">
          {APP_CACHE_BUCKETS.map((bucket) => (
            <div
              className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm"
              key={bucket}
            >
              <Switch
                checked={draft.buckets[bucket]}
                onCheckedChange={(checked) =>
                  patchDraft((current) => ({
                    ...current,
                    buckets: {...current.buckets, [bucket]: checked},
                  }))}
              />
              <span className="min-w-28">{t(BUCKET_LABEL_KEY[bucket])}</span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {t("appCache.bucketTier", {tier: TTL_TIER_OF[bucket]})}
              </span>
              <span className="text-xs text-muted-foreground">
                {t("appCache.bucketRebuild", {
                  rows: formatRows(BUCKET_REBUILD_ROWS[bucket]),
                })}
                {bucket === "login-methods"
                  ? ` · ${t("appCache.bucketNotCounted")}`
                  : null}
              </span>
              <Button
                className="ml-auto"
                disabled={purgeLocked}
                onClick={() => void purge(bucket)}
                size="sm"
                type="button"
                variant="outline"
              >
                {t("appCache.purgeBucket")}
              </Button>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">{t("appCache.maxEntryTitle")}</h2>
        <label className="grid gap-1 text-sm">
          <span>{t("appCache.maxEntryLabel")}</span>
          <Input
            className="w-48"
            max={MAX_MAX_ENTRY_BYTES}
            min={MIN_MAX_ENTRY_BYTES}
            onChange={(event) =>
              patchDraft((current) => ({
                ...current,
                maxEntryBytes: parseNumber(event.target.value),
              }))}
            type="number"
            value={numberValue(draft.maxEntryBytes)}
          />
        </label>
        <p className="text-xs text-muted-foreground">{t("appCache.maxEntryHint")}</p>
      </section>

      <div className="flex items-center gap-3">
        <Button
          disabled={busy || !dirty}
          onClick={() => void save()}
          type="button"
        >
          {t("appCache.save")}
        </Button>
        {saved ? (
          <span className="text-sm text-muted-foreground">{t("appCache.saved")}</span>
        ) : null}
        {saveError ? (
          <span className="text-sm text-destructive">{saveError}</span>
        ) : null}
      </div>

      <section className="flex flex-col gap-2 border-t pt-4">
        <h2 className="text-sm font-medium">{t("appCache.purgeTitle")}</h2>
        <p className="text-xs text-muted-foreground">{t("appCache.purgeHint")}</p>
        <p className="text-xs text-muted-foreground">
          {t("appCache.lastPurged")}
          {control.lastPurgedAtMs > 0
            ? formatAdminDateTime(control.lastPurgedAtMs)
            : t("appCache.neverPurged")}
          {" · "}
          {t("appCache.purgeBudget", {
            max: String(PURGE_DAILY_MAX),
            used: String(purgedToday),
          })}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={purgeLocked}
            onClick={() => void purge("all")}
            type="button"
            variant="destructive"
          >
            {t("appCache.purgeAll")}
          </Button>
          {cooldownSeconds > 0 ? (
            <span className="text-sm text-muted-foreground">
              {t("appCache.cooldown", {seconds: String(cooldownSeconds)})}
            </span>
          ) : null}
          {purgeNote ? (
            <span className="text-sm text-muted-foreground">{purgeNote}</span>
          ) : null}
          {purgeError ? (
            <span className="text-sm text-destructive">{purgeError}</span>
          ) : null}
        </div>
        {purgeError && IS_LOCAL_DEV ? (
          <p className="text-xs text-muted-foreground">
            {t("appCache.purgeUnavailable")}
          </p>
        ) : null}
      </section>
    </div>
  );
}
