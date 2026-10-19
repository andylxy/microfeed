import {
  createContext,
  useContext,
  useEffect,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ChevronRightIcon,
  GripVerticalIcon,
} from "lucide-react";

import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {cn} from "@/lib/utils";
import {useTranslation} from "@/client/i18n";
import {MENU_ICON_NAMES} from "@/shared/MenuIconNames";
import {adminMenuItemLabel, menuRowLabelKey} from "@/shared/AdminNavigation";
import type {AdminLanguage} from "@/shared/AdminLanguage";
import {
  compareMenuRows,
  menuDescendantCodes,
  type MenuAdminRowWithMeta,
  type MenuUpdatePatch,
} from "@/shared/MenuAdminOps";

/** 与 `GET /ajax/menu` 的响应行一致。 */
export type MenuRow = MenuAdminRowWithMeta;

/**
 * 树的合成根（对齐 rbac「权限管理」的 `ROOT_NODE = "permission_root"`）。
 * 它不是菜单行、也不是权限码，只给整棵树一个统一的展开入口。
 */
export const MENU_ROOT_NODE = "menu_root";

/** 拖拽放置位置的三段：同层前 / 同层后 / 作为子节点挂到目标下。 */
export type DropPosition = "before" | "after" | "inside";

/** 拖拽上下文（M5 接入；未接入时节点只展示手柄、不可拖）。 */
export interface MenuDragCtx {
  draggingCode: string | null;
  dropTarget: {code: string; position: DropPosition} | null;
  onHandlePointerDown: (event: ReactPointerEvent<HTMLButtonElement>, code: string) => void;
}

/** 树节点经 context 拿到的全部共享数据与控制。 */
export interface MenuTreeCtxValue {
  rows: MenuRow[];
  collapsed: Record<string, boolean>;
  toggleOpen: (code: string) => void;
  updateField: (row: MenuRow, patch: MenuUpdatePatch) => void;
  confirmPageParent: (parentCode: string | null) => boolean;
  restoreDefault: (row: MenuRow) => void;
  removeRow: (row: MenuRow) => void;
  addChildGroup: (parentCode: string) => void;
  move: (row: MenuRow, direction: "up" | "down") => void;
  language: AdminLanguage;
  disabled: boolean;
  search: {
    query: string;
    isForcedOpen: (code: string) => boolean;
    isHighlighted: (code: string) => boolean;
  };
  drag?: MenuDragCtx;
}

export const MenuTreeCtx = createContext<MenuTreeCtxValue | null>(null);

/**
 * 取某父级下的直接子节点，按服务端 `(sort, code)` 口径排序。
 * 渲染与键盘移动按钮禁用态共用这一个口径，避免两处顺序不一致。
 */
export function childrenOf(rows: MenuRow[], parentCode: string): MenuRow[] {
  const target = parentCode || null;
  return rows
    .filter((row) => (row.parentCode ?? null) === target)
    .sort(compareMenuRows);
}

/**
 * 拖拽放置位置的三段判定：目标节点垂直高度的顶/底 1/3 为同层 before/after，中部 1/3 为 inside。
 * `allowInside` 为 false（目标非分组）时，中部回退为 before/after（按中线）。
 */
export function dropPositionFromY(
  rect: {top: number; bottom: number; height: number},
  y: number,
  allowInside = true,
): DropPosition {
  const third = rect.height / 3;
  if (allowInside) {
    if (y < rect.top + third) return "before";
    if (y > rect.bottom - third) return "after";
    return "inside";
  }
  return y < (rect.top + rect.bottom) / 2 ? "before" : "after";
}

/**
 * 把 `draggedCode` 按放置位置移动到目标层：before/after 同层重排（可改父级），
 * inside 挂到目标分组下。返回新的行集（被拖项更新 parentCode 与 sort，同层兄弟重排 sort）
 * 用于本地预览；与服务端 `planReorder` 口径一致（ids = 目标层有序 code，parentCode = 目标层父级）。
 * 会出现环（拖到自身后代）时原样返回，交由服务端兜底拦截。
 */
