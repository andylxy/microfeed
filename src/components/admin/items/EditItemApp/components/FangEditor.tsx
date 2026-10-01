import {useCallback, useEffect, useState} from "react";
import {PlusIcon, Trash2Icon} from "lucide-react";

import {useTranslation} from "@/client/i18n";
import Requests from "@/client/requests";
import AdminInput from "@/components/admin/shared/AdminInput";
import AdminSelect, {
  type AdminSelectOption,
} from "@/components/admin/shared/AdminSelect";
import {Button} from "@/components/ui/button";
import {ADMIN_URLS} from "@/shared/StringUtils";
import type {FangYaoEntry} from "@/shared/ExtVolume";

interface Props {
  /** The item's current `_microfeed.fangYaoList`. */
  value: FangYaoEntry[];
  /** Write a complete new list back into the item's `_microfeed`. */
  onChange: (next: FangYaoEntry[]) => void;
  /** The fang item's own title, used to find the 条文 that cite it. */
  fangName: string;
  /** Whether a save can currently run (mirrors the editor's autosave phase). */
  disabled?: boolean;
}

interface FangReference {
  id: string;
  title: string;
  status: number;
}

const MAX_SUMMARY_YAOS = 300;

function emptyEntry(): FangYaoEntry {
  return {yaoId: ""};
}

/**
 * 方剂专用组成编辑器：把 `_microfeed.fangYaoList` 渲染成可编辑的「药味」表格。
 *
 * 通用条目编辑器只编辑标题/正文，改不了 JSON 口袋里的结构化组成；这个组件把
 * 每一行绑到 fangYaoList 的一项，选择药名即写入 yaoId（中药条目 11 位 id），
 * 保存经 EditItemApp 的 onUpdateItemMicrofeedMeta 合并回口袋，其余字段
 * （sourceBookId / no / yaoCount …）不受影响。
 */
