/**
 * 权限树管理页的纯操作逻辑（票据 02）。
 *
 * 这里只有「校验 + 生成绑定参数语句」，不碰 D1、不碰 `cloudflare:workers`：
 * 执行在 `src/server/admin/permission-tree-handlers.ts`，校验在本模块，所以
 * 单测可以直接喂行数组断言错误与语句，不需要 miniflare。
 *
 * 能力边界（比菜单管理更严，ADR-0038 D4）：权限码是代码常量——`code` 节点
 * （叶子）禁止新建与删除，`update` 仅允许 `parentCode` 与 `isVisible`，
 * `permission_code` 任何操作都不得改写；但允许跨 page / group 改父
 * （reparent），这正是「移动权限对象位置」的核心动作。`source='seed'` 的行
 * 禁止删除（新装实例重播迁移会把它种回来）。
 *
 * 单向性：改的是数据库行，迁移文件不跟着变；`buildPermissionExportSql`
 * 把当前数据库状态导成 data 迁移交用户提交。
 */

import {isMenuIconName} from "./MenuIconNames";
import {
  type PermissionAudience,
  type RbacPermissionGroup,
  type RbacPermissionPage,
} from "./Rbac";

/** 管理页自建行的 id 前缀。迁移种子的行一律 `pn_*`；「可删」由 `source` 列判定。 */
export const PERMISSION_ROW_CUSTOM_ID_PREFIX = "pm_";

/** 迁移种子行的 id 前缀（与 `permissionId()` 的 `p_` 对偶，多一个 n）。 */
export const PERMISSION_ROW_SEED_ID_PREFIX = "pn_";

/** 页面节点 code 的前缀：授权视图剥掉它即得派生页 code（对偶菜单的页 code）。 */
const PAGE_NODE_CODE_PREFIX = "page_";

/** 一次批量保存允许的操作数上限（防误发整表重放）。 */
export const PERMISSION_TREE_MAX_OPS = 100;

/** 展示名列的长度上限（与列语义一致，超长直接拒绝而非截断）。 */
const PERMISSION_NODE_NAME_MAX_LENGTH = 64;

/**
 * `ext_permission_nodes` 的列清单。读取行与快照导出都按这一份书写，
 * 加列时只改这里，两个端点不会各写一套。
 */
export const PERMISSION_NODE_COLUMNS =
  "id, code, kind, parent_code, sort, audience, permission_code, name_zh, name_en, " +
  "icon, i18n_key, is_visible, source, created_at_ms";

/** `GET /ajax/rbac/permission-tree` 的一行：`ext_permission_nodes` 全列。 */
export interface PermissionNodeRow {
  /** 终端归属（ADR-0039）：两个控制台按它互斥分区。 */
  audience: PermissionAudience;
  code: string;
  createdAtMs: number;
  icon: string | null;
  id: string;
  i18nKey: string | null;
  kind: "code" | "group" | "page";
  nameEn: string | null;
  nameZh: string | null;
  parentCode: string | null;
  permissionCode: string | null;
  sort: number;
  source: "custom" | "seed";
  visible: boolean;
}

/**
 * 列表响应行：全列 + 派生位。
 * `deletable` —— 仅管理页自建行可删（种子行删了会被迁移重播回来）。
 * `editable` —— `code` 节点只能换父级与显隐，改名/图标不开放。
 */
export interface PermissionNodeRowWithMeta extends PermissionNodeRow {
  deletable: boolean;
  editable: boolean;
}

/** `ext_permission_nodes` 的一行，字段名与表列一致（snake_case），由 D1 原样交回。 */
export interface PermissionNodeTableRow {
  audience: PermissionAudience;
  code: string;
  created_at_ms: number;
  i18n_key: string | null;
  icon: string | null;
  id: string;
  is_visible: number;
  kind: PermissionNodeRow["kind"];
  name_en: string | null;
  name_zh: string | null;
  parent_code: string | null;
  permission_code: string | null;
  sort: number;
  source: PermissionNodeRow["source"];
}

/** Map a raw D1 `ext_permission_nodes` row to the shared {@link PermissionNodeRow}. */
export function toPermissionNodeRow(row: PermissionNodeTableRow): PermissionNodeRow {
  return {
    audience: row.audience,
    code: row.code,
    createdAtMs: Number(row.created_at_ms),
    icon: row.icon,
    id: row.id,
    i18nKey: row.i18n_key,
    kind: row.kind,
    nameEn: row.name_en,
    nameZh: row.name_zh,
    parentCode: row.parent_code,
    permissionCode: row.permission_code,
    sort: Number(row.sort),
    source: row.source,
    visible: Number(row.is_visible) === 1,
  };
}

/**
 * 码 → 终端归属的单一判定入口（ADR-0039 D1）。
 *
 * 归属记在节点表那条 `kind='code'` 叶子上，`ext_permissions` 不另记一份。
 * 找不到叶子时返回 `null`，含义是「该码没有挂靠点」，调用方据此 fail-closed
 * （拒绝提交），不对缺叶子的码猜一个终端。
 */
export function audienceOf(
  code: string,
  nodes: Iterable<PermissionNodeRow>,
): PermissionAudience | null {
  for (const row of nodes) {
    if (row.kind === "code" && row.permissionCode === code) return row.audience;
  }
  return null;
}

