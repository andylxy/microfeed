import type {ReactNode} from "react";

import {ChevronRightIcon} from "lucide-react";

import {
  PermissionBranchToggle,
  TreeBadge,
  TREE_ROW_CLASS,
  TREE_ROW_SELECTED_CLASS,
} from "@/components/admin/rbac/PermissionTreeNode";
import {cn} from "@/lib/utils";

/** 分组树叶子：固定两行——主行加可选的等宽说明行。 */
export interface AdminTreeLeaf {
  id: string;
  label: string;
  description?: string;
}

/**
 * 分组树分组：`count` 是徽章显示的全量数，`leaves` 由调用方按自己的
 * 过滤口径给（如搜索命中行）——两者可以不同，组件不做任何过滤。
 */
export interface AdminTreeGroup {
  key: string;
  label: string;
  count: number;
  leaves: AdminTreeLeaf[];
}

interface AdminGroupTreeProps {
  /** 数据源：分组、计数与成员过滤全部由调用方算好传入。 */
  groups: AdminTreeGroup[];
  /** 展开的分组键集合。手风琴单展开由调用方只传一个键表达；搜索态可传多个。 */
  expandedKeys: readonly string[];
  selectedLeafId: string | null;
  onToggleGroup: (key: string) => void;
  onSelectLeaf: (id: string) => void;
  /** 不参与过滤的总览根行（如「全部用户」）；不传则不渲染。 */
  root?: {label: string; count: number; icon?: ReactNode};
  /** 分组展开后没有成员时的提示文案；不传则不渲染提示行。 */
  emptyLeafText?: string;
  /**
   * `emptyTreeText` 已传且所有分组都无可见叶子时，整列表替换成的提示文案
   * （如搜索无结果）。文案由调用方决定何时给——组件不认识「搜索」这个概念。
   */
  emptyTreeText?: string;
}

const LEAF_ROW_CLASS = "w-full rounded-[10px] px-3 py-2 text-left text-sm";

/**
 * 分组树（CONTEXT.md「分组树」）：管理后台页面左栏的两层分组导航。
 * 完全受控——展开与选中状态由调用方持有，本组件只渲染传入的状态并回调；
 * 手风琴单展开、搜索自动展开、换组自动选中首行这些页面语义留在调用方。
 */
export function AdminGroupTree({
  groups,
  expandedKeys,
  selectedLeafId,
  onToggleGroup,
  onSelectLeaf,
  root,
  emptyLeafText,
  emptyTreeText,
}: AdminGroupTreeProps) {
  return (
    <>
      {root && (
        <div className={cn(TREE_ROW_CLASS, "gap-1.5")}>
          <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center">
            <ChevronRightIcon className="size-4 rotate-90 text-muted-foreground" />
          </span>
          {root.icon}
          <span className="min-w-0 truncate text-sm font-semibold text-foreground">
            {root.label}
          </span>
          <TreeBadge>{root.count}</TreeBadge>
        </div>
      )}
      {emptyTreeText !== undefined && groups.every((group) => group.leaves.length === 0) ? (
        <p className="px-2 py-6 text-sm text-muted-foreground">{emptyTreeText}</p>
      ) : (
        <ul className={cn("ml-3.5 flex flex-col gap-0.5 border-l pl-2")}>
          {groups.map((group) => {
            const expanded = expandedKeys.includes(group.key);
            return (
              <li key={group.key}>
                <div
                  className={cn(
                    TREE_ROW_CLASS,
                    expanded ? TREE_ROW_SELECTED_CLASS : undefined,
                  )}
                >
                  <PermissionBranchToggle
                    expanded={expanded}
                    label={group.label}
                    onToggle={() => onToggleGroup(group.key)}
                  />
                  <button
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-sm text-muted-foreground transition hover:text-foreground"
                    onClick={() => onToggleGroup(group.key)}
                    type="button"
                  >
                    <span className="truncate">{group.label}</span>
                    <TreeBadge>{group.count}</TreeBadge>
                  </button>
                </div>
                {expanded && (
                  <ul className="ml-3.5 flex flex-col gap-1 border-l pl-2">
                    {group.leaves.map((leaf) => (
                      <li key={leaf.id}>
                        <button
                          aria-current={
                            leaf.id === selectedLeafId ? "true" : undefined
                          }
                          className={cn(
                            LEAF_ROW_CLASS,
                            leaf.id === selectedLeafId
                              ? "bg-muted font-medium text-foreground"
                              : "text-muted-foreground hover:bg-muted hover:text-foreground",
                          )}
                          onClick={() => onSelectLeaf(leaf.id)}
                          type="button"
                        >
                          <span className="block truncate">{leaf.label}</span>
                          {leaf.description !== undefined && (
                            <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                              {leaf.description}
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                    {group.leaves.length === 0 && emptyLeafText && (
                      <li className="px-2 py-1 text-xs text-muted-foreground">
                        {emptyLeafText}
                      </li>
                    )}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