export default function FangEditor({
  disabled = false,
  fangName,
  onChange,
  value,
}: Props) {
  const {t} = useTranslation();
  const [yaoOptions, setYaoOptions] = useState<AdminSelectOption[]>([]);
  const [references, setReferences] = useState<FangReference[] | null>(null);
  const [referencesError, setReferencesError] = useState(false);

  // 中药选择器数据源：挂在本草容器频道下的 yao 条目（tcm_kind='yao'），
  // 走 admin 条目列表接口，一次拉全量（上限 300 ≥ 当前 172 味）。
  useEffect(() => {
    let cancelled = false;
    const url = new URL(ADMIN_URLS.ajaxItems(), window.location.origin);
    url.searchParams.set("tcmKind", "yao");
    url.searchParams.set("limit", String(MAX_SUMMARY_YAOS));
    Requests.axiosGet(url.toString())
      .then((res: any) => {
        if (cancelled) return;
        const items = Array.isArray(res?.data?.items) ? res.data.items : [];
        setYaoOptions(items
          .filter((item: any) => typeof item?.id === "string")
          .map((item: any) => ({
            label: String(item.title ?? item.id),
            value: item.id,
          })));
      })
      .catch(() => {
        if (!cancelled) setYaoOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 反向引用：查引用了此方剂的条文（section 的 `_microfeed.fangList` 或正文
  // `$f{…}` 标记含方剂名），作为方剂与条文互链的回看视图。
  const loadReferences = useCallback(() => {
    if (!fangName) return;
    setReferences(null);
    setReferencesError(false);
    const url = new URL(
      ADMIN_URLS.ajaxTcmFangReferences(),
      window.location.origin,
    );
    url.searchParams.set("name", fangName);
    Requests.axiosGet(url.toString())
      .then((res: any) => {
        setReferences(Array.isArray(res?.data?.items) ? res.data.items : []);
      })
      .catch(() => setReferencesError(true));
  }, [fangName]);

  useEffect(() => {
    loadReferences();
  }, [loadReferences]);

  const updateEntry = (index: number, patch: Partial<FangYaoEntry>) => {
    const next = value.map((entry, i) => i === index ? {...entry, ...patch} : entry);
    onChange(next);
  };

  const removeEntry = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
  };

  const addEntry = () => {
    onChange([...value, emptyEntry()]);
  };

  const yaoLabel = (entry: FangYaoEntry): AdminSelectOption | null => {
    if (!entry.yaoId) return null;
    const found = yaoOptions.find((option) => option.value === entry.yaoId);
    return found ?? {label: entry.showName || entry.yaoId, value: entry.yaoId};
  };

  return (
    <div className="rounded-[14px] border bg-card p-5 text-card-foreground shadow-xs">
      <h2 className="text-lg font-semibold">{t("items.fangEditorTitle")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("items.fangEditorIntro")}
      </p>

      <div className="mt-5 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="min-w-44 px-2 py-2 font-medium">{t("items.fangYaoName")}</th>
              <th className="w-24 px-2 py-2 font-medium">{t("items.fangYaoAmount")}</th>
              <th className="w-20 px-2 py-2 font-medium">{t("items.fangYaoWeight")}</th>
              <th className="min-w-28 px-2 py-2 font-medium">{t("items.fangYaoSuffix")}</th>
              <th className="min-w-32 px-2 py-2 font-medium">{t("items.fangYaoShowName")}</th>
              <th className="min-w-28 px-2 py-2 font-medium">{t("items.fangYaoExtraProcess")}</th>
              <th className="w-10 px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {value.length === 0 && (
              <tr>
                <td
                  className="px-2 py-6 text-center text-muted-foreground"
                  colSpan={7}
                >
                  {t("items.fangEditorEmpty")}
                </td>
              </tr>
            )}
            {value.map((entry, index) => (
              <tr className="border-b" key={index}>
                <td className="px-2 py-2">
                  <AdminSelect
                    ariaLabel={t("items.fangYaoName")}
                    disabled={disabled}
                    onChange={(option) => updateEntry(index, {
                      yaoId: option.value,
                      // 选中药时若显示名还没填，自动带上正名。
                      ...(entry.showName ? {} : {showName: String(option.label)}),
                    })}
                    options={yaoOptions}
                    placeholder={t("items.fangYaoNamePlaceholder")}
                    searchPlaceholder={t("items.fangYaoNameSearch")}
                    value={yaoLabel(entry)}
                  />
                </td>
                <td className="px-2 py-2">
                  <AdminInput
                    extraParams={{"aria-label": t("items.fangYaoAmount")}}
                    disabled={disabled}
                    onChange={(e: any) => updateEntry(index, {amount: e.target.value})}
                    placeholder="9"
                    value={entry.amount != null ? String(entry.amount) : ""}
                  />
                </td>
                <td className="px-2 py-2">
                  <AdminInput
                    extraParams={{"aria-label": t("items.fangYaoWeight")}}
                    disabled={disabled}
                    onChange={(e: any) => updateEntry(index, {weight: e.target.value})}
                    placeholder="g"
                    value={entry.weight != null ? String(entry.weight) : ""}
                  />
                </td>
                <td className="px-2 py-2">
                  <AdminInput
                    extraParams={{"aria-label": t("items.fangYaoSuffix")}}
                    disabled={disabled}
                    onChange={(e: any) => updateEntry(index, {suffix: e.target.value})}
                    placeholder={t("items.fangYaoSuffixPlaceholder")}
                    value={entry.suffix != null ? String(entry.suffix) : ""}
                  />
                </td>
                <td className="px-2 py-2">
                  <AdminInput
                    extraParams={{"aria-label": t("items.fangYaoShowName")}}
                    disabled={disabled}
                    onChange={(e: any) => updateEntry(index, {showName: e.target.value})}
                    value={entry.showName ?? ""}
                  />
                </td>
                <td className="px-2 py-2">
                  <AdminInput
                    extraParams={{"aria-label": t("items.fangYaoExtraProcess")}}
                    disabled={disabled}
                    onChange={(e: any) =>
                      updateEntry(index, {extraProcess: e.target.value})}
                    value={entry.extraProcess != null ? String(entry.extraProcess) : ""}
                  />
                </td>
                <td className="px-2 py-2">
                  <Button
                    aria-label={t("items.fangYaoRemove")}
                    disabled={disabled}
                    onClick={() => removeEntry(index)}
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <Trash2Icon aria-hidden="true" className="size-4" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4">
        <Button
          disabled={disabled}
          onClick={addEntry}
          size="sm"
          type="button"
          variant="outline"
        >
          <PlusIcon aria-hidden="true" className="size-4" /> {t("items.fangYaoAdd")}
        </Button>
      </div>

      <div className="mt-5 border-t pt-4">
        <h3 className="text-sm font-semibold">{t("items.fangReferencesTitle")}</h3>
        {referencesError ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {t("items.fangReferencesError")}
          </p>
        ) : references === null ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {t("items.fangReferencesLoading")}
          </p>
        ) : references.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {t("items.fangReferencesEmpty")}
          </p>
        ) : (
          <ul className="mt-2 space-y-1">
            {references.map((reference) => (
              <li key={reference.id}>
                <a
                  className="text-sm text-primary hover:underline"
                  href={ADMIN_URLS.editItem(reference.id)}
                >
                  {reference.title}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
