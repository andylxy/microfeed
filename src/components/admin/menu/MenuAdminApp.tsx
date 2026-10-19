import {useCallback, useEffect, useMemo, useState} from "react";
import {DownloadIcon, PlusIcon} from "lucide-react";

import {
  AdminCollectionError,
  AdminCollectionLoading,
} from "@/components/admin/shared/AdminCollectionState";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {useTranslation} from "@/client/i18n";
import {ADMIN_URLS} from "@/shared/StringUtils";
import {MENU_ICON_NAMES} from "@/shared/MenuIconNames";
import {adminMenuItemLabel, menuRowLabelKey} from "@/shared/AdminNavigation";
import {parseAdminLanguage} from "@/shared/AdminLanguage";
import {
  compareMenuRows,
  menuDescendantCodes,
  type MenuAdminOp,
  type MenuAdminRowWithMeta,
  type MenuUpdatePatch,
} from "@/shared/MenuAdminOps";

/** 与 `GET /ajax/menu` 的响应行一致。 */
type MenuRow = MenuAdminRowWithMeta;

interface MenuRowsResponse {
  error?: string;
  rows?: MenuRow[];
}

/** 树形渲染的一行：扁平化后的行 + 深度。 */
interface FlatRow {
  depth: number;
  row: MenuRow;
}

/** patch 的键 → 行字段名（`isVisible` 在行上叫 `visible`）。 */
const PATCH_TO_ROW_KEY: Record<keyof MenuUpdatePatch, keyof MenuAdminRowWithMeta> = {
  icon: "icon",
  isVisible: "visible",
  nameEn: "nameEn",
  nameZh: "nameZh",
  parentCode: "parentCode",
};

/**
 * 把扁平行按 parentCode 展开成「树序 + 深度」的扁平行列表。
 * 服务端已按 `(sort, code)` 排序；指向不存在父级的孤儿行按根行处理，
 * 保证任何行都能显示、都能被改回正常父级。
 */
function flattenTree(rows: MenuRow[]): FlatRow[] {
  const codes = new Set(rows.map((row) => row.code));
  const childrenOf = new Map<string, MenuRow[]>();
  const roots: MenuRow[] = [];
  for (const row of rows) {
    if (row.parentCode && codes.has(row.parentCode)) {
      const bucket = childrenOf.get(row.parentCode) ?? [];
      bucket.push(row);
      childrenOf.set(row.parentCode, bucket);
    } else {
      roots.push(row);
    }
  }
  const out: FlatRow[] = [];
  const walk = (list: MenuRow[], depth: number): void => {
    for (const row of list) {
      out.push({depth, row});
      walk(childrenOf.get(row.code) ?? [], depth + 1);
    }
  };
  walk(roots, 0);
  return out;
}

/**
 * 名称输入：受控 + 失焦提交。
 *
 * 用局部 state 承接输入，`value` 变化时同步回填——「恢复默认」把库里的名称
 * 清空后，输入框必须跟着清空；非受控 `defaultValue` 会继续显示旧文本。
 */
function MenuNameInput({
  disabled,
  onCommit,
  placeholder,
  value,
}: {
  disabled: boolean;
  onCommit: (next: string | null) => void;
  placeholder: string;
  value: string | null;
}) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => {
    setDraft(value ?? "");
  }, [value]);
  return (
    <Input
      className="h-8 w-full min-w-28 text-sm"
      disabled={disabled}
      maxLength={64}
      onBlur={() => {
        const next = draft.trim() || null;
        if (next !== (value ?? null)) onCommit(next);
      }}
      onChange={(event) => setDraft(event.target.value)}
      placeholder={placeholder}
      value={draft}
    />
  );
}

/**
 * 菜单管理页（票 03 骨架 + 票 04 编辑 + 票 05 图标名文案）。
 *
 * 行内编辑、失焦保存：每个控件只发一个聚焦的 op，服务端返回最新全量行。
 * 「怎么摆 / 叫什么」可改；`path` 与 `permission_code` 只读展示（可达性不在此处改）。
 */
