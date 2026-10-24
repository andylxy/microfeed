import {useCallback, useEffect, useState} from "react";

import {Button} from "@/components/ui/button";
import {useTranslation} from "@/client/i18n";
import AdminMarkdownEditor from "@/components/admin/shared/AdminMarkdownEditor";
import {
  AdminCollectionError,
  AdminCollectionLoading,
} from "@/components/admin/shared/AdminCollectionState";
import {ADMIN_URLS} from "@/shared/StringUtils";

/** App 端契约的槽位条目（`ext_app_about_info` 行形状）。 */
interface AboutInfoEntry {
  name: string;
  text: string;
}

interface BoardResponse {
  entries?: AboutInfoEntry[];
  error?: string;
}

interface Props {
  canManage?: boolean;
}

/** App 端 AboutActivity 固定分发的 4 个槽位（顺序即页面展示顺序）。 */
const SLOTS = [
  {name: "about_thks", labelKey: "appAbout.slotThks"},
  {name: "about_manual", labelKey: "appAbout.slotManual"},
  {name: "about_bookname", labelKey: "appAbout.slotBookname"},
  {name: "app_updata_log", labelKey: "appAbout.slotUpdatelog"},
] as const;

/**
 * App 关于页内容板（`/admin/app-about/`）。编辑 `ext_app_about_info` 的 4 个
 * 固定槽位，App 端 `AboutActivity` 按 `name` 分发渲染。
 *
 * ⚠️ 内容**逐字存取**（ADR-0029 存取约定，与条文注文同款）：App 渲染的是它
 * 自己的 `$x{…}` 标记，**分行就是真换行**（敲回车即可，不是旧后端的 `|`，
 * 存量 `|` 已由 migration 0146 转成 LF）——编辑器只是输入面板，保存时原文
 * 直存，服务端不做任何转换。
 */
export default function AppAboutApp({canManage = false}: Props) {
  const {t} = useTranslation();
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxAppAbout());
      const data = await response.json().catch(() => ({})) as BoardResponse;
      if (!response.ok) {
        throw new Error(data.error ?? t("appAbout.loadFailed"));
      }
      const next: Record<string, string> = {};
      for (const entry of Array.isArray(data.entries) ? data.entries : []) {
        if (entry && typeof entry.name === "string") {
          next[entry.name] = typeof entry.text === "string" ? entry.text : "";
        }
      }
      setTexts(next);
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : t("appAbout.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    setBusy(true);
    setSaveError(null);
    setSaved(false);
    try {
      // 整表同步：只提交已填写内容的槽位；空槽位不提交 = 该行被删，
      // App 侧拿不到该条目就保持自己的默认展示（与旧后端「未配置不返回」一致）。
      const entries: AboutInfoEntry[] = SLOTS
        .map(({name}) => ({name, text: texts[name] ?? ""}))
        .filter((entry) => entry.text !== "");
      const response = await fetch(ADMIN_URLS.ajaxAppAboutSave(), {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({entries}),
      });
      const data = await response.json().catch(() => ({})) as {error?: string};
      if (!response.ok) {
        throw new Error(data.error ?? t("appAbout.saveFailed"));
      }
      setSaved(true);
    } catch (saveError) {
      setSaveError(
        saveError instanceof Error ? saveError.message : t("appAbout.saveFailed"),
      );
    } finally {
      setBusy(false);
    }
  }, [texts, t]);

  if (loading) {
    return <AdminCollectionLoading label={t("appAbout.title")} />;
  }
  if (error) {
    return <AdminCollectionError message={error} retry={() => void load()} />;
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">{t("appAbout.intro")}</p>
      {SLOTS.map(({name, labelKey}) => (
        <div key={name} className="rounded-lg border p-4">
          <div className="mb-2 font-semibold">{t(labelKey)}</div>
          <div className="mb-2 font-mono text-xs text-muted-foreground">{name}</div>
          <AdminMarkdownEditor
            hint={t("appAbout.slotHint")}
            placeholder=""
            value={texts[name] ?? ""}
            onChange={(value: string) => {
              setSaved(false);
              setTexts((previous) => ({...previous, [name]: value}));
            }}
          />
        </div>
      ))}
      {canManage && (
        <div className="flex items-center gap-3">
          <Button type="button" onClick={save} disabled={busy}>
            {t("appAbout.save")}
          </Button>
          {saved && <span className="text-sm text-green-600">{t("appAbout.saved")}</span>}
          {saveError && <span className="text-sm text-red-600">{saveError}</span>}
        </div>
      )}
    </div>
  );
}