/** 绑定参数语句；`params` 一律经 `.bind(...)` 传入，不拼字面量。 */export interface PermissionSqlStatement {
  params: (string | number | null)[];
  sql: string;
}

export interface PermissionOpError {
  key: string;
  params?: Record<string, string>;
  status: number;
}

export type PermissionTreeOp =
  | {
      code: string;
      icon: string;
      nameEn: string;
      nameZh: string;
      op: "create-group";
      parentCode: string | null;
    }
  | {code: string; direction: "up" | "down"; op: "move"}
  | {code: string; op: "delete"}
  | {
      code: string;
      op: "update";
      patch: {
        icon?: string | null;
        isVisible?: boolean;
        nameEn?: string | null;
        nameZh?: string | null;
        parentCode?: string | null;
      };
    }
  | {code: string; ids: string[]; op: "reorder"; parentCode?: string | null};

/** 单条 `update` 操作的字段补丁：管理页的行内编辑与保存校验共用同一份形状。 */
export type PermissionUpdatePatch = Extract<PermissionTreeOp, {op: "update"}>["patch"];

export type PermissionPlanResult =
  | {error: PermissionOpError; statements?: undefined}
  | {error?: undefined; statements: PermissionSqlStatement[]};

/** 新建分组的 code 形状：小写字母开头，小写字母/数字/下划线，2–64 位。 */
const GROUP_CODE_PATTERN = /^[a-z][a-z0-9_]{1,63}$/u;

/**
 * 通配码：意味着「全部」。授权视图把它过滤掉——渲染成可勾选项会把一个
 * 普通角色变成超级管理员（与退役前 buildPermissionTree 同口径）。
 */
const WILDCARD = "*";

function error(
  key: string,
  status: number,
  params?: Record<string, string>,
): PermissionOpError {
  return {key, params, status};
}

function normalizeName(raw: unknown): string | null | {invalid: PermissionOpError} {
  if (raw === null) return null;
  if (typeof raw !== "string") {
    return {invalid: error("errors.permission.invalidInput", 400)};
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > PERMISSION_NODE_NAME_MAX_LENGTH) {
    return {invalid: error("errors.permission.nameTooLong", 400)};
  }
  return trimmed;
}

/** `normalizeName` 的失败分支：`{invalid}` 对象与「清空」(null) 要分开处理。 */
function isInvalidName(
  value: string | null | {invalid: PermissionOpError},
): value is {invalid: PermissionOpError} {
  return typeof value === "object" && value !== null && "invalid" in value;
}

/**
 * `code` 的所有后代（沿 parent_code 逐层下行）。行集来自快照，环不可能存在。
 * 父节点候选与保存时的成环校验共用这一份。
 */
export function nodeDescendantCodes(
  rows: Iterable<PermissionNodeRow>,
  code: string,
): Set<string> {
  const found = new Set<string>();
  const queue = [code];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const row of rows) {
      if (row.parentCode === current && !found.has(row.code)) {
        found.add(row.code);
        queue.push(row.code);
      }
    }
  }
  return found;
}

/**
 * 节点行的读取顺序：先按 `sort`，同一 `sort` 按 `code`。服务端移动判定、
 * 授权视图组装、导出 SQL 的排序都读这一份，免得行序在两个端口径不一致。
 */
export function comparePermissionNodes(
  a: PermissionNodeRow,
  b: PermissionNodeRow,
): number {
  return a.sort - b.sort || a.code.localeCompare(b.code, "en");
}

/** 授权视图里页面节点的展示 code：剥掉 `page_` 前缀即派生页 code。 */
function pageViewCode(nodeCode: string): string {
  return nodeCode.startsWith(PAGE_NODE_CODE_PREFIX)
    ? nodeCode.slice(PAGE_NODE_CODE_PREFIX.length)
    : nodeCode;
}

const UPDATE_STATEMENTS = {
  icon: "UPDATE ext_permission_nodes SET icon = ? WHERE id = ?",
  isVisible: "UPDATE ext_permission_nodes SET is_visible = ? WHERE id = ?",
  nameEn: "UPDATE ext_permission_nodes SET name_en = ? WHERE id = ?",
  nameZh: "UPDATE ext_permission_nodes SET name_zh = ? WHERE id = ?",
  parentCode: "UPDATE ext_permission_nodes SET parent_code = ? WHERE id = ?",
};

const UPDATE_SORT = "UPDATE ext_permission_nodes SET sort = ? WHERE id = ?";

const INSERT_GROUP =
  "INSERT INTO ext_permission_nodes " +
  "(id, code, kind, parent_code, sort, audience, permission_code, name_zh, " +
  "name_en, icon, i18n_key, is_visible, source, created_at_ms) " +
  "VALUES (?, ?, 'group', ?, ?, ?, NULL, ?, ?, ?, ?, 1, 'custom', ?)";

const DELETE_ROW = "DELETE FROM ext_permission_nodes WHERE id = ?";

type PermissionNameField = "nameZh" | "nameEn";

// 中英文名两列的处理完全一致，只是字段名与对应语句不同，抽出来避免重复。
function planNameUpdate(
  row: PermissionNodeRow,
  next: PermissionNodeRow,
  field: PermissionNameField,
  raw: string | null | undefined,
  statements: PermissionSqlStatement[],
): PermissionPlanResult | null {
  if (raw === undefined) return null;
  const value = normalizeName(raw);
  if (isInvalidName(value)) return {error: value.invalid};
  next[field] = value;
  statements.push({params: [value, row.id], sql: UPDATE_STATEMENTS[field]});
  return null;
}