export function reorderMenuRows(
  rows: MenuRow[],
  draggedCode: string,
  targetCode: string,
  position: DropPosition,
): MenuRow[] {
  if (draggedCode === targetCode) return rows;
  const target = rows.find((entry) => entry.code === targetCode);
  if (!target) return rows;
  const dragged = rows.find((entry) => entry.code === draggedCode);
  if (!dragged) return rows;

  const newParent = position === "inside" ? targetCode : (target.parentCode ?? null);
  // 环：新父级是被拖项的后代 → 不改，避免本地预览就破结构。
  if (newParent && menuDescendantCodes(rows, draggedCode).has(newParent)) return rows;

  const siblingParent = position === "inside" ? targetCode : (target.parentCode ?? null);
  const siblings = rows
    .filter(
      (entry) =>
        (entry.parentCode ?? null) === (siblingParent || null) && entry.code !== draggedCode,
    )
    .sort(compareMenuRows);
  const insertIndex =
    position === "inside"
      ? siblings.length
      : siblings.findIndex((entry) => entry.code === targetCode);
  if (insertIndex < 0) return rows;
  siblings.splice(insertIndex, 0, dragged);

  const reordered = rows.map((entry) => {
    if (entry.code === draggedCode) {
      return {...entry, parentCode: newParent, sort: insertIndex + 1};
    }
    const siblingIndex = siblings.findIndex((sibling) => sibling.code === entry.code);
    if (siblingIndex >= 0) return {...entry, sort: siblingIndex + 1};
    return entry;
  });
  // 结构（code 序 + 各节点 parentCode/sort）没变则原样返回，便于调用方跳过无谓刷新。
  const unchanged = reordered.every((entry, index) => {
    const prev = rows[index];
    return (
      prev &&
      prev.code === entry.code &&
      prev.parentCode === entry.parentCode &&
      prev.sort === entry.sort
    );
  });
  return unchanged ? rows : reordered;
}

/**
 * 折叠箭头：类名、图标与 `aria-label` 逐字照抄 rbac「权限管理」的 `branchToggle`
 * （`RbacApp/index.tsx` L115–128）。根行与各分支行共用这一个组件，
 * 避免两处箭头各写一份后慢慢漂开。
 */
export function MenuBranchToggle({
  expanded,
  label,
  onToggle,
}: {
  expanded: boolean;
  label: string;
  onToggle: () => void;
}) {
  const {t} = useTranslation();
  return (
    <button
      aria-expanded={expanded}
      aria-label={t("menuAdmin.toggleBranch", {name: label})}
      className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground outline-none transition hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40"
      onClick={onToggle}
      type="button"
    >
      <ChevronRightIcon
        aria-hidden="true"
        className={cn("size-4 transition-transform", expanded && "rotate-90")}
      />
    </button>
  );
}

/**
 * 名称输入：受控 + 失焦提交。局部 state 承接输入，值变化时回填；
 * 「恢复默认」清空库名后输入框必须跟着清空，所以非受控 defaultValue 不适用。
 */
