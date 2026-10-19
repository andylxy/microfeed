import {useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent} from "react";
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
  type MenuAdminOp,
  type MenuAdminRowWithMeta,
  type MenuUpdatePatch,
} from "@/shared/MenuAdminOps";
import {
  childrenOf,
  dropPositionFromY,
  MenuTreeCtx,
  MenuTreeNode,
  reorderMenuRows,
  type DropPosition,
  type MenuRow,
} from "@/components/admin/menu/MenuTreeNode";

/** `GET /ajax/menu` 的响应体：行集 + 失败时的错误文案。 */

interface MenuRowsResponse {
  error?: string;
  rows?: MenuRow[];
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
 * 菜单管理页（票 03 骨架 + 票 04 编辑 + 票 05 图标名文案 + 树形改造）。
 *
 * 行内编辑、失焦保存：每个控件只发一个聚焦的 op，服务端返回最新全量行。
 * 「怎么摆 / 叫什么」可改；`path` 与 `permission_code` 只读展示（可达性不在此处改）。
 * 渲染从扁平行表格换成了递归可折叠树（`MenuTreeNode`），增删改移能力原样保留。
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
  // 树折叠态：缺席即展开（默认全展开）；搜索态由命中祖先强制展开覆盖。
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // 搜索框（按 code 或生效名称过滤；命中祖先强制展开、命中高亮）。
  const [search, setSearch] = useState("");
  // 拖拽状态：draggedCode 当前被拖节点；dropTarget 当前放置位置（节点 + 三段位置）。
  const [draggedCode, setDraggedCode] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{code: string; position: DropPosition} | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const dragChangedRef = useRef(false);
  const savingOrderRef = useRef(false);
  const rowsRef = useRef<MenuRow[]>([]);
  const savedRowsRef = useRef<MenuRow[]>([]);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxMenu());
      const data = (await response.json().catch(() => ({}))) as MenuRowsResponse;
      if (!response.ok) throw new Error(data.error ?? t("menuAdmin.loadFailed"));
      setRows(Array.isArray(data.rows) ? data.rows : []);
      savedRowsRef.current = Array.isArray(data.rows) ? data.rows : [];
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
        savedRowsRef.current = Array.isArray(data.rows) ? data.rows : [];
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

  // 打开新建分组弹层：顶层新建会清空父级，节点上的「加子分组」会预填父级。
  const openCreateGroup = useCallback((parentCode: string) => {
    setDraft((prev) => ({...prev, parentCode}));
    setCreating(true);
  }, []);

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

  const toggleOpen = useCallback((code: string) => {
    setCollapsed((prev) => ({...prev, [code]: prev[code] !== true}));
  }, []);

  const expandAll = useCallback(() => setCollapsed({}), []);
  const collapseAll = useCallback(() => {
    const next: Record<string, boolean> = {};
    for (const row of rows) next[row.code] = true;
    setCollapsed(next);
  }, [rows]);

  // 同层上/下移：键盘移动走既有 `move` op，这里只发单个聚焦的 op。
  const move = useCallback(
    (row: MenuRow, direction: "up" | "down") => {
      void postOps([{code: row.code, direction, op: "move"}]);
    },
    [postOps],
  );

  // 搜索的命中集合与祖先链：命中节点的所有祖先强制展开，节点本身高亮。
  const searchMatch = useMemo(() => {
    const query = search.trim().toLowerCase();
    const codes = new Set<string>();
    const ancestors = new Set<string>();
    if (query) {
      const parentByCode = new Map(rows.map((entry) => [entry.code, entry.parentCode]));
      for (const entry of rows) {
        const label =
          adminMenuItemLabel({en: entry.nameEn ?? "", zh: entry.nameZh ?? ""}, language) ??
          t(menuRowLabelKey(entry.code));
        if (entry.code.toLowerCase().includes(query) || label.toLowerCase().includes(query)) {
          codes.add(entry.code);
          let parent = entry.parentCode;
          while (parent) {
            ancestors.add(parent);
            parent = parentByCode.get(parent) ?? null;
          }
        }
      }
    }
    return {ancestors, codes};
  }, [rows, search, language, t]);

  const roots = useMemo(() => childrenOf(rows, ""), [rows]);

  // 拖拽内核（镜像 categories 的 Pointer 拖拽，扩展为树感知的三段放置位置）。
  // 放置位置写回走 `reorder` op，以服务端返回的权威行集为准。
  const beginDragging = (event: ReactPointerEvent<HTMLButtonElement>, code: string) => {
    if (event.button !== 0 || savingOrderRef.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    activePointerIdRef.current = event.pointerId;
    dragChangedRef.current = false;
    setDraggedCode(code);
  };

  const finishDragging = useCallback(() => {
    activePointerIdRef.current = null;
    const changed = dragChangedRef.current;
    const target = dropTarget;
    const dragged = draggedCode;
    dragChangedRef.current = false;
    setDraggedCode(null);
    setDropTarget(null);
    if (!changed || !target || !dragged) return;
    const result = reorderMenuRows(rowsRef.current, dragged, target.code, target.position);
    const moved = result.find((entry) => entry.code === dragged);
    if (!moved) return;
    const newParent = moved.parentCode ?? null;
    const ids = childrenOf(result, newParent ?? "").map((entry) => entry.code);
    // 保存期间不接新的拖拽起点，避免两个 reorder 同时写回。
    savingOrderRef.current = true;
    void postOps([{code: dragged, op: "reorder", ids, parentCode: newParent}]).then((ok) => {
      savingOrderRef.current = false;
      if (!ok) setRows(savedRowsRef.current);
    });
  }, [dropTarget, draggedCode, postOps]);

  useEffect(() => {
    if (!draggedCode) return;
    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerId !== activePointerIdRef.current) return;
      event.preventDefault();
      const targetRow = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-menu-node]");
      const targetCode = targetRow?.dataset.menuNode;
      if (!targetRow || !targetCode || targetCode === draggedCode) {
        setDropTarget(null);
        return;
      }
      const target = rowsRef.current.find((entry) => entry.code === targetCode);
      if (!target) {
        setDropTarget(null);
        return;
      }
      // inside 仅对分组节点（空 path）；页面行中部回退为 before/after。
      const allowInside = target.path === "";
      const bounds = targetRow.getBoundingClientRect();
      const position = dropPositionFromY(bounds, event.clientY, allowInside);
      setDropTarget({code: targetCode, position});
      // 预览直接基于行集 ref 计算：连续 pointermove 之间不必等重渲染。
      const reordered = reorderMenuRows(rowsRef.current, draggedCode, targetCode, position);
      if (reordered !== rowsRef.current) {
        dragChangedRef.current = true;
        rowsRef.current = reordered;
        setRows(reordered);
      }
    };
    const handlePointerEnd = (event: PointerEvent) => {
      if (event.pointerId === activePointerIdRef.current) finishDragging();
    };
    window.addEventListener("blur", finishDragging);
    window.addEventListener("pointercancel", handlePointerEnd);
    window.addEventListener("pointermove", handlePointerMove, {passive: false});
    window.addEventListener("pointerup", handlePointerEnd);
    return () => {
      window.removeEventListener("blur", finishDragging);
      window.removeEventListener("pointercancel", handlePointerEnd);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
    };
  }, [draggedCode, finishDragging]);

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
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          className="max-w-xs"
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("menuAdmin.searchPlaceholder")}
          value={search}
        />
        <Button disabled={busy} onClick={expandAll} size="sm" type="button" variant="outline">
          {t("menuAdmin.expandAll")}
        </Button>
        <Button disabled={busy} onClick={collapseAll} size="sm" type="button" variant="outline">
          {t("menuAdmin.collapseAll")}
        </Button>
        <span className="flex-1" />
        <Button disabled={busy} onClick={exportSql} size="sm" type="button" variant="outline">
          <DownloadIcon aria-hidden="true" />
          {t("menuAdmin.exportSql")}
        </Button>
        <Button disabled={busy} onClick={() => openCreateGroup("")} size="sm" type="button">
          <PlusIcon aria-hidden="true" />
          {t("menuAdmin.createGroup")}
        </Button>
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
        {search.trim() && searchMatch.codes.size === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">{t("menuAdmin.noResults")}</p>
        ) : (
          <MenuTreeCtx.Provider
            value={{
              addChildGroup: openCreateGroup,
              collapsed,
              confirmPageParent,
              disabled: busy,
              drag: {
                draggingCode: draggedCode,
                dropTarget,
                onHandlePointerDown: beginDragging,
              },
              language,
              move,
              removeRow,
              restoreDefault,
              rows,
              search: {
                isForcedOpen: (code) => searchMatch.ancestors.has(code),
                isHighlighted: (code) => searchMatch.codes.has(code),
                query: search,
              },
              toggleOpen,
              updateField,
            }}
          >
            {roots.map((root) => (
              <MenuTreeNode depth={0} key={root.code} row={root} />
            ))}
          </MenuTreeCtx.Provider>
        )}
      </section>

      <p className="text-xs text-muted-foreground">{t("menuAdmin.lockedHint")}</p>
    </div>
  );
}