/**
 * 父级层级规则：三层结构是 分组 → 页面 → 权限码。
 * 分组可挂分组（嵌套分组），页面只能挂分组，权限码只能挂页面；
 * 任何行都不能挂到权限码行下。
 */
function parentLevelError(
  rowKind: PermissionNodeRow["kind"],
  parent: PermissionNodeRow,
): PermissionOpError | null {
  if (parent.kind === "code") {
    return error("errors.permission.codeNodeParent", 400, {code: parent.code});
  }
  if (rowKind === "code") {
    return parent.kind === "page"
      ? null
      : error("errors.permission.codeNodeParent", 400, {code: parent.code});
  }
  return parent.kind === "group"
    ? null
    : error("errors.permission.parentLevel", 400, {code: parent.code});
}

/** 父级校验：层级规则 + 成环。`null` 表示根层，只有分组行能停在根层。 */
function planParentChange(
  rows: Map<string, PermissionNodeRow>,
  row: PermissionNodeRow,
  parentCode: string | null,
): PermissionOpError | null {
  if (parentCode === null) {
    if (row.kind === "group") return null;
    // 页面行与权限码行一旦没有父级，组装授权视图时从根分组往下走不到它们，
    // 整棵子树会从授权界面静默消失。
    return error(
      row.kind === "code"
        ? "errors.permission.codeNodeParent"
        : "errors.permission.parentLevel",
      400,
      {code: row.code},
    );
  }
  if (parentCode === row.code) {
    return error("errors.permission.cycle", 400, {code: row.code});
  }
  const parent = rows.get(parentCode);
  if (!parent) {
    return error("errors.permission.notFound", 404, {code: parentCode});
  }
  // 成环先判：把分组拖进它自己的页面下时，报「成环」比报「层级不对」更贴切。
  if (nodeDescendantCodes(rows.values(), row.code).has(parent.code)) {
    return error("errors.permission.cycle", 400, {code: row.code});
  }
  // 父子同端（ADR-0039）：跨终端重挂会让一个码在本端与对端来回漂，
  // 两端视图的分区依据当场失效。
  if (parent.audience !== row.audience) {
    return error("errors.permission.audienceMismatch", 400, {code: parent.code});
  }
  return parentLevelError(row.kind, parent);
}

function planUpdate(
  rows: Map<string, PermissionNodeRow>,
  code: string,
  patch: PermissionUpdatePatch,
): PermissionPlanResult {
  const row = rows.get(code);
  if (!row) return {error: error("errors.permission.notFound", 404, {code})};

  // `code` 节点是权限码的展示位：名字取 `ext_permissions.name`，图标无意义，
  // 只能换父级与显隐。传来名字/图标一律拒绝，不做静默忽略。
  if (row.kind === "code") {
    if (
      patch.nameZh !== undefined ||
      patch.nameEn !== undefined ||
      patch.icon !== undefined
    ) {
      return {error: error("errors.permission.invalidInput", 400, {code})};
    }
  }

  const statements: PermissionSqlStatement[] = [];
  const next: PermissionNodeRow = {...row};

  const nameErr =
    planNameUpdate(row, next, "nameZh", patch.nameZh, statements) ??
    planNameUpdate(row, next, "nameEn", patch.nameEn, statements);
  if (nameErr) return nameErr;

  if (patch.icon !== undefined) {
    if (patch.icon !== null && !isMenuIconName(patch.icon)) {
      return {error: error("errors.permission.invalidIcon", 400, {icon: String(patch.icon)})};
    }
    statements.push({params: [patch.icon, row.id], sql: UPDATE_STATEMENTS.icon});
    next.icon = patch.icon;
  }
  if (patch.isVisible !== undefined) {
    if (typeof patch.isVisible !== "boolean") {
      return {error: error("errors.permission.invalidInput", 400)};
    }
    statements.push({
      params: [patch.isVisible ? 1 : 0, row.id],
      sql: UPDATE_STATEMENTS.isVisible,
    });
    next.visible = patch.isVisible;
  }
  if (patch.parentCode !== undefined) {
    const parentCode =
      patch.parentCode === null || patch.parentCode === "" ? null : patch.parentCode;
    // 传 `null` 也要过层级校验：只有分组行能停在根层，页面行与权限码行
    // 失去父级后会从授权视图静默消失。
    const parentError = planParentChange(rows, row, parentCode);
    if (parentError) return {error: parentError};
    statements.push({params: [parentCode, row.id], sql: UPDATE_STATEMENTS.parentCode});
    next.parentCode = parentCode;
  }

  if (statements.length === 0) {
    return {error: error("errors.permission.invalidInput", 400)};
  }
  rows.set(code, next);
  return {statements};
}