export default function MenuAdminApp() {
  const {t, i18n} = useTranslation();
  // 当前后台语言：生效名称按查看者语言取「中文名 → 英文名 → i18n 回退」，
  // 与侧栏 `adminMenuItemLabel` 的口径一致，避免管理表格与线上菜单各说各话。
  const language = parseAdminLanguage(i18n.language);
  const [rows, setRows] = useState<MenuRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // 新建分组弹层（同 AliasesApp 的内联表单模式）。
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({
    code: "",
    icon: "list",
    nameEn: "",
    nameZh: "",
    parentCode: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxMenu());
      const data = (await response.json().catch(() => ({}))) as MenuRowsResponse;
      if (!response.ok) throw new Error(data.error ?? t("menuAdmin.loadFailed"));
      setRows(Array.isArray(data.rows) ? data.rows : []);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("menuAdmin.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const postOps = useCallback(
    async (ops: MenuAdminOp[]): Promise<boolean> => {
      setBusy(true);
      setFormError(null);
      try {
        const response = await fetch(ADMIN_URLS.ajaxMenuSave(), {
          body: JSON.stringify({ops}),
          headers: {"content-type": "application/json"},
          method: "POST",
        });
        const data = (await response.json().catch(() => ({}))) as MenuRowsResponse;
        if (!response.ok) throw new Error(data.error ?? t("menuAdmin.saveFailed"));
        setRows(Array.isArray(data.rows) ? data.rows : []);
        return true;
      } catch (saveError) {
        setFormError(saveError instanceof Error ? saveError.message : t("menuAdmin.saveFailed"));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  const updateField = useCallback(
    (row: MenuRow, patch: MenuUpdatePatch) => {
      // 失焦即保存：值没有变化时不发请求（避免无意义写与行集重放）。
      // patch 的键与行字段不同名（`isVisible` ↔ `visible`），逐键映射后再比对。
      const changed = (Object.entries(patch) as [keyof MenuUpdatePatch, unknown][]).some(
        ([key, value]) => (row[PATCH_TO_ROW_KEY[key]] as unknown) !== value,
      );
      if (!changed) return;
      void postOps([{code: row.code, op: "update", patch}]);
    },
    [postOps],
  );

  // 父节点候选是「全部已有菜单行」，但有子节点的行在侧栏只展开不跳转——
  // 页面行一旦有了孩子，它自己的侧栏入口就消失了。候选保留、事前警告，
  // 点确认才提交。
  const confirmPageParent = useCallback(
    (parentCode: string | null): boolean => {
      if (!parentCode) return true;
      const parent = rows.find((row) => row.code === parentCode);
      return !parent || parent.path === "" ||
        window.confirm(t("menuAdmin.reparentToPageConfirm", {code: parent.code}));
    },
    [rows, t],
  );

  const restoreDefault = useCallback(
    (row: MenuRow) => {
      void postOps([{code: row.code, op: "update", patch: {nameEn: null, nameZh: null}}]);
    },
    [postOps],
  );

  const removeRow = useCallback(
    (row: MenuRow) => {
      if (!window.confirm(t("menuAdmin.deleteConfirm", {code: row.code}))) return;
      void postOps([{code: row.code, op: "delete"}]);
    },
    [postOps, t],
  );

  const submitCreateGroup = useCallback(async () => {
    if (!confirmPageParent(draft.parentCode || null)) return;
    const ok = await postOps([
      {
        code: draft.code.trim(),
        icon: draft.icon,
        nameEn: draft.nameEn,
        nameZh: draft.nameZh,
        op: "create-group",
        parentCode: draft.parentCode || null,
      },
    ]);
    if (ok) {
      setCreating(false);
      setDraft({code: "", icon: "list", nameEn: "", nameZh: "", parentCode: ""});
    }
  }, [confirmPageParent, draft, postOps]);

  const exportSql = useCallback(async () => {
    setFormError(null);
    try {
      const response = await fetch(ADMIN_URLS.ajaxMenuExport());
      const data = (await response.json().catch(() => ({}))) as {error?: string; sql?: string};
      if (!response.ok || typeof data.sql !== "string") {
        throw new Error(data.error ?? t("menuAdmin.exportFailed"));
      }
      const blob = new Blob([data.sql], {type: "application/sql;charset=utf-8"});
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "data_menu_snapshot.sql";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      setFormError(
        exportError instanceof Error ? exportError.message : t("menuAdmin.exportFailed"),
      );
    }
  }, [t]);

  const flatRows = useMemo(() => flattenTree(rows), [rows]);

  // 上移/下移的边界 = 同父兄弟序列的首尾（服务端 move 的判定口径相同）。
  const siblingFlags = useMemo(() => {
    const byParent = new Map<string, MenuRow[]>();
    const codes = new Set(rows.map((row) => row.code));
    for (const row of rows) {
      const key = row.parentCode && codes.has(row.parentCode) ? row.parentCode : "\u0000root";
      const bucket = byParent.get(key) ?? [];
      bucket.push(row);
      byParent.set(key, bucket);
    }
    const flags = new Map<string, {canDown: boolean; canUp: boolean}>();
    for (const bucket of byParent.values()) {
      // 与服务端 siblingsOf 同一个排序口径：按钮禁用态才不会与
      // errors.menu.moveBlocked 的判定不一致。
      bucket.sort(compareMenuRows);
      bucket.forEach((row, index) => {
        flags.set(row.code, {canDown: index < bucket.length - 1, canUp: index > 0});
      });
    }
    return flags;
  }, [rows]);

  if (loading && rows.length === 0) {
    return <AdminCollectionLoading label={t("menuAdmin.title")} />;
  }

  if (error && rows.length === 0) {
    return <AdminCollectionError message={error} retry={() => void load()} />;
  }

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t("menuAdmin.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("menuAdmin.intro")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button disabled={busy} onClick={exportSql} size="sm" type="button" variant="outline">
            <DownloadIcon aria-hidden="true" />
            {t("menuAdmin.exportSql")}
          </Button>
          <Button disabled={busy} onClick={() => setCreating(true)} size="sm" type="button">
            <PlusIcon aria-hidden="true" />
            {t("menuAdmin.createGroup")}
          </Button>
        </div>
      </div>

      {formError && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {formError}
        </p>
      )}

      {creating && (
        <section className="grid gap-3 rounded-[14px] border bg-card p-4 shadow-xs">
          <h2 className="text-sm font-semibold">{t("menuAdmin.createGroupTitle")}</h2>
          <div className="flex flex-wrap items-center gap-3">
            <Input
              autoFocus
              className="w-44"
              onChange={(event) => setDraft((prev) => ({...prev, code: event.target.value}))}
              placeholder={t("menuAdmin.codePlaceholder")}
              value={draft.code}
            />
            <Input
              className="w-36"
              onChange={(event) => setDraft((prev) => ({...prev, nameZh: event.target.value}))}
              placeholder={t("menuAdmin.nameZhPlaceholder")}
              value={draft.nameZh}
            />
            <Input
              className="w-36"
              onChange={(event) => setDraft((prev) => ({...prev, nameEn: event.target.value}))}
              placeholder={t("menuAdmin.nameEnPlaceholder")}
              value={draft.nameEn}
            />
            <select
              className="rounded-md border bg-background px-3 py-2 text-sm"
              onChange={(event) => setDraft((prev) => ({...prev, icon: event.target.value}))}
              value={draft.icon}
            >
              {MENU_ICON_NAMES.map((name) => (
                <option key={name} value={name}>
                  {t(`menu.icon.${name}`)}
                </option>
              ))}
            </select>
            <select
              className="rounded-md border bg-background px-3 py-2 text-sm"
              onChange={(event) => setDraft((prev) => ({...prev, parentCode: event.target.value}))}
              value={draft.parentCode}
            >
              <option value="">{t("menuAdmin.parentNone")}</option>
              {rows.map((row) => (
                <option key={row.code} value={row.code}>
                  {row.code}
                </option>
              ))}
            </select>
            <Button disabled={busy} onClick={() => void submitCreateGroup()} size="sm" type="button">
              {t("menuAdmin.save")}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setCreating(false);
                setFormError(null);
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              {t("menuAdmin.cancel")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("menuAdmin.createGroupHint")}</p>
        </section>
      )}

      <section className="overflow-x-auto rounded-[14px] border bg-card shadow-xs">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">{t("menuAdmin.entry")}</th>
              <th className="px-4 py-2 font-medium">{t("menuAdmin.effectiveName")}</th>
              <th className="px-4 py-2 font-medium">{t("menuAdmin.nameZh")}</th>
              <th className="px-4 py-2 font-medium">{t("menuAdmin.nameEn")}</th>
              <th className="px-4 py-2 font-medium">{t("menuAdmin.icon")}</th>
              <th className="px-4 py-2 font-medium">{t("menuAdmin.parent")}</th>
              <th className="px-4 py-2 font-medium">{t("menuAdmin.visible")}</th>
              <th className="px-4 py-2 font-medium">{t("menuAdmin.order")}</th>
              <th className="px-4 py-2 font-medium">{t("menuAdmin.actions")}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {flatRows.map(({depth, row}) => {
              const descendants = menuDescendantCodes(rows, row.code);
              const flags = siblingFlags.get(row.code) ?? {canDown: false, canUp: false};
              const hasCustomName = Boolean(row.nameZh || row.nameEn);
              return (
                <tr key={row.code}>
                  <td className="px-4 py-2" style={{paddingLeft: `${16 + depth * 16}px`}}>
                    <div className="grid">
                      <span className="font-medium">{row.code}</span>
                      <span className="text-xs text-muted-foreground">
                        {row.path || t("menuAdmin.groupTag")} · {row.permissionCode ?? t("menuAdmin.publicEntry")}
                      </span>
                    </div>
                  </td>
                  {/* 生效名称：侧栏的同一条优先级（数据库名 → i18n 文案），
                      运营在这里直接看到菜单当前显示的文本。 */}
                  <td className="px-4 py-2 text-sm text-muted-foreground">
                    {adminMenuItemLabel(
                      {en: row.nameEn ?? "", zh: row.nameZh ?? ""},
                      language,
                    ) ?? t(menuRowLabelKey(row.code))}
                  </td>
                  <td className="px-2 py-2">
                    <MenuNameInput
                      disabled={busy}
                      onCommit={(next) => updateField(row, {nameZh: next})}
                      placeholder={t("menuAdmin.nameZhPlaceholder")}
                      value={row.nameZh}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <MenuNameInput
                      disabled={busy}
                      onCommit={(next) => updateField(row, {nameEn: next})}
                      placeholder={t("menuAdmin.nameEnPlaceholder")}
                      value={row.nameEn}
                    />
                  </td>
                  <td className="px-2 py-2">
                    {/* 页面行的「无图标」只作当前值展示（disabled），不可再选：
                        服务端同一口径拒绝（errors.menu.iconRequired）。 */}
                    <select
                      className="rounded-md border bg-background px-2 py-1 text-sm"
                      defaultValue={row.icon ?? ""}
                      disabled={busy}
                      onChange={(event) =>
                        updateField(row, {icon: event.target.value || null})}
                    >
                      {(row.path === "" || row.icon === null) && (
                        <option disabled={row.path !== ""} value="">
                          {t("menuAdmin.iconNone")}
                        </option>
                      )}
                      {MENU_ICON_NAMES.map((name) => (
                        <option key={name} value={name}>
                          {t(`menu.icon.${name}`)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-2">
                    <select
                      className="max-w-40 rounded-md border bg-background px-2 py-1 text-sm"
                      defaultValue={row.parentCode ?? ""}
                      disabled={busy}
                      onChange={(event) => {
                        const next = event.target.value || null;
                        if (!confirmPageParent(next)) {
                          // 取消：把下拉还原成当前父级，不发 op。
                          event.target.value = row.parentCode ?? "";
                          return;
                        }
                        updateField(row, {parentCode: next});
                      }}
                    >
                      <option value="">{t("menuAdmin.parentNone")}</option>
                      {rows
                        .filter((candidate) => !descendants.has(candidate.code) && candidate.code !== row.code)
                        .map((candidate) => (
                          <option key={candidate.code} value={candidate.code}>
                            {candidate.code}
                          </option>
                        ))}
                    </select>
                  </td>
                  <td className="px-2 py-2">
                    <Button
                      disabled={busy}
                      onClick={() => updateField(row, {isVisible: !row.visible})}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {row.visible ? t("menuAdmin.hide") : t("menuAdmin.show")}
                    </Button>
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex items-center gap-1">
                      <Button
                        disabled={busy || !flags.canUp}
                        onClick={() => void postOps([{code: row.code, direction: "up", op: "move"}])}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        ↑
                      </Button>
                      <Button
                        disabled={busy || !flags.canDown}
                        onClick={() => void postOps([{code: row.code, direction: "down", op: "move"}])}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        ↓
                      </Button>
                      <span className="ml-1 text-xs text-muted-foreground">{row.sort}</span>
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex items-center justify-end gap-1">
                      {hasCustomName && (
                        <Button
                          disabled={busy}
                          onClick={() => restoreDefault(row)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          {t("menuAdmin.restoreDefault")}
                        </Button>
                      )}
                      {row.deletable && (
                        <Button
                          disabled={busy}
                          onClick={() => removeRow(row)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          {t("menuAdmin.delete")}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <p className="text-xs text-muted-foreground">{t("menuAdmin.lockedHint")}</p>
    </div>
  );
}
