/**
 * 菜单管理页树视图的纯计算（票 04 的 v4 双面板）。
 *
 * 为什么单开一个模块：这些函数回答的是「这一行该显示成什么、它的子节点是谁、
 * 能挂在谁下面」，与 `MenuAdminOps.ts`（校验 + 生成 SQL 语句）是两类职责，
 * 混进同一个文件会让一个模块因为两个不相关的理由被改。它们同样是运行时中立的
 * 行数组计算，按仓库的源码架构约定归 `src/shared/`，渲染组件与右栏面板两侧共用。
 *
 * 注入行（code 形如 `settings:custom-code`）在这一层合成：侧栏的第三级是渲染时
 * 注入的，数据表里没有对应行——见 `AdminSidebar.SUB_SECTION_BUILDERS`。
 */

import {ADMIN_API_PAGES} from "./AdminApiNavigation";
import type {AdminLanguage} from "./AdminLanguage";
import {adminMenuItemLabel, menuRowLabelKey} from "./AdminNavigation";
import {ADMIN_SETTINGS_SECTIONS} from "./AdminSettingsNavigation";
import {ADMIN_WEBHOOK_PAGES} from "./AdminWebhookNavigation";
import {ADMIN_MENU_CODES} from "./Constants";
import {
  compareMenuRows,
  menuDescendantCodes,
  type MenuAdminRowWithMeta,
} from "./MenuAdminOps";
import {MENU_ICON_NAMES} from "./MenuIconNames";

/** 与 `GET /ajax/menu` 的响应行一致。 */
export type MenuRow = MenuAdminRowWithMeta;

/** 拖拽放置位置的三段：同层前 / 同层后 / 作为子节点挂到目标下。 */
export type DropPosition = "before" | "after" | "inside";

/**
 * 取某父级下的直接子节点，按服务端 `(sort, code)` 口径排序。
 * 渲染与键盘移动按钮的禁用态共用这一个口径，避免两处顺序不一致。
 */
export function childrenOf(rows: MenuRow[], parentCode: string): MenuRow[] {
  const target = parentCode || null;
  return rows
    .filter((row) => (row.parentCode ?? null) === target)
    .sort(compareMenuRows);
}

/**
 * 一行的「生效名」：库里的自定义名优先（当前语言列，空列取另一列），
 * 都没有时回退到 i18n 兜底标签。树行、面板头部、父节点下拉共用这一个口径，
 * 三处显示不漂移。`t` 由调用方从 `useTranslation` 传入，本模块不直接依赖
 * react-i18next 的初始化时序。
 */
export function menuRowEffectiveLabel(
  row: MenuRow,
  language: AdminLanguage,
  t: (key: string) => string,
): string {
  return (
    adminMenuItemLabel({en: row.nameEn ?? "", zh: row.nameZh ?? ""}, language) ??
    t(menuRowLabelKey(row.code))
  );
}

/**
 * 一行的顶层祖先：沿 `parentCode` 链一路向上，走到没有父级的那一行。
 * 顶层手风琴用它决定「选中这一行时该展开哪个顶层」。行不在 `rows` 里（比如
 * 刚被删掉）时返回 null。
 */
export function menuTopAncestorCode(rows: MenuRow[], code: string): string | null {
  const byCode = new Map(rows.map((row) => [row.code, row]));
  let current = byCode.get(code) ?? null;
  while (current?.parentCode) {
    const parent = byCode.get(current.parentCode) ?? null;
    if (!parent) break;
    current = parent;
  }
  return current?.code ?? null;
}

/** 注入行的 sort 基数：数据行的 sort 是几百量级，注入行排在同级末尾。 */
const INJECTED_ROW_SORT_BASE = 1000;

/**
 * 注入行的 code 形如 `settings:custom-code`，与 `AdminSidebar` 注入子项的 id 同形。
 * 菜单行的 code 只允许小写字母、数字与下划线，冒号因此只出现在注入行上——
 * 判据就是它，行模型不必再加字段。
 */
export function isInjectedRow(row: MenuRow): boolean {
  return row.code.includes(":");
}