export function MenuNameInput({
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
      className="h-8 w-full min-w-24 text-sm"
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
 * 递归树节点：行首（折叠箭头 + 拖拽手柄）+ 标签块（名称在上、mono code 在下）+
 * 管理操作（名称中/英、图标、父级、显隐、移动、恢复默认、删除、加子分组）+
 * 递归子节点。任意深度；缩进来自子节点的 `border-l pl-4` 嵌套容器。
 *
 * 节点最外层包 `data-menu-node`：拖拽时用 `elementFromPoint` 反查目标节点。
 */
export function MenuTreeNode({row}: {row: MenuRow}) {
  const ctx = useContext(MenuTreeCtx);
  if (!ctx) throw new Error("MenuTreeNode 必须包在 MenuTreeCtx.Provider 内");
  const {
    rows,
    collapsed,
    toggleOpen,
    updateField,
    confirmPageParent,
    restoreDefault,
    removeRow,
    addChildGroup,
    move,
    language,
    disabled,
    search,
    drag,
  } = ctx;
  const {t} = useTranslation();

  const isDragging = drag?.draggingCode === row.code;
  const dragTarget =
    drag?.dropTarget?.code === row.code ? drag?.dropTarget.position : null;

  const children = childrenOf(rows, row.code);
  const hasChildren = children.length > 0;
  const searchActive = search.query.trim().length > 0;
  const forcedOpen = search.isForcedOpen(row.code);
  const highlighted = search.isHighlighted(row.code);
  // 缺席即展开（默认全展开）；搜索态下只展开命中节点的祖先链，其余折叠。
  const userCollapsed = collapsed[row.code] === true;
  const isCollapsed = searchActive ? !forcedOpen : userCollapsed;
  const open = hasChildren && !(isCollapsed && !forcedOpen);
  // 搜索态：只保留命中节点与其祖先链，其余不渲染。
  const visible = !searchActive || highlighted || forcedOpen;
  const hasCustomName = Boolean(row.nameZh || row.nameEn);

  if (!visible) return null;

  // 同层兄弟序列里自己的位置，决定上/下移按钮禁用态（与服务端 move 同口径）。
  const siblings = childrenOf(rows, row.parentCode ?? "");
  const index = siblings.findIndex((entry) => entry.code === row.code);
  const canUp = index > 0;
  const canDown = index < siblings.length - 1;

  const label =
    adminMenuItemLabel({en: row.nameEn ?? "", zh: row.nameZh ?? ""}, language) ??
    t(menuRowLabelKey(row.code));
  const descendants = menuDescendantCodes(rows, row.code);

  return (
    <div data-menu-node={row.code}>
      <div
        className={cn(
          "relative flex flex-wrap items-center gap-2",
          isDragging && "opacity-60",
          dragTarget && "z-10 bg-muted/40 ring-1 ring-inset ring-primary",
          dragTarget === "before" &&
            "before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-primary",
          dragTarget === "after" &&
            "after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-primary",
        )}
      >
        <div className="flex items-center gap-1">
          {hasChildren && (
            <MenuBranchToggle
              expanded={open}
              label={label}
              onToggle={() => toggleOpen(row.code)}
            />
          )}
          <button
            aria-label={t("menuAdmin.dragHandle")}
            className="shrink-0 cursor-grab rounded-md p-1 text-muted-foreground hover:bg-muted active:cursor-grabbing"
            type="button"
            onKeyDown={(event) => {
              // 键盘移动与「↑ / ↓」按钮同一条 `move` op；越出同层边界时服务端会拒绝。
              if (event.key === "ArrowUp" && canUp) {
                event.preventDefault();
                move(row, "up");
              } else if (event.key === "ArrowDown" && canDown) {
                event.preventDefault();
                move(row, "down");
              }
            }}
            onPointerDown={(event) => drag?.onHandlePointerDown(event, row.code)}
          >
            <GripVerticalIcon aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>

        <span className="min-w-0 max-w-56">
          <span
            className={cn(
              "block truncate text-sm",
              highlighted
                ? "font-semibold text-primary"
                : hasChildren
                  ? "font-semibold text-foreground"
                  : undefined,
            )}
            title={t("menuAdmin.effectiveName")}
          >
            {label}
          </span>
          <span className="block font-mono text-xs text-muted-foreground">{row.code}</span>
        </span>

        <MenuNameInput
          disabled={disabled}
          onCommit={(next) => updateField(row, {nameZh: next})}
          placeholder={t("menuAdmin.nameZhPlaceholder")}
          value={row.nameZh}
        />
        <MenuNameInput
          disabled={disabled}
          onCommit={(next) => updateField(row, {nameEn: next})}
          placeholder={t("menuAdmin.nameEnPlaceholder")}
          value={row.nameEn}
        />

        <select
          className="h-8 rounded-md border bg-background px-2 text-sm"
          defaultValue={row.icon ?? ""}
          disabled={disabled}
          key={row.icon ?? ""}
          onChange={(event) => updateField(row, {icon: event.target.value || null})}
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

        <select
          className="h-8 max-w-40 rounded-md border bg-background px-2 text-sm"
          defaultValue={row.parentCode ?? ""}
          disabled={disabled}
          key={row.parentCode ?? ""}
          onChange={(event) => {
            const next = event.target.value || null;
            if (!confirmPageParent(next)) {
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

        <span className="ml-auto flex flex-wrap items-center gap-1">
          <Button
            disabled={disabled}
            onClick={() => updateField(row, {isVisible: !row.visible})}
            size="sm"
            type="button"
            variant="ghost"
          >
            {row.visible ? t("menuAdmin.hide") : t("menuAdmin.show")}
          </Button>
          <Button
            aria-label={t("menuAdmin.moveUp")}
            disabled={disabled || !canUp}
            onClick={() => move(row, "up")}
            size="sm"
            type="button"
            variant="ghost"
          >
            ↑
          </Button>
          <Button
            aria-label={t("menuAdmin.moveDown")}
            disabled={disabled || !canDown}
            onClick={() => move(row, "down")}
            size="sm"
            type="button"
            variant="ghost"
          >
            ↓
          </Button>
          {hasCustomName && (
            <Button
              disabled={disabled}
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
              disabled={disabled}
              onClick={() => removeRow(row)}
              size="sm"
              type="button"
              variant="ghost"
            >
              {t("menuAdmin.delete")}
            </Button>
          )}
          {row.path === "" && (
            <Button
              disabled={disabled}
              onClick={() => addChildGroup(row.code)}
              size="sm"
              type="button"
              variant="outline"
            >
              + {t("menuAdmin.addChildGroup")}
            </Button>
          )}
        </span>
      </div>

      {open && (
        <div className="mt-2 flex flex-col gap-3 border-l pl-4">
          {children.map((child) => (
            <MenuTreeNode key={child.code} row={child} />
          ))}
        </div>
      )}
    </div>
  );
}

