import {
  createContext,
  useContext,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  ChevronRightIcon,
  GripVerticalIcon,
  KeyRoundIcon,
  ListIcon,
  ReceiptTextIcon,
} from "lucide-react";

import {MENU_ICONS} from "@/components/admin/AdminMenuItemLink";
import {cn} from "@/lib/utils";
import {useTranslation} from "@/client/i18n";
import type {AdminLanguage} from "@/shared/AdminLanguage";
import type {InterfaceCatalogRow} from "@/shared/AppInterface";
import {
  permissionNodeChildren,
  permissionSiblingPosition,
  type PermissionDropPosition,
  type PermissionNodeRowWithMeta,
} from "@/shared/PermissionTreeOps";
import {rbacTreeLabel} from "@/shared/Rbac";

/**
 * 树的合成根（与菜单管理的 `MENU_ROOT_NODE` 同款）。
 * 它不是节点行、也不是权限码，只给整棵树一个统一的展开入口。
 */
export const PERMISSION_ROOT_NODE = "permission_root";

/**
 * 行与缩进的两组常量：数值照抄原形 `.node-row`（gap 6px、padding 4px 6px）与
 * `.children`（margin-left 14px、padding-left 8px、左侧竖线）。树、匿名接口块
 * 和接口叶子共用它们，避免三处各自写一套盒模型慢慢漂开。
 */
export const TREE_ROW_CLASS = "relative flex items-center gap-1.5 rounded-lg px-1.5 py-1";
export const TREE_CHILDREN_CLASS = "ml-3.5 flex flex-col border-l pl-2";
/** 选中态：原形为浅蓝底 + 细描边。 */
export const TREE_ROW_SELECTED_CLASS = "bg-primary/10 ring-1 ring-inset ring-primary/20";

/** 拖拽上下文：当前被拖节点 + 当前放置位置 + 手柄按下入口。 */
export interface PermissionDragCtx {
  draggingCode: string | null;
  dropTarget: {code: string; position: PermissionDropPosition} | null;
  onHandlePointerDown: (event: ReactPointerEvent<HTMLButtonElement>, code: string) => void;
}

/**
 * 授权勾选上下文（migration 0131 单页口径）：树上每个结点带一个勾选框，
 * 勾 = 给当前角色授权、取消 = 撤销，即点即存。分组/页面行勾选 = 作用于
 * 全部后代码；通配角色全禁用。
 */
export interface PermissionGrantsCtx {
  /** 勾选框禁用（通配角色 / 保存中）。 */
  disabled: boolean;
  /** 这串码在当前角色下的勾选态（全中 / 半选）。 */
  state: (codes: readonly string[]) => {checked: boolean; indeterminate: boolean};
  /** 即点即存：一次勾选/取消就是一个聚焦操作。 */
  toggle: (codes: readonly string[], granted: boolean) => void;
}

/**
 * 接口叶子上下文（migration 0131）：码结点下面挂只读接口路径叶子，
 * PC 端为后台 `ajax/*` 端点、App 端为开放接口，与「app公告 → 公告读取」
 * 同款树形。键 = 权限码；匿名端点没有码，不进这张映射（由页面合成块渲染）。
 */
export interface PermissionInterfacesCtx {
  byCode: Map<string, InterfaceCatalogRow[]>;
  onSelect: (row: InterfaceCatalogRow) => void;
  selectedPath: string | null;
}

/**
 * 树节点经 context 拿到的共享数据与控制。
 *
 * 行内不放编辑控件：点一行只是选中它，编辑在右侧详情面板里做
 * （与菜单管理一致——树负责呈现与选择，编辑集中在面板）。授权勾选框与
 * 接口叶子是仅有的两个行内展示件（单页口径，migration 0131）。
 */