/**
 * 侧栏的第三级子项是 `AdminSidebar.SUB_SECTION_BUILDERS` 在渲染时注入的，
 * `ext_menu` 里没有对应行，管理页树因此比侧栏少一层。这里把同一份清单合成
 * 同形的只读行，只为让两处对得上——清单不在这里复制第二份。
 *
 * 这些行只进树的渲染行集，不进任何保存操作（见 `MenuAdminApp` 的
 * `displayRows`）：它们没有 `path` 也没有 `permission_code`，改名 / 改图标 /
 * 排序 / 显隐一概不能做。
 */
export function menuInjectedRows(
  zhText: (key: string) => string,
  enText: (key: string) => string,
): MenuRow[] {
  const build = (
    parentCode: string,
    items: readonly {icon: string; id: string; nameKey: string}[],
  ): MenuRow[] =>
    items.map((item, index) => {
      const code = `${parentCode}:${item.id}`;
      return {
        code,
        createdAtMs: 0,
        deletable: false,
        i18nKey: item.nameKey,
        icon: item.icon,
        id: code,
        // 两列都填清单文案，`menuRowEffectiveLabel` 于是按界面语言取其中一列，
        // 与侧栏走 `labelKey` 的口径一致。
        nameEn: enText(item.nameKey),
        nameZh: zhText(item.nameKey),
        parentCode,
        path: "",
        permissionCode: null,
        sort: INJECTED_ROW_SORT_BASE + index,
        visible: true,
      };
    });
  return [
    ...build(ADMIN_MENU_CODES.SETTINGS, ADMIN_SETTINGS_SECTIONS),
    ...build(ADMIN_MENU_CODES.API, ADMIN_API_PAGES),
    ...build(ADMIN_MENU_CODES.WEBHOOKS, ADMIN_WEBHOOK_PAGES),
  ];
}

/**
 * 父级候选：排除自身与自身后代——把行挂到自己下面会成环，挂到后代下面会让
 * 归属关系错乱。新建分组没有「自身」，`MenuGroupCreator` 直接收全部行。
 */
export function menuParentCandidates(rows: MenuRow[], code: string): MenuRow[] {
  const excluded = menuDescendantCodes(rows, code);
  excluded.add(code);
  return rows.filter((candidate) => !excluded.has(candidate.code));
}

/** 页面行的图标不允许清空：`path` 非空即页面行，「无图标」入口对它禁用。 */
export function menuIconNoneDisabled(row: MenuRow): boolean {
  return row.path !== "";
}

/**
 * 一行在同层兄弟里的位置：上移/下移按钮的禁用态与拖拽手柄的键盘移动共用
 * 这个口径，两个方向各自能不能动只算一次。
 */
export function menuSiblingPosition(
  rows: MenuRow[],
  code: string,
): {canDown: boolean; canUp: boolean} {
  const parentCode = rows.find((row) => row.code === code)?.parentCode ?? "";
  const siblings = childrenOf(rows, parentCode);
  const index = siblings.findIndex((entry) => entry.code === code);
  return {canDown: index < siblings.length - 1, canUp: index > 0};
}

/** 图标下拉的选项清单（不带「无图标」入口），两处下拉共用一份。 */
export function menuIconOptions(
  t: (key: string) => string,
): {label: string; value: string}[] {
  return MENU_ICON_NAMES.map((name) => ({
    label: t(`menu.icon.${name}`),
    value: name,
  }));
}

/** 父节点下拉的选项清单：候选行映射成「生效名 + code」。 */
export function menuParentOptions(
  candidates: MenuRow[],
  language: AdminLanguage,
  t: (key: string) => string,
): {label: string; value: string}[] {
  return candidates.map((candidate) => ({
    label: menuRowEffectiveLabel(candidate, language, t),
    value: candidate.code,
  }));
}

/**
 * 父节点下拉的完整选项：在 `menuParentOptions` 前补一个「无父级」空选项。
 * 编辑面板与新建分组表单两处都长这样，合成一份避免两边各写一遍后漂开。
 */
export function menuParentSelectOptions(
  candidates: MenuRow[],
  language: AdminLanguage,
  t: (key: string) => string,
  noneLabel: string,
): {label: string; value: string}[] {
  return [{label: noneLabel, value: ""}, ...menuParentOptions(candidates, language, t)];
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