function planMove(
  rows: Map<string, PermissionNodeRow>,
  code: string,
  direction: "up" | "down",
): PermissionPlanResult {
  const row = rows.get(code);
  if (!row) return {error: error("errors.permission.notFound", 404, {code})};
  const siblings = permissionNodeChildren(rows.values(), row.parentCode);
  const index = siblings.findIndex((entry) => entry.code === code);
  const adjacent = siblings[direction === "up" ? index - 1 : index + 1];
  // 边界行没有相邻兄弟：前端已禁用按钮，服务端 fail-fast，不做静默 no-op。
  if (index < 0 || !adjacent) {
    return {error: error("errors.permission.moveBlocked", 400, {code})};
  }
  const statements: PermissionSqlStatement[] = [];
  const nextRow = {...row};
  const nextAdjacent = {...adjacent};
  if (row.sort === adjacent.sort) {
    // 同层同 sort 时读取顺序由 code 决定，交换 sort 不改变显示顺序。
    // 用 ±1 把移动行挤出平级：上移排到前一个之前，下移排到后一个之后。
    nextRow.sort = direction === "up" ? row.sort - 1 : row.sort + 1;
    statements.push({params: [nextRow.sort, row.id], sql: UPDATE_SORT});
  } else {
    nextRow.sort = adjacent.sort;
    nextAdjacent.sort = row.sort;
    statements.push(
      {params: [nextRow.sort, row.id], sql: UPDATE_SORT},
      {params: [nextAdjacent.sort, adjacent.id], sql: UPDATE_SORT},
    );
  }
  rows.set(code, nextRow);
  rows.set(adjacent.code, nextAdjacent);
  return {statements};
}

function planCreateGroup(
  rows: Map<string, PermissionNodeRow>,
  op: Extract<PermissionTreeOp, {op: "create-group"}>,
  now: number,
  audience: PermissionAudience,
): PermissionPlanResult {
  const code = typeof op.code === "string" ? op.code.trim() : "";
  if (!GROUP_CODE_PATTERN.test(code)) {
    return {error: error("errors.permission.invalidCode", 400, {code: op.code ?? ""})};
  }
  if (rows.has(code)) {
    return {error: error("errors.permission.duplicateCode", 409, {code})};
  }
  const nameZh = normalizeName(op.nameZh);
  if (isInvalidName(nameZh)) return {error: nameZh.invalid};
  const nameEn = normalizeName(op.nameEn);
  if (isInvalidName(nameEn)) return {error: nameEn.invalid};
  if (!nameZh && !nameEn) {
    // 自建分组没有 `rbac.node.<code>` 的现成文案，两个名字全空就会显示裸 code，
    // 所以至少要求填一个。
    return {error: error("errors.permission.nameRequired", 400)};
  }
  if (!isMenuIconName(op.icon)) {
    return {error: error("errors.permission.invalidIcon", 400, {icon: String(op.icon)})};
  }
  const parentCode = op.parentCode === null || op.parentCode === "" ? null : op.parentCode;
  if (parentCode !== null) {
    const parent = rows.get(parentCode);
    if (!parent) {
      return {error: error("errors.permission.notFound", 404, {code: parentCode})};
    }
    const levelError = parentLevelError("group", parent);
    if (levelError) return {error: levelError};
  }

  const siblings = [...rows.values()].filter(
    (entry) => entry.parentCode === parentCode,
  );
  const maxSort = siblings.reduce((max, entry) => Math.max(max, entry.sort), 0);
  const statement: PermissionSqlStatement = {
    params: [
      `${PERMISSION_ROW_CUSTOM_ID_PREFIX}${code}`,
      code,
      parentCode,
      maxSort + 1,
      audience,
      nameZh || null,
      nameEn || null,
      op.icon,
      `rbac.node.${code}`,
      now,
    ],
    sql: INSERT_GROUP,
  };
  rows.set(code, {
    audience,
    code,
    createdAtMs: now,
    icon: op.icon,
    id: `${PERMISSION_ROW_CUSTOM_ID_PREFIX}${code}`,
    i18nKey: `rbac.node.${code}`,
    kind: "group",
    nameEn: nameEn || null,
    nameZh: nameZh || null,
    parentCode,
    permissionCode: null,
    sort: maxSort + 1,
    source: "custom",
    visible: true,
  });
  return {statements: [statement]};
}

function planDelete(
  rows: Map<string, PermissionNodeRow>,
  code: string,
): PermissionPlanResult {
  const row = rows.get(code);
  if (!row) return {error: error("errors.permission.notFound", 404, {code})};
  // 权限码节点是代码常量的展示位：删了它，该码在授权界面彻底不可达
  // （没有「新建码」的 op 补回来）。
  if (row.kind === "code") {
    return {error: error("errors.permission.codeNodeUndeletable", 400, {code})};
  }
  // 迁移种子的行不可删：删了之后重放迁移的实例会把它再播种回来，
  // 两台机器的权限树从此对不上且无从解释。`is_visible` 只影响管理页
  // 上的显示（树里画一条「已隐藏」标记），不改变授权数据。
  if (row.source === "seed") {
    return {error: error("errors.permission.seedProtected", 409, {code})};
  }
  for (const entry of rows.values()) {
    if (entry.parentCode === code) {
      return {error: error("errors.permission.hasChildren", 409, {code})};
    }
  }
  rows.delete(code);
  return {statements: [{params: [row.id], sql: DELETE_ROW}]};
}

/**
 * 树形拖拽的「移动」：在同层按 `orderedCodes` 的顺序重排，并可选地把被拖节点
 * 重挂到新父级。
 *
 * `orderedCodes` 是目标层兄弟的有序**节点 code**（含被拖项的新位置）——操作体里
 * 这个字段叫 `ids`，与菜单管理那张 op 表同名，两端共用同一份连线词；`parentCode`
 * 是该层父级（根层为 `null`）。被拖项离开的源层留下 sort 空档，由
 * `comparePermissionNodes` 容忍，不重排源层（与 `planMove` 一致）。
 */
