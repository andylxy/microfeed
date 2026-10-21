import {
  createContext,
  useContext,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ChevronRightIcon,
  GripVerticalIcon,
} from "lucide-react";

import {cn} from "@/lib/utils";
import {useTranslation} from "@/client/i18n";
import type {AdminLanguage} from "@/shared/AdminLanguage";
import {
  childrenOf,
  isInjectedRow,
  menuRowEffectiveLabel,
  menuSiblingPosition,
  type DropPosition,
  type MenuRow,
} from "@/shared/MenuTreeView";

/**
 * 树的合成根（跟 rbac「权限管理」的 `ROOT_NODE = "permission_root"` 一样）。
 * 它不是菜单行、也不是权限码，只给整棵树一个统一的展开入口。
 */
export const MENU_ROOT_NODE = "menu_root";

/** 拖拽上下文（M5 接入；未接入时节点只展示手柄、不可拖）。 */
export interface MenuDragCtx {
  draggingCode: string | null;
  dropTarget: {code: string; position: DropPosition} | null;
  onHandlePointerDown: (event: ReactPointerEvent<HTMLButtonElement>, code: string) => void;
}

/**
 * 树节点经 context 拿到的共享数据与控制。
 *
 * 行内不再放任何编辑控件（v4：编辑全部移到右侧详情面板），所以这里只留
 * 树本身需要的东西：行集、折叠态、选中态、搜索态、拖拽与键盘移动。
 * 改名 / 图标 / 父级 / 显隐 / 删除等编辑回调由面板直接从管理页拿 props。
 */
export interface MenuTreeCtxValue {
  collapsed: Record<string, boolean>;
  drag?: MenuDragCtx;
  language: AdminLanguage;
  move: (row: MenuRow, direction: "up" | "down") => void;
  onSelect: (code: string) => void;
  /** 只读一版：拖拽手柄置灰并禁用（键盘移动随之失效），与详情面板的置灰同口径。 */
  readOnly: boolean;
  rows: MenuRow[];
  search: {
    query: string;
    isForcedOpen: (code: string) => boolean;
    isHighlighted: (code: string) => boolean;
  };
  selectedCode: string | null;
  toggleOpen: (code: string) => void;
}

export const MenuTreeCtx = createContext<MenuTreeCtxValue | null>(null);

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
 * 递归树节点（v4）：行首（折叠箭头 + 拖拽手柄）+ 可点选标签块（名称在上、mono code 在下）+
 * 隐藏标记 + 递归子节点。任意深度；缩进来自子节点的 `border-l pl-4` 嵌套容器。
 *
 * 行内不放任何编辑控件——点一行只是选中它，编辑在右侧详情面板里做
 * （跟 rbac「权限管理」一致：树负责呈现与选择，编辑集中在面板）。
 *
 * 节点最外层包 `data-menu-node`：拖拽时用 `elementFromPoint` 反查目标节点。
 */
export function MenuTreeNode({row}: {row: MenuRow}) {
  const ctx = useContext(MenuTreeCtx);
  if (!ctx) throw new Error("MenuTreeNode 必须包在 MenuTreeCtx.Provider 内");
  const {
    collapsed,
    drag,
    language,
    move,
    onSelect,
    readOnly,
    rows,
    search,
    selectedCode,
    toggleOpen,
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
  const selected = selectedCode === row.code;

  if (!visible) return null;

  // 同层兄弟序列里自己的位置，决定上/下移按钮禁用态（与服务端 move 同口径）。
  const {canDown, canUp} = menuSiblingPosition(rows, row.code);

  const label = menuRowEffectiveLabel(row, language, t);
  // 注入行只作展示：不给拖拽手柄、不当拖拽目标、点不中（进不了右侧面板）。
  const injected = isInjectedRow(row);

  return (
    <div data-menu-node={injected ? undefined : row.code}>
      <div
        className={cn(
          "relative flex items-center gap-1",
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
          {!injected && (
            <button
              aria-label={t("menuAdmin.dragHandle")}
              className={cn(
                "shrink-0 rounded-md p-1 text-muted-foreground",
                readOnly
                  ? "cursor-not-allowed opacity-50"
                  : "cursor-grab hover:bg-muted active:cursor-grabbing",
              )}
              disabled={readOnly}
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
          )}
        </div>

        <button
          aria-current={selected ? "true" : undefined}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-[10px] px-2 py-1 text-left text-sm",
            selected
              ? "bg-muted font-medium text-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
          disabled={injected}
          onClick={() => onSelect(row.code)}
          type="button"
        >
          <span className="min-w-0 flex-1">
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
          {!row.visible && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {t("menuAdmin.hiddenBadge")}
            </span>
          )}
          {injected && (
            <span
              className="shrink-0 text-xs text-muted-foreground"
              title={t("menuAdmin.injectedHint")}
            >
              {t("menuAdmin.injectedBadge")}
            </span>
          )}
        </button>
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