export interface PermissionTreeCtxValue {
  /** 逐行折叠态（页面按手风琴状态派生：每层只有一个展开位）；缺席按展开处理。 */
  collapsed: Record<string, boolean>;
  drag?: PermissionDragCtx;
  /** 授权勾选（缺席 = 该端不渲染勾选框，例如 App 分类对无码账号隐藏）。 */
  grants?: PermissionGrantsCtx;
  /** 接口叶子（缺席 = 该端没有清单）。 */
  interfaces?: PermissionInterfacesCtx;
  language: AdminLanguage;
  move: (row: PermissionNodeRowWithMeta, direction: "up" | "down") => void;
  onSelect: (code: string) => void;
  /**
   * 权限目录名（`ext_permissions.name`，键 = 权限码）。码结点自身不冗余名字
   * （ADR-0038），标签只能从这里取；缺席或目录里没有的码回退到码文本。
   */
  permissionNames: Map<string, string>;
  rows: PermissionNodeRowWithMeta[];
  search: {
    query: string;
    isForcedOpen: (code: string) => boolean;
    isHighlighted: (code: string) => boolean;
  };
  selectedCode: string | null;
  toggleOpen: (code: string) => void;
}

export const PermissionTreeCtx = createContext<PermissionTreeCtxValue | null>(null);

/**
 * 拖拽放置位置的三段判定：目标节点垂直高度的顶/底 1/3 为同层 before/after，
 * 中部 1/3 为 inside。`allowInside` 为 false（目标非分组/页面，或拖放目标非法）时，
 * 中部回退为 before/after（按中线）。与 `MenuTreeNode` 同款口径。
 */
export function dropPositionFromY(
  rect: {top: number; bottom: number; height: number},
  y: number,
  allowInside = true,
): PermissionDropPosition {
  const third = rect.height / 3;
  if (allowInside) {
    if (y < rect.top + third) return "before";
    if (y > rect.bottom - third) return "after";
    return "inside";
  }
  return y < (rect.top + rect.bottom) / 2 ? "before" : "after";
}

/** 一行下面全部后代码（分组/页面行批量勾选用；码行传自己的码即可）。 */
export function permissionDescendantCodes(
  rows: PermissionNodeRowWithMeta[],
  code: string,
): string[] {
  const out: string[] = [];
  const visit = (parent: string) => {
    for (const child of permissionNodeChildren(rows, parent)) {
      if (child.permissionCode) out.push(child.permissionCode);
      visit(child.code);
    }
  };
  visit(code);
  return out;
}

/**
 * 折叠箭头：类名、图标与 `aria-label` 与菜单管理的 `MenuBranchToggle` 一致
 * （两者分别照抄角色 tab 的同款形态，避免三处箭头慢慢漂开）。
 */