function planReorder(
  rows: Map<string, PermissionNodeRow>,
  code: string,
  orderedCodes: string[],
  parentCode: string | null | undefined,
): PermissionPlanResult {
  const row = rows.get(code);
  if (!row) return {error: error("errors.permission.notFound", 404, {code})};
  if (!Array.isArray(orderedCodes) || orderedCodes.length === 0 || !orderedCodes.includes(code)) {
    return {error: error("errors.permission.invalidInput", 400)};
  }
  // 省略 `parentCode` = 留在原父级；显式传 `null`/空串 = 挂到根层（只对分组行成立）。
  const nextParent =
    parentCode === undefined ? row.parentCode : parentCode === "" ? null : parentCode;
  // 换层同样要过层级校验：`null` 只对分组行成立。
  const parentError = planParentChange(rows, row, nextParent);
  if (parentError) return {error: parentError};
  // 列表里必须是目标层的兄弟：混进别层的 code 会把那一层的 sort 一起改写。
  for (const siblingCode of orderedCodes) {
    if (siblingCode === code) continue;
    const sibling = rows.get(siblingCode);
    if (!sibling || sibling.parentCode !== nextParent) {
      return {error: error("errors.permission.invalidInput", 400)};
    }
  }
  const statements: PermissionSqlStatement[] = [];
  // 仅对列表里的同层兄弟按新顺序写 sort；其余兄弟的 sort 留空档。
  orderedCodes.forEach((siblingCode, index) => {
    const sibling = rows.get(siblingCode);
    if (!sibling) return;
    const targetSort = index + 1;
    if (sibling.sort !== targetSort) {
      statements.push({params: [targetSort, sibling.id], sql: UPDATE_SORT});
      rows.set(siblingCode, {...sibling, sort: targetSort});
    }
  });
  const nextRow: PermissionNodeRow = {...row, sort: orderedCodes.indexOf(code) + 1};
  if (row.parentCode !== nextParent) {
    statements.push({params: [nextParent, row.id], sql: UPDATE_STATEMENTS.parentCode});
    nextRow.parentCode = nextParent;
  }
  rows.set(code, nextRow);
  return {statements};
}

/**
 * 把一串操作规划成绑定参数语句。逐条在行快照上模拟执行（后续操作看得到
 * 前面操作的结果），任何一条校验失败即整批拒绝——不产生半套语句。
 */
export function planPermissionOps(
  rows: PermissionNodeRow[],
  ops: PermissionTreeOp[],
  now: number = Date.now(),
  // 新建分组继承行集的终端归属：端点传本端取值，未显式传时取传入行集的归属
  // （空行集才退到桌面端，此时调用方一定显式传了）。
  audience: PermissionAudience = rows[0]?.audience ?? "desktop",
): PermissionPlanResult {
  if (!Array.isArray(ops) || ops.length === 0) {
    return {error: error("errors.permission.invalidInput", 400)};
  }
  if (ops.length > PERMISSION_TREE_MAX_OPS) {
    return {error: error("errors.permission.tooManyOps", 400)};
  }
  const working = new Map(rows.map((row) => [row.code, {...row}]));
  const statements: PermissionSqlStatement[] = [];
  for (const op of ops) {
    let planned: PermissionPlanResult;
    switch (op?.op) {
      case "update":
        planned = planUpdate(working, op.code, op.patch ?? {});
        break;
      case "move":
        planned = planMove(working, op.code, op.direction);
        break;
      case "create-group":
        planned = planCreateGroup(working, op, now, audience);
        break;
      case "delete":
        planned = planDelete(working, op.code);
        break;
      case "reorder":
        planned = planReorder(working, op.code, op.ids, op.parentCode);
        break;
      default:
        return {error: error("errors.permission.invalidInput", 400)};
    }
    if (planned.error) return planned;
    statements.push(...planned.statements);
  }
  return {statements};
}

/** SQL 字符串字面量：单引号加倍转义；非字符串一律拒绝。 */
function sqlLiteral(value: string | number | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL";
  }
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * 角色编辑器（「角色管理」tab）的授权视图：自持节点 → `RbacPermissionGroup[]`。
 *
 * 形状与字段逐字节复刻退役前的 `buildPermissionTree`（ADR-0038 D2）：
 *   - 顶层组（parent_code 为空）的顺序、组内页顺序、页内码顺序都由
 *     `comparePermissionNodes` 的 `(sort, code)` 读序决定；
 *   - 页面 code 剥掉 `page_` 前缀，与派生树页 code 一致（前端标签解析零改动）；
 *   - 「空页跳过、空组跳过」语义保持一致，不渲染没有码的空壳；
 *   - 子分组的页折叠进所属顶层组（授权视图保持两层形状，任何码都可达）；
 *   - 目录里没有的码（如通配 `*`）不进视图——通配意味着「全部」，
 *     渲染成可勾选项会把普通角色变成超级管理员。
 *
 * 组/页行额外带上节点的双语名与 i18n 兜底键：标签解析走
 * `rbacTreeLabel`（双名 → 兜底键 → code），不再借菜单文案键。
 *
 * `audience` 决定这次组装属于哪个控制台（ADR-0039）：PC 端管理只看
 * `desktop` 行，App 端管理只看 `app` 行，两端互不可见。
 */
