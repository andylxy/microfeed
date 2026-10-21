/**
 * 侧栏行集的构造器（ADR-0042 D5 / D6）。
 *
 * 侧栏预览（阶段2）与真实侧栏（阶段3 起）共用这一份：真实侧栏从
 * `ext_permission_nodes` 读行、传 `rbacAllows` 当门控，预览传所选角色的权限
 * 集合。切换侧栏时只改调用点，不重写规则。
 *
 * 三条判定：
 *  - `visible = false` 的行不进侧栏；
 *  - `entry_code` 为空的页面节点只挂码、不进侧栏；
 *  - 门码非空时交给调用方给的门控判定（`*` 通配视为全见）。
 * 子项全被滤掉的分组不显示（空标题比没有标题更糟）；父分组被滤掉的子分组
 * 自己升为顶层。分组本身不是页面，链接指向第一个子项。
 *
 * 只取 PC 端行——App 端没有侧栏。三级注入子项（设置分区 / API / Webhooks）
 * 不在这里，由渲染端按 `SUB_SECTION_BUILDERS` 注入。
 */

import {adminUrl} from "./AdminPath";
import type {AdminMenuItem} from "./AdminNavigation";
import {ADMIN_MENU_CODES, PERMISSION_CODES} from "./Constants";
import {comparePermissionNodes, type PermissionNodeRow} from "./PermissionTreeOps";

/** 带子项数组的内部节点：构造阶段临时使用，输出前剥掉辅助字段。 */
interface SidebarNode extends AdminMenuItem {
  /** 有行以它为父级：子项全空时整组移除；页面行不受此规则影响。 */
  isParent: boolean;
  children: SidebarNode[];
}

/** 构造结果：渲染用行集 + 通过入口门控的二级页面数（首页不计）。 */
export interface SidebarItemsResult {
  items: AdminMenuItem[];
  pageCount: number;
}

/** 页面节点去掉 `page_` 前缀即得菜单码；分组节点本身不带前缀。 */
export function menuCodeFromNodeCode(nodeCode: string): string {
  return nodeCode.startsWith("page_") ? nodeCode.slice("page_".length) : nodeCode;
}

/**
 * 入口门控：门码为空的页面不进侧栏；持 `*` 通配或同值码则可见。判定与请求
 * 守卫共用同一口径（`*` 是真实权限码 `p_*`，`super_admin` 持有它）。
 *
 * 真实侧栏走 `rbacAllows`（它还要判「有没有登录」），侧栏预览没有 `locals`，
 * 因此用这一份纯集合判定——两者对非空门码的结论相同（`permissionsInclude`
 * 同样是 `has('*') || has(code)`）。
 */
export function roleSeesEntry(
  permissions: readonly string[],
  entryCode: string | null,
): boolean {
  if (!entryCode) return false;
  if (permissions.includes(PERMISSION_CODES.WILDCARD)) return true;
  return permissions.includes(entryCode);
}

/** 首页固定第一位，任何角色都看得到。 */
export function homeMenuItem(
  adminPath?: string | null,
  active = false,
): AdminMenuItem {
  return {
    active,
    disabled: false,
    icon: "home",
    id: ADMIN_MENU_CODES.ADMIN_HOME,
    url: adminUrl("", adminPath),
  };
}

function toItem(
  node: PermissionNodeRow,
  isParent: boolean,
  adminPath?: string | null,
  activeCode?: string | null,
): SidebarNode {
  const nameZh = node.nameZh?.trim() ?? "";
  const nameEn = node.nameEn?.trim() ?? "";
  const id = menuCodeFromNodeCode(node.code);
  return {
    active: id === activeCode,
    children: [],
    disabled: false,
    icon: node.icon,
    id,
    isParent,
    // 两列都空时不下发 label，渲染端回退 i18n 文案。
    ...(nameZh || nameEn ? {label: {en: nameEn, zh: nameZh}} : {}),
    nodeCode: node.code,
    url: adminUrl(node.path ?? "", adminPath),
  };
}

/** 丢掉子项全空的分组；自底向上，父组被滤空后自己也随之移除。 */
function pruneEmptyParents(nodes: SidebarNode[]): SidebarNode[] {
  const kept: SidebarNode[] = [];
  for (const node of nodes) {
    const children = pruneEmptyParents(node.children);
    if (node.isParent && children.length === 0) continue;
    kept.push({...node, children});
  }
  return kept;
}

/** 分组本身不是页面：链接指向第一个子项，侧栏因此能按普通条目渲染。 */
function linkGroups(nodes: SidebarNode[]): void {
  for (const node of nodes) {
    const first = node.children[0];
    if (!first) continue;
    node.url = first.url;
    linkGroups(node.children);
  }
}

function toOutput(node: SidebarNode): AdminMenuItem {
  const {children, isParent, ...item} = node;
  return children.length > 0 ? {...item, children: children.map(toOutput)} : item;
}

/**
 * 从权限节点行拼出侧栏行集：首页 + 分组 + 通过门控的二级页面，按 `(sort, code)`
 * 读序。
 *
 * @param nodes 权限节点行（通常取接口的 `desktop` 端行集）。
 * @param canSee 入口门控：给一个非空门码，答「这个角色能不能看见」。真实侧栏
 *   传 `rbacAllows`，预览传 `roleSeesEntry`。
 * @param adminPath 站点配置的后台前缀，缺省 `admin`。
 * @param activeCode 当前页面的菜单码，用于标记活动项；预览不传。
 */
export function buildSidebarItems(
  nodes: readonly PermissionNodeRow[],
  canSee: (entryCode: string) => boolean,
  adminPath?: string | null,
  activeCode?: string | null,
): SidebarItemsResult {
  const visible = nodes
    .filter(
      (node) => node.visible && node.audience === "desktop" && node.kind !== "code",
    )
    .sort(comparePermissionNodes);
  const parentCodes = new Set(
    visible
      .map((node) => node.parentCode)
      .filter((code): code is string => typeof code === "string" && code.length > 0),
  );
  const allowed = visible.filter(
    (node) =>
      node.kind === "group" ||
      (node.entryCode !== null && node.entryCode !== "" && canSee(node.entryCode)),
  );

  const byCode = new Map<string, SidebarNode>();
  for (const node of allowed) {
    byCode.set(node.code, toItem(node, parentCodes.has(node.code), adminPath, activeCode));
  }

  const roots: SidebarNode[] = [];
  for (const node of allowed) {
    const item = byCode.get(node.code);
    if (!item) continue;
    const parent = node.parentCode ? byCode.get(node.parentCode) : undefined;
    if (parent) {
      parent.children.push(item);
    } else {
      roots.push(item);
    }
  }

  const tree = pruneEmptyParents(roots);
  linkGroups(tree);

  return {
    items: [
      homeMenuItem(adminPath, activeCode === ADMIN_MENU_CODES.ADMIN_HOME),
      ...tree.map(toOutput),
    ],
    pageCount: allowed.filter((node) => node.kind === "page").length,
  };
}
