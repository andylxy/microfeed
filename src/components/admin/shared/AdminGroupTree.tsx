import type {ReactNode} from "react";

import {ChevronRightIcon} from "lucide-react";

import {
  PermissionBranchToggle,
  TreeBadge,
  TREE_ROW_CLASS,
  TREE_ROW_SELECTED_CLASS,
} from "@/components/admin/rbac/PermissionTreeNode";
import {cn} from "@/lib/utils";

/** 分组树叶子：固定两栏——主行加可选的说明行。`description` 不传（或空）则第二行留空，
 *  组件不渲染该行；两栏装什么由调用方定（用户页=邮箱·角色数，书本页=作者）。 */
export interface AdminTreeLeaf {
  id: string;
  label: string;
  description?: string;
}

/**
 * 分组树分组：`count` 由调用方给定（通常表示该节点下的可见成员数），
 * `leaves` 也由调用方按自己的过滤口径给——两者可以不同，组件不做任何过滤。
 *
 * `subgroups` 可选：传了就把这一层从「分组 → 叶子」升级为
 * 「分组 → 子分组 → 叶子」，子分组沿用同一份契约（可继续嵌套）。
 * **不传时行为与两层版完全一致**——既有页面无需改动。
 * `emptyText` 可选：该节点展开后没有成员时的提示；不传则回落
 * `emptyLeafText`。多层树的各层空态语义不同（分类下无书 / 书下无卷），
 * 由调用方逐节点给字符串，组件不认识业务。
 */
export interface AdminTreeGroup {
  key: string;
  label: string;
  count: number;
  leaves: AdminTreeLeaf[];
  subgroups?: AdminTreeGroup[];
  emptyText?: string;
}

interface AdminGroupTreeProps {
  /** 数据源：分组、计数与成员过滤全部由调用方算好传入。 */
  groups: AdminTreeGroup[];
  /** 展开的分组键集合。手风琴单展开由调用方只传一个键表达；搜索态可传多个。
   *  多层树里不同层的键也在这里，故**整棵树内键必须唯一**（调用方保证）。 */
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
const GROUP_LIST_CLASS = "ml-3.5 flex flex-col gap-0.5 border-l pl-2";
const LEAF_LIST_CLASS = "ml-3.5 flex flex-col gap-1 border-l pl-2";
const EMPTY_ROW_CLASS = "px-2 py-1 text-xs text-muted-foreground";

/** 整棵树是否还有可见叶子。多层树要下钻到子分组，不能只看顶层 `leaves`。 */
function hasVisibleLeaves(group: AdminTreeGroup): boolean {
  if (group.subgroups) return group.subgroups.some(hasVisibleLeaves);
  return group.leaves.length > 0;
}

interface GroupNodeProps {
  group: AdminTreeGroup;
  expandedKeys: readonly string[];
  selectedLeafId: string | null;
  onToggleGroup: (key: string) => void;
  onSelectLeaf: (id: string) => void;
  emptyLeafText?: string;
  /** 是否在该分组行渲染 `count` 徽标。默认 true（子分组沿用）；顶层分组传 false
   *  以隐藏第一层分类/题材后的统计数字——该层只作导航锚点，计数信息量低。 */
  showCount?: boolean;
}

/**
 * 单个分组节点。展开后按「有 `subgroups` / 无 `subgroups`」二选一渲染：
 * 前者递归渲染子分组，后者渲染叶子。两层的渲染分支保持原样，
 * 所以不传 `subgroups` 的页面与扩展前逐字节一致。
 */
function GroupNode({
  group,
  expandedKeys,
  selectedLeafId,
  onToggleGroup,
  onSelectLeaf,
  emptyLeafText,
  showCount = true,
}: GroupNodeProps) {
  const expanded = expandedKeys.includes(group.key);
  const emptyText = group.emptyText ?? emptyLeafText;
  return (
    <li>
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
          {showCount && <TreeBadge>{group.count}</TreeBadge>}
        </button>
      </div>
      {expanded && (group.subgroups ? (
        <ul className={GROUP_LIST_CLASS}>
          {group.subgroups.map((subgroup) => (
            <GroupNode
              emptyLeafText={emptyLeafText}
              expandedKeys={expandedKeys}
              group={subgroup}
              key={subgroup.key}
              onSelectLeaf={onSelectLeaf}
              onToggleGroup={onToggleGroup}
              selectedLeafId={selectedLeafId}
            />
          ))}
          {group.subgroups.length === 0 && emptyText && (
            <li className={EMPTY_ROW_CLASS}>{emptyText}</li>
          )}
        </ul>
      ) : (
        <ul className={LEAF_LIST_CLASS}>
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
                {/* 说明栏：不传「或空」都不渲染该行——让「没有值就整行留空」对
                    undefined 和空串一致成立（doc 与实现对齐，别只挡 undefined）。 */}
                {!!leaf.description && (
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {leaf.description}
                  </span>
                )}
              </button>
            </li>
          ))}
          {group.leaves.length === 0 && emptyText && (
            <li className={EMPTY_ROW_CLASS}>{emptyText}</li>
          )}
        </ul>
      ))}
    </li>
  );
}

/**
 * 分组树（CONTEXT.md「分组树」）：管理后台页面左栏的分组导航。
 * 默认两层（分组 → 叶子）；分组带 `subgroups` 时该分支下钻一层，
 * 可逐层嵌套出三层或更多。完全受控——展开与选中状态由调用方持有，
 * 本组件只渲染传入的状态并回调；手风琴单展开、搜索自动展开、换组
 * 自动选中首行这些页面语义留在调用方。
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
      {emptyTreeText !== undefined && groups.every((group) => !hasVisibleLeaves(group)) ? (
        <p className="px-2 py-6 text-sm text-muted-foreground">{emptyTreeText}</p>
      ) : (
        <ul className={cn(GROUP_LIST_CLASS)}>
          {groups.map((group) => (
            <GroupNode
              emptyLeafText={emptyLeafText}
              expandedKeys={expandedKeys}
              group={group}
              key={group.key}
              onSelectLeaf={onSelectLeaf}
              onToggleGroup={onToggleGroup}
              selectedLeafId={selectedLeafId}
              showCount={false}
            />
          ))}
        </ul>
      )}
    </>
  );
}
