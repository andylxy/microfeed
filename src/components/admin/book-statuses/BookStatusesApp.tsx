import {useCallback, useEffect, useState} from "react";
import {PencilIcon, PlusIcon, Trash2Icon} from "lucide-react";

import {showToast} from "@/client/ToastUtils";
import i18n, {useTranslation} from "@/client/i18n";
import AdminDialog from "@/components/admin/shared/AdminDialog";
import AdminInput from "@/components/admin/shared/AdminInput";
import AdminSwitch from "@/components/admin/shared/AdminSwitch";
import {
  AdminCollectionError,
  AdminCollectionLoading,
} from "@/components/admin/shared/AdminCollectionState";
import {Button} from "@/components/ui/button";
import {
  bookStatusBadgeStyle,
  bookStatusDisplayName,
  type BookStatusRow,
} from "@/shared/ExtBook";
import {ADMIN_URLS} from "@/shared/StringUtils";

interface BoardResponse {
  statuses: BookStatusRow[];
  usage: Record<string, number>;
}

interface EditorState {
  code: number | null;
  nameZh: string;
  nameEn: string;
  sort: string;
  formSelectable: boolean;
  publicVisible: boolean;
  colorFg: string | null;
  colorBg: string | null;
  /** 系统行的行为开关锁定：名称与配色可改，四个 flag 不可改。 */
  isSystem: boolean;
}

const EMPTY_EDITOR: EditorState = {
  code: null,
  nameZh: "",
  nameEn: "",
  // 留空 = 交给服务端排在现有行之后；新建状态绝不能带 0（会排到系统行前面，
  // 抢走书籍表单的首选项与恢复目标）。
  sort: "",
  formSelectable: true,
  publicVisible: false,
  colorFg: null,
  colorBg: null,
  isSystem: false,
};

const HEX_TRIPLE = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/iu;
const HEX_FULL = /^#[0-9a-f]{6}$/iu;
const FALLBACK_SWATCH = "#808080";

/**
 * The value a native colour input can display: lowercase `#RRGGBB`.
 *
 * Stored values are hex-only (the server rejects anything else), so this only
 * expands `#RGB` and falls back to grey for the null (uncoloured) case.
 */
function colorInputValue(color: string | null): string {
  if (!color) return FALLBACK_SWATCH;
  if (HEX_TRIPLE.test(color)) return color.toLowerCase().replace(HEX_TRIPLE, "#$1$1$2$2$3$3");
  if (HEX_FULL.test(color)) return color.toLowerCase();
  return FALLBACK_SWATCH;
}

/** The colour well: native picker + the stored value + a clear button. */
function ColorField({
  label,
  value,
  onChange,
  clearLabel,
}: {
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
  clearLabel: string;
}) {
  return (
    <div className="grid gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <div className="flex items-center gap-2">
        <input
          aria-label={label}
          className="h-8 w-14 shrink-0 cursor-pointer appearance-none rounded border p-0 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:border-none [&::-moz-color-swatch]:border-none"
          onChange={(event) => onChange(event.target.value)}
          type="color"
          value={colorInputValue(value)}
        />
        <span className="font-mono text-xs text-muted-foreground">
          {value ?? "—"}
        </span>
        {value != null && (
          <Button
            onClick={() => onChange(null)}
            size="sm"
            type="button"
            variant="ghost"
          >
            {clearLabel}
          </Button>
        )}
      </div>
    </div>
  );
}

async function requestJson(response: Response): Promise<unknown> {
  const data = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok) {
    throw new Error(data.error ?? i18n.t("bookStatuses.loadFailed"));
  }
  return data;
}

/**
 * 书籍状态字典维护页（migration 0142）。
 *
 * 一行 = 一种书籍状态：`channels.status` 存的就是行的 `code`。「表单可选」决定
 * 书籍编辑表单的下拉项，「前台可见」决定书架 / 分类 / 搜索 / 详情是否展示，
 * 「系统」行（显示 / 隐藏 / 已删除）锁定不可删。增删状态从此只在这张表上发生，
 * 不需要改代码再部署。
 */