export function buildGrantGroupsFromNodes(
  nodes: PermissionNodeRow[],
  permissionNames: Map<string, string>,
  audience: PermissionAudience,
): RbacPermissionGroup[] {
  // 两个控制台互斥分区（ADR-0039）：只组装本端的行。端点读取时已经按端取过行，
  // 这里再收一次，让纯函数调用方（测试、导出）也无法把对端码带进视图。
  const ordered = nodes
    .filter((row) => row.audience === audience)
    .sort(comparePermissionNodes);
  const childrenOf = new Map<string, PermissionNodeRow[]>();
  const rootGroups: PermissionNodeRow[] = [];
  for (const row of ordered) {
    if (row.kind === "group" && row.parentCode === null) {
      rootGroups.push(row);
      continue;
    }
    if (!row.parentCode) continue;
    childrenOf.set(row.parentCode, [...(childrenOf.get(row.parentCode) ?? []), row]);
  }

  const collectPages = (parentCode: string): RbacPermissionPage[] => {
    const pages: RbacPermissionPage[] = [];
    for (const child of childrenOf.get(parentCode) ?? []) {
      if (child.kind === "page") {
        const codes = (childrenOf.get(child.code) ?? [])
          .filter((entry) => entry.kind === "code" && entry.permissionCode !== null)
          .map((entry) => entry.permissionCode as string)
          .filter((code) => code !== WILDCARD && permissionNames.has(code));
        if (codes.length === 0) continue;
        pages.push({
          code: pageViewCode(child.code),
          codes,
          i18nKey: child.i18nKey,
          nameEn: child.nameEn,
          nameZh: child.nameZh,
        });
      } else if (child.kind === "group") {
        pages.push(...collectPages(child.code));
      }
    }
    return pages;
  };

  const groups: RbacPermissionGroup[] = [];
  for (const group of rootGroups) {
    const pages = collectPages(group.code);
    if (pages.length === 0) continue;
    groups.push({
      code: group.code,
      i18nKey: group.i18nKey,
      nameEn: group.nameEn,
      nameZh: group.nameZh,
      pages,
    });
  }
  return groups;
}

/**
 * 「导出 SQL」（票据 04）：把当前权限树状态导成 data 迁移文本，交用户自行提交。
 *
 * 只写可变字段：迁移种子行（id 以 `pn_` 开头）用 `UPDATE` 改
 * `parent_code / name_zh / name_en / icon / sort / is_visible`，绝不触碰
 * `kind / permission_code / source / created_at_ms`——`permission_code` 是真实
 * 授权码，运行时改动不该把它改指到另一个码上。管理页自建行（id 以 `pm_` 开头）
 * 迁移里没有，用 `INSERT OR REPLACE` 补整行，`permission_code` 固定 NULL；
 * 整行替换意味着重放这份迁移会盖掉自建行上的手工改动，改过自建行就要重导一次。
 *
 * 自建行必须带 `audience`：它是两端分区的唯一依据（ADR-0039 D1），漏了就会在
 * 全新安装的实例上按列默认值掉进 PC 端。种子行的归属由迁移决定，不在导出范围。
 *
 * 头注释写明两件事：① `NNNN` 要改成下一个连续编号（check-migrations 门禁）；
 * ② data 迁移必须带 `-- rollback:` 块。
 */