export function PermissionBranchToggle({
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
      aria-label={t("rbac.permissionTree.toggleBranch", {name: label})}
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
 * 折叠箭头槽位：叶子行也占同样宽度，后面的图标与名称才对得齐
 * （原形用 `.caret.leaf{visibility:hidden}` 达到同样效果）。
 */
export function PermissionBranchSlot({
  expanded,
  hasContent,
  label,
  onToggle,
}: {
  expanded: boolean;
  hasContent: boolean;
  label: string;
  onToggle: () => void;
}) {
  if (!hasContent) return <span aria-hidden="true" className="size-6 shrink-0" />;
  return (
    <PermissionBranchToggle expanded={expanded} label={label} onToggle={onToggle} />
  );
}

/**
 * 结点图标：码行固定钥匙（原形 🔑），其余行取 `icon` 列的名字，
 * 未登记或为空时回退列表图标（与菜单管理同一张映射表）。
 */
export function PermissionNodeIcon({
  icon,
  kind,
}: {
  icon: string | null;
  kind: "code" | "group" | "page";
}) {
  const Icon = kind === "code" ? KeyRoundIcon : (icon ? MENU_ICONS[icon] : null) ?? ListIcon;
  return <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />;
}

/** 行尾小徽章（原形 `.badge`）。 */
export function TreeBadge({children}: {children: ReactNode}) {
  return (
    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
      {children}
    </span>
  );
}

/** 授权勾选框：码行勾自己的码，分组/页面行勾全部后代码；半选态由 helper 算。 */
function PermissionGrantCheckbox({row}: {row: PermissionNodeRowWithMeta}) {
  const ctx = useContext(PermissionTreeCtx);
  if (!ctx) throw new Error("PermissionTreeNode 必须包在 PermissionTreeCtx.Provider 内");
  const {grants, language, permissionNames, rows} = ctx;
  const {t} = useTranslation();
  if (!grants) return null;
  const codes = row.kind === "code"
    ? row.permissionCode ? [row.permissionCode] : []
    : permissionDescendantCodes(rows, row.code);
  if (codes.length === 0) return null;
  const label = row.kind === "code"
    ? permissionNames.get(row.permissionCode ?? row.code) ?? row.permissionCode ?? row.code
    : rbacTreeLabel(row, language, t);
  const state = grants.state(codes);
  return (
    <input
      aria-label={t("rbac.grantCheckbox", {code: label})}
      checked={state.checked}
      className="size-4 shrink-0 cursor-pointer accent-primary"
      disabled={grants.disabled}
      onChange={(event) => grants.toggle(codes, event.target.checked)}
      onClick={(event) => event.stopPropagation()}
      ref={(element) => {
        if (element) element.indeterminate = state.indeterminate;
      }}
      type="checkbox"
    />
  );
}

/**
 * 只读接口行：与真实结点同一套盒模型——折叠槽占位 + 票据图标 + mono 路径 +
 * 方法徽章 + 「只读」徽章（原形与 ADR-0039 R3 都要求方法进树行，右栏明细
 * 里还给完整信息）。
 */
export function PermissionInterfaceRow({
  row,
  selected,
  onSelect,
}: {
  row: InterfaceCatalogRow;
  selected: boolean;
  onSelect: (row: InterfaceCatalogRow) => void;
}) {
  const {t} = useTranslation();
  return (
    <button
      aria-current={selected ? "true" : undefined}
      className={cn(
        TREE_ROW_CLASS,
        "w-full text-left",
        selected
          ? TREE_ROW_SELECTED_CLASS
          : "hover:bg-muted",
      )}
      onClick={() => onSelect(row)}
      type="button"
    >
      <span aria-hidden="true" className="size-6 shrink-0" />
      <ReceiptTextIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
        {row.path}
      </span>
      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
        {row.method}
      </span>
      <TreeBadge>{t("rbac.interfaceReadonlyBadge")}</TreeBadge>
    </button>
  );
}

/** 只读接口路径叶子：挂在码结点下面，点选后右栏出明细。 */
function PermissionInterfaceLeaves({row}: {row: PermissionNodeRowWithMeta}) {
  const ctx = useContext(PermissionTreeCtx);
  if (!ctx) throw new Error("PermissionTreeNode 必须包在 PermissionTreeCtx.Provider 内");
  const {interfaces} = ctx;
  if (!interfaces) return null;
  const code = row.permissionCode;
  if (!code) return null;
  const leaves = interfaces.byCode.get(code) ?? [];
  if (leaves.length === 0) return null;
  return (
    <>
      {leaves.map((leaf) => (
        <PermissionInterfaceRow
          key={leaf.path}
          onSelect={interfaces.onSelect}
          row={leaf}
          selected={interfaces.selectedPath === leaf.path}
        />
      ))}
    </>
  );
}

/**
 * 递归树节点：单行排布照抄原形——折叠箭头槽 → 授权勾选框 → 图标 →
 * 名称 → 徽章；拖拽手柄移到行尾、悬浮显现，不挤占行首顺序。
 * 码行只显示权限目录里的用途名，原码不随行展示（右栏详情里可查）。
 * 任意深度；缩进来自子节点的 `TREE_CHILDREN_CLASS` 嵌套容器。
 *
 * 节点最外层包 `data-permission-node`：拖拽时用 `elementFromPoint` 反查目标节点。
 */
export function PermissionTreeNode({row}: {row: PermissionNodeRowWithMeta}) {
  const ctx = useContext(PermissionTreeCtx);
  if (!ctx) throw new Error("PermissionTreeNode 必须包在 PermissionTreeCtx.Provider 内");
  const {
    collapsed,
    drag,
    interfaces,
    language,
    move,
    onSelect,
    permissionNames,
    rows,
    search,
    selectedCode,
    toggleOpen,
  } = ctx;
  const {t} = useTranslation();

  const isDragging = drag?.draggingCode === row.code;
  const dragTarget =
    drag?.dropTarget?.code === row.code ? drag?.dropTarget.position : null;

  const children = permissionNodeChildren(rows, row.code);
  const hasChildren = children.length > 0;
  // 码结点可能没有子行但有接口叶子：叶子也算可展开内容，否则整棵树默认
  // 展开时它们永远不出现。
  const leaves = row.permissionCode
    ? interfaces?.byCode.get(row.permissionCode) ?? []
    : [];
  const hasContent = hasChildren || leaves.length > 0;
  const searchActive = search.query.trim().length > 0;
  const forcedOpen = search.isForcedOpen(row.code);
  const highlighted = search.isHighlighted(row.code);
  // 折叠态由页面逐行给出（手风琴：同一父下只有一个展开位）；搜索态只展开
  // 命中节点的祖先链，其余折叠。
  const userCollapsed = collapsed[row.code] === true;
  const isCollapsed = searchActive ? !forcedOpen : userCollapsed;
  const open = hasContent && !(isCollapsed && !forcedOpen);
  // 搜索态：只保留命中节点与其祖先链，其余不渲染。
  const visible = !searchActive || highlighted || forcedOpen;
  const selected = selectedCode === row.code;

  if (!visible) return null;

  // 同层兄弟序列里自己的位置，决定上/下移按钮禁用态（与服务端 move 同口径）。
  const {canDown, canUp} = permissionSiblingPosition(rows, row.code);

  // 码结点的名字不入库（ADR-0038：叶子行不带 name 列），只能取权限目录名；
  // 目录里没有这个码时再退回节点行自身的名字与码文本。
  const catalogName = row.kind === "code"
    ? permissionNames.get(row.permissionCode ?? row.code)
    : undefined;
  const label = catalogName ?? rbacTreeLabel(row, language, t);

  return (
    <div className="group/node" data-permission-node={row.code}>
      <div
        className={cn(
          TREE_ROW_CLASS,
          selected && TREE_ROW_SELECTED_CLASS,
          !selected && "hover:bg-muted",
          isDragging && "opacity-60",
          dragTarget && "z-10 bg-muted/40 ring-1 ring-inset ring-primary",
          dragTarget === "before" &&
            "before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-primary",
          dragTarget === "after" &&
            "after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-primary",
        )}
      >
        <PermissionBranchSlot
          expanded={open}
          hasContent={hasContent}
          label={label}
          onToggle={() => toggleOpen(row.code)}
        />

        <PermissionGrantCheckbox row={row} />

        <PermissionNodeIcon icon={row.icon} kind={row.kind} />

        <button
          aria-current={selected ? "true" : undefined}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5 text-left",
            selected ? "text-foreground" : "text-foreground/90",
          )}
          onClick={() => onSelect(row.code)}
          type="button"
        >
          <span
            className={cn(
              "min-w-0 truncate text-sm",
              highlighted
                ? "font-semibold text-primary"
                : hasChildren
                  ? "font-semibold text-foreground"
                  : undefined,
            )}
          >
            {label}
          </span>
          {!row.visible && <TreeBadge>{t("rbac.permissionTree.hiddenBadge")}</TreeBadge>}
          {row.kind === "code" && (
            <TreeBadge>{t("rbac.permissionTree.codeBadge")}</TreeBadge>
          )}
        </button>

        <button
          aria-label={t("rbac.permissionTree.dragHandle")}
          className="shrink-0 cursor-grab rounded-md p-0.5 text-muted-foreground opacity-0 transition hover:bg-muted focus-visible:opacity-100 active:cursor-grabbing group-hover/node:opacity-100"
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
          <GripVerticalIcon aria-hidden="true" className="size-4" />
        </button>
      </div>

      {(open || (searchActive && forcedOpen)) && (
        <div className={TREE_CHILDREN_CLASS}>
          {children.map((child) => (
            <PermissionTreeNode key={child.code} row={child} />
          ))}
          <PermissionInterfaceLeaves row={row} />
        </div>
      )}
    </div>
  );
}