export default function BookStatusesApp() {
  const {t, i18n: i18nInstance} = useTranslation();
  const zh = i18nInstance.language.startsWith("zh");
  const [statuses, setStatuses] = useState<BookStatusRow[]>([]);
  const [usage, setUsage] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = (await requestJson(
        await fetch(ADMIN_URLS.ajaxBookStatuses(), {
          cache: "no-store",
          headers: {accept: "application/json"},
        }),
      )) as BoardResponse;
      setStatuses(Array.isArray(data.statuses) ? data.statuses : []);
      setUsage(data.usage ?? {});
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : t("bookStatuses.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const nameOf = useCallback(
    (row: BookStatusRow) => bookStatusDisplayName(row, zh),
    [zh],
  );

  const usageOf = useCallback(
    (code: number) => usage[String(code)] ?? 0,
    [usage],
  );

  const openCreate = useCallback(() => {
    setEditor({...EMPTY_EDITOR});
  }, []);

  const openEdit = useCallback((row: BookStatusRow) => {
    setEditor({
      code: row.code,
      nameZh: row.nameZh,
      nameEn: row.nameEn,
      sort: String(row.sort),
      formSelectable: row.formSelectable,
      publicVisible: row.publicVisible,
      colorFg: row.colorFg,
      colorBg: row.colorBg,
      isSystem: row.isSystem,
    });
  }, []);

  const persistEditor = useCallback(async () => {
    if (!editor) return;
    const nameZh = editor.nameZh.trim();
    const nameEn = editor.nameEn.trim();
    if (!nameZh || !nameEn) {
      showToast(t("bookStatuses.saveFailed"), "error");
      return;
    }
    // 排序留空 = 新建时交给服务端排在最后；编辑时输入框预填了当前值，
    // 清空即保持原值。
    const sortText = editor.sort.trim();
    const sort = sortText === "" ? undefined : Number(sortText);
    if (sort !== undefined && (!Number.isInteger(sort) || sort < 0 || sort > 9999)) {
      showToast(t("bookStatuses.saveFailed"), "error");
      return;
    }
    const payload = {
      nameZh,
      nameEn,
      ...(sort === undefined ? {} : {sort}),
      formSelectable: editor.formSelectable,
      publicVisible: editor.publicVisible,
      colorFg: editor.colorFg,
      colorBg: editor.colorBg,
    };
    setSaving(true);
    try {
      if (editor.code == null) {
        await requestJson(await fetch(ADMIN_URLS.ajaxBookStatuses(), {
          body: JSON.stringify(payload),
          headers: {"content-type": "application/json"},
          method: "POST",
        }));
        showToast(t("bookStatuses.created"), "success");
      } else {
        await requestJson(await fetch(ADMIN_URLS.ajaxBookStatus(editor.code), {
          body: JSON.stringify(payload),
          headers: {"content-type": "application/json"},
          method: "PUT",
        }));
        showToast(t("bookStatuses.saved"), "success");
      }
      setEditor(null);
      await load();
    } catch (saveError) {
      showToast(
        saveError instanceof Error
          ? saveError.message
          : t("bookStatuses.saveFailed"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  }, [editor, load, t]);

  const toggleFlag = useCallback(
    async (
      row: BookStatusRow,
      flag: "formSelectable" | "publicVisible" | "adminListHidden",
      value: boolean,
    ) => {
      const previous = statuses;
      setStatuses((current) =>
        current.map((item) => {
          // 删除态是全表唯一的标记：认领时旧持有行同时熄灭。
          if (flag === "adminListHidden") {
            if (item.code === row.code) return {...item, adminListHidden: value};
            return value ? {...item, adminListHidden: false} : item;
          }
          if (item.code !== row.code) return item;
          return flag === "formSelectable"
            ? {...item, formSelectable: value}
            : {...item, publicVisible: value};
        }),
      );
      try {
        await requestJson(await fetch(ADMIN_URLS.ajaxBookStatus(row.code), {
          body: JSON.stringify({[flag]: value}),
          headers: {"content-type": "application/json"},
          method: "PUT",
        }));
        showToast(t("bookStatuses.saved"), "success");
        // 删除态转移会改动别的行，重新拉一次保证与库一致。
        if (flag === "adminListHidden") await load();
      } catch (toggleError) {
        setStatuses(previous);
        showToast(
          toggleError instanceof Error
            ? toggleError.message
            : t("bookStatuses.saveFailed"),
          "error",
        );
      }
    },
    [load, statuses, t],
  );

  const removeStatus = useCallback(
    async (row: BookStatusRow) => {
      if (!window.confirm(t("bookStatuses.deleteConfirm", {name: nameOf(row)}))) {
        return;
      }
      try {
        await requestJson(await fetch(ADMIN_URLS.ajaxBookStatus(row.code), {
          method: "DELETE",
        }));
        showToast(t("bookStatuses.deleted"), "success");
        await load();
      } catch (deleteError) {
        showToast(
          deleteError instanceof Error
            ? deleteError.message
            : t("bookStatuses.deleteFailed"),
          "error",
        );
      }
    },
    [load, nameOf, t],
  );

  if (loading && statuses.length === 0) {
    return <AdminCollectionLoading label={t("bookStatuses.title")} />;
  }

  if (error && statuses.length === 0) {
    return <AdminCollectionError message={error} retry={() => void load()} />;
  }

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t("bookStatuses.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("bookStatuses.intro")}
          </p>
        </div>
        <Button type="button" onClick={openCreate}>
          <PlusIcon aria-hidden="true" /> {t("bookStatuses.addStatus")}
        </Button>
      </div>

      {error && (
        <AdminCollectionError message={error} retry={() => void load()} />
      )}

      {statuses.length === 0 ? (
        <section className="rounded-[14px] border bg-card p-8 text-center shadow-xs">
          <h2 className="font-semibold">{t("bookStatuses.title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("bookStatuses.empty")}
          </p>
        </section>
      ) : (
        <section className="overflow-hidden rounded-[14px] border bg-card shadow-xs">
          <div className="grid grid-cols-[6.5rem_4rem_1fr_7rem_7rem_6.5rem_5.5rem_7rem] items-center gap-3 border-b bg-muted/40 px-4 py-2 text-xs font-semibold text-muted-foreground">
            <span>{t("bookStatuses.colCode")}</span>
            <span>{t("bookStatuses.colSort")}</span>
            <span>{t("bookStatuses.colName")}</span>
            <span>{t("bookStatuses.colFormSelectable")}</span>
            <span>{t("bookStatuses.colPublicVisible")}</span>
            <span>{t("bookStatuses.colDeleteState")}</span>
            <span>{t("bookStatuses.colUsage")}</span>
            <span className="text-right">{t("bookStatuses.colActions")}</span>
          </div>
          {statuses.map((row) => {
            const used = usageOf(row.code);
            const deleteBlocked = row.isSystem || used > 0;
            const badgeStyle = bookStatusBadgeStyle(row);
            return (
              <div
                className="grid grid-cols-[6.5rem_4rem_1fr_7rem_7rem_6.5rem_5.5rem_7rem] items-center gap-3 border-b px-4 py-3 last:border-b-0"
                key={row.code}
              >
                <div className="flex items-center gap-2">
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {row.code}
                  </span>
                  {row.isSystem && (
                    <span className="rounded-full border px-2 py-0.5 text-xs">
                      {t("bookStatuses.systemBadge")}
                    </span>
                  )}
                </div>                <span className="text-sm text-muted-foreground">{row.sort}</span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {/* 配色预览：与 /admin/books/ 的徽章同款上色 */}
                    <span
                      className={badgeStyle ? "rounded px-1.5 py-0.5" : undefined}
                      style={badgeStyle}
                    >
                      {nameOf(row)}
                    </span>
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {zh ? row.nameEn : row.nameZh}
                  </div>
                </div>
                <AdminSwitch
                  checked={row.formSelectable}
                  disabled={row.isSystem}
                  label={row.formSelectable
                    ? t("bookStatuses.on")
                    : t("bookStatuses.off")}
                  onCheckedChange={(checked) =>
                    void toggleFlag(row, "formSelectable", checked)}
                />
                <AdminSwitch
                  checked={row.publicVisible}
                  disabled={row.isSystem}
                  label={row.publicVisible
                    ? t("bookStatuses.on")
                    : t("bookStatuses.off")}
                  onCheckedChange={(checked) =>
                    void toggleFlag(row, "publicVisible", checked)}
                />
                <AdminSwitch
                  checked={row.adminListHidden}
                  // 持有行不能直接关掉：删除态只能由另一行认领来转移。
                  disabled={row.adminListHidden}
                  label={row.adminListHidden
                    ? t("bookStatuses.on")
                    : t("bookStatuses.off")}
                  onCheckedChange={(checked) => {
                    if (!checked) return;
                    if (!window.confirm(
                      t("bookStatuses.deleteStateConfirm", {name: nameOf(row)}),
                    )) return;
                    void toggleFlag(row, "adminListHidden", true);
                  }}
                />
                <span className="text-sm text-muted-foreground">
                  {t("bookStatuses.usageBooks", {count: used})}
                </span>
                <div className="flex justify-end gap-1">
                  <Button
                    aria-label={t("bookStatuses.editStatus")}
                    onClick={() => openEdit(row)}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  >
                    <PencilIcon aria-hidden="true" className="size-4" />
                  </Button>
                  <Button
                    aria-label={t("bookStatuses.delete")}
                    className="text-destructive hover:text-destructive"
                    disabled={deleteBlocked}
                    onClick={() => void removeStatus(row)}
                    size="icon-sm"
                    title={row.isSystem
                      ? t("bookStatuses.deleteBlockedSystem")
                      : used > 0
                        ? t("bookStatuses.deleteBlockedInUse", {count: used})
                        : undefined}
                    type="button"
                    variant="ghost"
                  >
                    <Trash2Icon aria-hidden="true" className="size-4" />
                  </Button>
                </div>
              </div>
            );
          })}
        </section>
      )}

      <p className="text-xs text-muted-foreground">
        {t("bookStatuses.codeAutoHint")}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("bookStatuses.deleteStateHint")}
      </p>

      <AdminDialog
        open={editor !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setEditor(null);
        }}
        title={editor?.code == null
          ? t("bookStatuses.addStatus")
          : t("bookStatuses.editStatus")}
      >
        {editor && (
          <div className="grid gap-4 pt-2">
            <AdminInput
              label={t("bookStatuses.nameZhLabel")}
              onChange={(event: any) =>
                setEditor((prev) => prev && {...prev, nameZh: event.target.value})}
              placeholder={t("bookStatuses.nameZhLabel")}
              value={editor.nameZh}
            />
            <AdminInput
              label={t("bookStatuses.nameEnLabel")}
              onChange={(event: any) =>
                setEditor((prev) => prev && {...prev, nameEn: event.target.value})}
              placeholder={t("bookStatuses.nameEnLabel")}
              value={editor.nameEn}
            />
            <AdminInput
              label={t("bookStatuses.sortLabel")}
              onChange={(event: any) =>
                setEditor((prev) => prev && {...prev, sort: event.target.value})}
              placeholder={t("bookStatuses.sortPlaceholder")}
              type="number"
              value={editor.sort}
            />
            <AdminSwitch
              checked={editor.formSelectable}
              disabled={editor.isSystem}
              label={t("bookStatuses.colFormSelectable")}
              onCheckedChange={(checked) =>
                setEditor((prev) => prev && {...prev, formSelectable: checked})}
            />
            <AdminSwitch
              checked={editor.publicVisible}
              disabled={editor.isSystem}
              label={t("bookStatuses.colPublicVisible")}
              onCheckedChange={(checked) =>
                setEditor((prev) => prev && {...prev, publicVisible: checked})}
            />
            {editor.isSystem && (
              <p className="text-xs text-muted-foreground">
                {t("bookStatuses.systemLockedHint")}
              </p>
            )}
            <ColorField
              clearLabel={t("bookStatuses.colorClear")}
              label={t("bookStatuses.colorFgLabel")}
              onChange={(value) =>
                setEditor((prev) => prev && {...prev, colorFg: value})}
              value={editor.colorFg}
            />
            <ColorField
              clearLabel={t("bookStatuses.colorClear")}
              label={t("bookStatuses.colorBgLabel")}
              onChange={(value) =>
                setEditor((prev) => prev && {...prev, colorBg: value})}
              value={editor.colorBg}
            />
            <p className="text-xs text-muted-foreground">
              {t("bookStatuses.colorHint")}
            </p>
            {editor.code == null && (
              <p className="text-xs text-muted-foreground">
                {t("bookStatuses.codeAutoHint")}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button
                onClick={() => setEditor(null)}
                type="button"
                variant="ghost"
              >
                {t("common.cancel")}
              </Button>
              <Button
                disabled={saving || !editor.nameZh.trim() || !editor.nameEn.trim()}
                onClick={() => void persistEditor()}
                type="button"
              >
                {t("bookStatuses.save")}
              </Button>
            </div>
          </div>
        )}
      </AdminDialog>
    </div>
  );
}