export function buildPermissionExportSql(
  rows: PermissionNodeRow[],
  generatedAtMs: number,
): string {
  const generatedAt = new Date(generatedAtMs).toISOString();
  const ordered = [...rows].sort(comparePermissionNodes);
  const lines = [
    "-- NNNN_data_permission_nodes_snapshot.sql",
    "--",
    `-- 后台「权限树管理」页于 ${generatedAt} 导出的权限树变更（票据 04）。`,
    "-- 用途：把管理页对权限树的运行时改动回写成迁移，让全新安装的实例拿到同一份结构。",
    "-- 使用前：把文件名与本行的 NNNN 改成下一个连续编号（check-migrations 门禁要求编号连续）。",
    "--",
    "-- 范围：种子行（id 以 pn_ 开头）只写可变字段 parent_code / name_zh / name_en /",
    "-- icon / sort / is_visible，不改 kind / permission_code / source / created_at_ms；",
    "-- 管理页自建行（id 以 pm_ 开头）用 INSERT OR REPLACE 补整行，permission_code 为 NULL",
    "--",
    "-- rollback: 重放上一份权限树快照迁移；没有快照时回到种子迁移 0127 的初始结构。",
    "--",
    "-- 幂等：种子行按 id 更新，自建行按 id 插入，重复执行安全。",
    "",
  ];
  for (const row of ordered) {
    if (row.id.startsWith(PERMISSION_ROW_CUSTOM_ID_PREFIX)) {
      const values = [
        sqlLiteral(row.id),
        sqlLiteral(row.code),
        sqlLiteral(row.kind),
        sqlLiteral(row.parentCode),
        sqlLiteral(row.audience),
        sqlLiteral(row.sort),
        "NULL",
        sqlLiteral(row.nameZh),
        sqlLiteral(row.nameEn),
        sqlLiteral(row.icon),
        sqlLiteral(row.i18nKey),
        sqlLiteral(row.visible ? 1 : 0),
        sqlLiteral(row.source),
        sqlLiteral(row.createdAtMs),
      ].join(", ");
      lines.push(
        "INSERT OR REPLACE INTO ext_permission_nodes",
        "  (id, code, kind, parent_code, audience, sort, permission_code, name_zh, name_en, icon, i18n_key, is_visible, source, created_at_ms)",
        `VALUES (${values});`,
      );
      continue;
    }
    lines.push(
      "UPDATE ext_permission_nodes SET",
      `  parent_code = ${sqlLiteral(row.parentCode)},`,
      `  name_zh = ${sqlLiteral(row.nameZh)},`,
      `  name_en = ${sqlLiteral(row.nameEn)},`,
      `  icon = ${sqlLiteral(row.icon)},`,
      `  sort = ${sqlLiteral(row.sort)},`,
      `  is_visible = ${sqlLiteral(row.visible ? 1 : 0)}`,
      `WHERE id = ${sqlLiteral(row.id)};`,
    );
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// 树视图纯函数（票据 05 的管理页 UI 层）。
//
// 与 `MenuTreeView` 对偶：那边服务菜单行，这边服务权限节点行。两侧各自的
// 树交互（展开、手风琴、拖拽三段位、本地预览）都只有这一份口径，
// 组件层不再各算一遍。
// ---------------------------------------------------------------------------

/** 拖拽放置位置的三段：目标节点上/下沿为同层 before/after，中部为 inside。 */
export type PermissionDropPosition = "before" | "after" | "inside";

/** 取某父级下的直接子节点，按 `(sort, code)` 读序排列；根层传 `null`。 */
export function permissionNodeChildren<T extends PermissionNodeRow>(
  rows: Iterable<T>,
  parentCode: string | null,
): T[] {
  const target = parentCode ?? null;
  return [...rows]
    .filter((row) => row.parentCode === target)
    .sort(comparePermissionNodes);
}

/** 一行在同层兄弟里的位置：上移/下移按钮禁用态与拖拽手柄键盘移动共用。 */
export function permissionSiblingPosition(
  rows: Iterable<PermissionNodeRow>,
  code: string,
): {canDown: boolean; canUp: boolean} {
  const all = [...rows];
  const row = all.find((entry) => entry.code === code);
  if (!row) return {canDown: false, canUp: false};
  const siblings = permissionNodeChildren(all, row.parentCode);
  const index = siblings.findIndex((entry) => entry.code === code);
  return {canDown: index < siblings.length - 1, canUp: index > 0};
}

/** 顶层祖先：沿 `parentCode` 链向上走到根。不在集合里返回 null。 */
export function permissionTopAncestorCode(
  rows: Iterable<PermissionNodeRow>,
  code: string,
): string | null {
  const byCode = new Map([...rows].map((row) => [row.code, row]));
  let current = byCode.get(code) ?? null;
  while (current?.parentCode) {
    const parent = byCode.get(current.parentCode) ?? null;
    if (!parent) break;
    current = parent;
  }
  return current?.code ?? null;
}

/**
 * 手风琴展开位：键 = `${scope}:${parentCode ?? ""}`，值 = 该父下唯一展开的子。
 * 一个父只存一个子，因此状态本身就把「同层只展开一个」固定住——展开别的
 * 分支等于改写同一个键，兄弟自然折叠。
 */
export type PermissionAccordionState = Record<string, string | null>;

function permissionAccordionKey(scope: string, parentCode: string | null): string {
  return `${scope}:${parentCode ?? ""}`;
}

/** 某父下当前展开的子；null = 该父全折叠。 */
export function permissionAccordionOpen(
  state: PermissionAccordionState,
  scope: string,
  parentCode: string | null,
): string | null {
  return state[permissionAccordionKey(scope, parentCode)] ?? null;
}

/** 切换一行：已展开则折回，否则抢占该父的展开位（兄弟自动折叠）。 */
export function permissionAccordionToggle(
  state: PermissionAccordionState,
  scope: string,
  parentCode: string | null,
  code: string,
): PermissionAccordionState {
  const key = permissionAccordionKey(scope, parentCode);
  return state[key] === code ? {...state, [key]: null} : {...state, [key]: code};
}

/** 行集 → 折叠态映射（`PermissionTreeNode` 读的那一份）。 */
export function permissionAccordionCollapsed<T extends PermissionNodeRow>(
  rows: Iterable<T>,
  state: PermissionAccordionState,
  scope: string,
): Record<string, boolean> {
  const collapsed: Record<string, boolean> = {};
  for (const row of rows) {
    collapsed[row.code] = permissionAccordionOpen(state, scope, row.parentCode) !== row.code;
  }
  return collapsed;
}

/**
 * 定位到某行：祖先链上每一层的展开位都指向这条链。手风琴下每层只有一个
 * 展开位，所以定位不会让别的分支留着一半展开。码不在集合里时原样返回。
 */
export function permissionAccordionReveal<T extends PermissionNodeRow>(
  rows: Iterable<T>,
  state: PermissionAccordionState,
  scope: string,
  code: string,
): PermissionAccordionState {
  const byCode = new Map([...rows].map((row) => [row.code, row]));
  if (!byCode.has(code)) return state;
  const next = {...state};
  let child = code;
  let parent = byCode.get(child)?.parentCode ?? null;
  for (;;) {
    next[permissionAccordionKey(scope, parent)] = child;
    if (parent === null) break;
    child = parent;
    parent = byCode.get(child)?.parentCode ?? null;
  }
  return next;
}

/**
 * 一次放置是否合法（服务端口径的前置 mirror）：
 *   - 跨终端一律不合法（两个控制台互斥分区）；
 *   - `before/after`：只在同类行之间换序（group↔group、page↔page、code↔code），
 *     可改父级；`inside`：目标必须是 group/page，被拖项是 code 时目标还必须
 *     是 page（权限码只挂页面下）；
 *   - 任何放置位置都禁成环：新父级（inside 取目标行、before/after 取目标行的父级）
 *     是被拖项自身或其后代时，拖进去会让祖先链断层，预览阶段就不给放置位置，
 *     比让用户拖完看报错好。
 */
export function permissionNodeDropAllowed(
  rows: Iterable<PermissionNodeRow>,
  dragged: PermissionNodeRow,
  target: PermissionNodeRow,
  position: PermissionDropPosition,
): boolean {
  if (dragged.code === target.code) return false;
  // 两个终端互斥分区（ADR-0039）：跨端放置一律不放行。
  if (dragged.audience !== target.audience) return false;
  if (position === "inside") {
    if (target.kind === "code") return false;
    // 三层结构：权限码只进页面，页面与分组只进分组（分组可嵌套）。
    if (dragged.kind === "code" ? target.kind !== "page" : target.kind !== "group") {
      return false;
    }
  } else if (dragged.kind !== target.kind) {
    return false;
  }
  const newParent = position === "inside" ? target.code : (target.parentCode ?? null);
  if (newParent === dragged.code) return false;
  return newParent === null || !nodeDescendantCodes(rows, dragged.code).has(newParent);
}

/**
 * 把被拖节点按放置位置移进目标层：before/after 同层重排（可改父级），
 * inside 挂到目标行下。返回新行集供本地预览，与服务端 `planReorder` 口径
 * 一致（ids = 目标层有序 code，parentCode = 目标层父级）；成环时原样返回，
 * 交由服务端兜底拦截。
 */
export function reorderPermissionNodes<T extends PermissionNodeRow>(
  rows: T[],
  draggedCode: string,
  targetCode: string,
  position: PermissionDropPosition,
): T[] {
  if (draggedCode === targetCode) return rows;
  const target = rows.find((entry) => entry.code === targetCode);
  if (!target) return rows;
  const dragged = rows.find((entry) => entry.code === draggedCode);
  if (!dragged) return rows;
  if (!permissionNodeDropAllowed(rows, dragged, target, position)) return rows;

  const newParent = position === "inside" ? targetCode : (target.parentCode ?? null);
  // 环：新父级是被拖项的后代 → 不改，避免本地预览就破结构。
  if (newParent && nodeDescendantCodes(rows, draggedCode).has(newParent)) return rows;

  const siblings = permissionNodeChildren(rows, newParent).filter(
    (entry) => entry.code !== draggedCode,
  );
  const insertIndex = position === "inside"
    ? siblings.length
    : siblings.findIndex((entry) => entry.code === targetCode);
  if (insertIndex < 0) return rows;
  siblings.splice(insertIndex, 0, dragged);

  const reordered = rows.map((entry) => {
    if (entry.code === draggedCode) {
      return {...entry, parentCode: newParent, sort: siblings.indexOf(entry) + 1};
    }
    const siblingIndex = siblings.findIndex((sibling) => sibling.code === entry.code);
    if (siblingIndex >= 0) return {...entry, sort: siblingIndex + 1};
    return entry;
  });
  // 无变化则原样返回：被拖项父级没动，且目标层按 (sort, code) 的读序也没变。
  // 注意 reordered 由 rows.map 产出，数组位置永不改动，新顺序只存在于
  // sort 值里，所以只能比对排序后的 code 序列，不能逐位比 sort 数值
  // （sort 会被重新 derive 成 1..n，稀疏旧值永远判为「变了」）。
  const beforeOrder = permissionNodeChildren(rows, newParent).map((entry) => entry.code);
  const afterOrder = permissionNodeChildren(reordered, newParent).map((entry) => entry.code);
  const orderUnchanged = beforeOrder.length === afterOrder.length
    && beforeOrder.every((code, index) => code === afterOrder[index]);
  const parentUnchanged = dragged.parentCode === newParent;
  return parentUnchanged && orderUnchanged ? rows : reordered;
}

/**
 * 父级下拉候选：排除自身与自身后代（成环）、排除 code 行（任何行都不得挂到
 * 权限码下）、排除对端行（跨终端不重挂），再按三层结构收窄——权限码只列页面行，
 * 页面行与分组行只列分组行。
 */
export function permissionParentCandidates<T extends PermissionNodeRow>(
  rows: Iterable<T>,
  code: string,
): T[] {
  const all = [...rows];
  const row = all.find((entry) => entry.code === code);
  const excluded = row ? nodeDescendantCodes(all, row.code) : new Set<string>();
  excluded.add(code);
  return all.filter((candidate) => {
    if (excluded.has(candidate.code)) return false;
    if (candidate.kind === "code") return false;
    // 跨终端不列：换了端就等于把码搬到对方控制台，两端分区当场失效。
    if (row && candidate.audience !== row.audience) return false;
    return row?.kind === "code" ? candidate.kind === "page" : candidate.kind === "group";
  });
}
