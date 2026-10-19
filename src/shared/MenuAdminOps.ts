/**
 * 菜单管理页的纯操作逻辑（票 04）。
 *
 * 这里只有「校验 + 生成绑定参数语句」，不碰 D1、不碰 `cloudflare:workers`：
 * 执行在 `src/server/admin/menu-admin-handlers.ts`，校验在本模块，所以单测可以
 * 直接喂行数组断言错误与语句，不需要 miniflare。
 *
 * 能力边界：管理页能改的是「怎么摆」和「叫什么」——
 *   重命名（name_zh / name_en）、改图标、上移下移、显隐、改父节点、
 *   新建纯分组、删除管理页自建的行；
 * 不能改的是「能打开什么」——`path` 与 `permission_code` 不开放，可达性继续由
 * 迁移 + admin-page-guards 门禁说了算。
 *
 * 单向性：改的是数据库行，迁移文件不跟着变；`buildMenuExportSql`
 * 把当前数据库状态导成 data 迁移交用户提交。
 */

import {isMenuIconName} from "./MenuIconNames";

/** 管理页自建行的 id 前缀。迁移种子的行一律 `m_*`，据此区分「可删」。 */
export const MENU_ROW_CUSTOM_ID_PREFIX = "mm_";

/** 一次批量保存允许的操作数上限（防误发整表重放）。 */
export const MENU_ADMIN_MAX_OPS = 100;

/** 展示名列的长度上限（与列语义一致，超长直接拒绝而非截断）。 */
export const MENU_ADMIN_NAME_MAX_LENGTH = 64;

/** `GET /ajax/menu` 的一行：`ext_menu` 的全列，含不可见行。 */
export interface MenuAdminRow {
  code: string;
  createdAtMs: number;
  i18nKey: string;
  icon: string | null;
  id: string;
  nameEn: string | null;
  nameZh: string | null;
  parentCode: string | null;
  path: string;
  permissionCode: string | null;
  sort: number;
  visible: boolean;
}

/** `GET /ajax/menu` 的响应行：表全列 + 是否可删（仅管理页自建行可删）。 */
export interface MenuAdminRowWithMeta extends MenuAdminRow {
  deletable: boolean;
}

/** 绑定参数语句；`params` 一律经 `.bind(...)` 传入，不拼字面量。 */
export interface MenuSqlStatement {
  params: (string | number | null)[];
  sql: string;
}

export interface MenuOpError {
  key: string;
  params?: Record<string, string>;
  status: number;
}

export type MenuAdminOp =
  | {
      code: string;
      op: "create-group";
      icon: string;
      nameEn: string;
      nameZh: string;
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
  | {code: string; op: "reorder"; ids: string[]; parentCode?: string | null};

/** 单条 `update` 操作的字段补丁：管理页的行内编辑与保存校验共用同一份形状。 */
export type MenuUpdatePatch = Extract<MenuAdminOp, {op: "update"}>["patch"];

export type MenuPlanResult =
  | {error: MenuOpError; statements?: undefined}
  | {error?: undefined; statements: MenuSqlStatement[]};

/** 新建分组的 code 形状：小写字母开头，小写字母/数字/下划线，2–64 位。 */
const GROUP_CODE_PATTERN = /^[a-z][a-z0-9_]{1,63}$/u;

function error(key: string, status: number, params?: Record<string, string>): MenuOpError {
  return {key, params, status};
}

function normalizeName(raw: unknown): string | null | {invalid: MenuOpError} {
  if (raw === null) return null;
  if (typeof raw !== "string") {
    return {invalid: error("errors.menu.invalidInput", 400)};
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > MENU_ADMIN_NAME_MAX_LENGTH) {
    return {invalid: error("errors.menu.nameTooLong", 400)};
  }
  return trimmed;
}

/** `normalizeName` 的失败分支：`{invalid}` 对象与「清空」(null) 要分开处理。 */
function isInvalidName(
  value: string | null | {invalid: MenuOpError},
): value is {invalid: MenuOpError} {
  return typeof value === "object" && value !== null && "invalid" in value;
}

/**
 * `code` 的所有后代（沿 parent_code 逐层下行）。行集来自快照，环不可能存在。
 * 管理页的父节点候选与保存时的成环校验共用这一份。
 */
export function menuDescendantCodes(
  rows: Iterable<MenuAdminRow>,
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
 * 菜单行的读取顺序：先按 `sort`，同一 `sort` 按 `code`。服务端移动判定
 * （`siblingsOf`）、导出 SQL 的排序、客户端上移/下移的禁用态都读这一份，
 * 免得行序在两个端口径不一致时，按钮禁用状态与 `errors.menu.moveBlocked`
 * 对不上。
 */
export function compareMenuRows(a: MenuAdminRow, b: MenuAdminRow): number {
  return a.sort - b.sort || a.code.localeCompare(b.code, "en");
}

/** 同层兄弟（父级相同，含「同为根」），按读取顺序 `(sort, code)` 排列。 */
function siblingsOf(rows: Map<string, MenuAdminRow>, row: MenuAdminRow): MenuAdminRow[] {
  return [...rows.values()]
    .filter((entry) => entry.parentCode === row.parentCode)
    .sort(compareMenuRows);
}

const UPDATE_STATEMENTS = {
  icon: "UPDATE ext_menu SET icon = ? WHERE id = ?",
  isVisible: "UPDATE ext_menu SET is_visible = ? WHERE id = ?",
  nameEn: "UPDATE ext_menu SET name_en = ? WHERE id = ?",
  nameZh: "UPDATE ext_menu SET name_zh = ? WHERE id = ?",
  parentCode: "UPDATE ext_menu SET parent_code = ? WHERE id = ?",
};

const UPDATE_SORT = "UPDATE ext_menu SET sort = ? WHERE id = ?";

const INSERT_GROUP =
  "INSERT INTO ext_menu (id, code, parent_code, path, i18n_key, icon, " +
  "permission_code, sort, is_visible, created_at_ms, name_zh, name_en) " +
  "VALUES (?, ?, ?, '', ?, ?, NULL, ?, 1, ?, ?, ?)";

const DELETE_ROW = "DELETE FROM ext_menu WHERE id = ?";

type MenuNameField = "nameZh" | "nameEn";

// 中英文名两列的处理完全一致，只是字段名与对应语句不同，抽出来避免重复。
function planNameUpdate(
  row: MenuAdminRow,
  next: MenuAdminRow,
  field: MenuNameField,
  raw: string | null | undefined,
  statements: MenuSqlStatement[],
): MenuPlanResult | null {
  if (raw === undefined) return null;
  const value = normalizeName(raw);
  if (isInvalidName(value)) return {error: value.invalid};
  next[field] = value;
  statements.push({params: [value, row.id], sql: UPDATE_STATEMENTS[field]});
  return null;
}

function planUpdate(
  rows: Map<string, MenuAdminRow>,
  code: string,
  patch: MenuUpdatePatch,
): MenuPlanResult | MenuSqlStatement[] {
  const row = rows.get(code);
  if (!row) return {error: error("errors.menu.notFound", 404, {code})};

  const statements: MenuSqlStatement[] = [];
  const next: MenuAdminRow = {...row};

  const nameErr =
    planNameUpdate(row, next, "nameZh", patch.nameZh, statements) ??
    planNameUpdate(row, next, "nameEn", patch.nameEn, statements);
  if (nameErr) return nameErr;

  if (patch.icon !== undefined) {
    if (patch.icon !== null && !isMenuIconName(patch.icon)) {
      return {error: error("errors.menu.invalidIcon", 400, {icon: String(patch.icon)})};
    }
    // 改图标只从图标清单里选。`path` 非空的页面行清空图标会在侧栏静默回退成
    // list 图标，管理页两端说法就对不上了；NULL 图标只属于分组行（有子节点的
    // 行本就不显示图标）。
    if (patch.icon === null && row.path !== "") {
      return {error: error("errors.menu.iconRequired", 400, {code})};
    }
    statements.push({params: [patch.icon, row.id], sql: UPDATE_STATEMENTS.icon});
    next.icon = patch.icon;
  }
  if (patch.isVisible !== undefined) {
    if (typeof patch.isVisible !== "boolean") {
      return {error: error("errors.menu.invalidInput", 400)};
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
    if (parentCode !== null) {
      if (parentCode === code) {
        return {error: error("errors.menu.cycle", 400, {code})};
      }
      if (!rows.has(parentCode)) {
        return {error: error("errors.menu.notFound", 404, {code: parentCode})};
      }
      if (menuDescendantCodes(rows.values(), code).has(parentCode)) {
        return {error: error("errors.menu.cycle", 400, {code})};
      }
    }
    statements.push({params: [parentCode, row.id], sql: UPDATE_STATEMENTS.parentCode});
    next.parentCode = parentCode;
  }

  if (statements.length === 0) {
    return {error: error("errors.menu.invalidInput", 400)};
  }
  rows.set(code, next);
  return statements;
}

function planMove(
  rows: Map<string, MenuAdminRow>,
  code: string,
  direction: "up" | "down",
): MenuPlanResult | MenuSqlStatement[] {
  const row = rows.get(code);
  if (!row) return {error: error("errors.menu.notFound", 404, {code})};
  const siblings = siblingsOf(rows, row);
  const index = siblings.findIndex((entry) => entry.code === code);
  const adjacent = siblings[direction === "up" ? index - 1 : index + 1];
  // 边界行没有相邻兄弟：前端已禁用按钮，服务端 fail-fast，不做静默 no-op。
  if (index < 0 || !adjacent) {
    return {error: error("errors.menu.moveBlocked", 400, {code})};
  }
  const statements: MenuSqlStatement[] = [];
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
  return statements;
}

function planCreateGroup(
  rows: Map<string, MenuAdminRow>,
  op: Extract<MenuAdminOp, {op: "create-group"}>,
  now: number,
): MenuPlanResult | MenuSqlStatement[] {
  const code = typeof op.code === "string" ? op.code.trim() : "";
  if (!GROUP_CODE_PATTERN.test(code)) {
    return {error: error("errors.menu.invalidCode", 400, {code: op.code ?? ""})};
  }
  if (rows.has(code)) {
    return {error: error("errors.menu.duplicateCode", 409, {code})};
  }
  const nameZh = normalizeName(op.nameZh);
  if (isInvalidName(nameZh)) return {error: nameZh.invalid};
  const nameEn = normalizeName(op.nameEn);
  if (isInvalidName(nameEn)) return {error: nameEn.invalid};
  if (!nameZh && !nameEn) {
    // 自建分组没有 `menu.item.<code>` 的 i18n 回退文案，两个名字全空就会在
    // 侧栏显示裸 i18n key，所以至少要求填一个。
    return {error: error("errors.menu.nameRequired", 400)};
  }
  if (!isMenuIconName(op.icon)) {
    return {error: error("errors.menu.invalidIcon", 400, {icon: String(op.icon)})};
  }
  const parentCode =
    op.parentCode === null || op.parentCode === "" ? null : op.parentCode;
  if (parentCode !== null && !rows.has(parentCode)) {
    return {error: error("errors.menu.notFound", 404, {code: parentCode})};
  }

  const siblings = [...rows.values()].filter(
    (entry) => entry.parentCode === parentCode,
  );
  const maxSort = siblings.reduce((max, entry) => Math.max(max, entry.sort), 0);
  const statement: MenuSqlStatement = {
    params: [
      `${MENU_ROW_CUSTOM_ID_PREFIX}${code}`,
      code,
      parentCode,
      `menu.item.${code}`,
      op.icon,
      maxSort + 1,
      now,
      nameZh || null,
      nameEn || null,
    ],
    sql: INSERT_GROUP,
  };
  rows.set(code, {
    code,
    createdAtMs: now,
    i18nKey: `menu.item.${code}`,
    icon: op.icon,
    id: `${MENU_ROW_CUSTOM_ID_PREFIX}${code}`,
    nameEn: nameEn || null,
    nameZh: nameZh || null,
    parentCode,
    path: "",
    permissionCode: null,
    sort: maxSort + 1,
    visible: true,
  });
  return [statement];
}

function planDelete(
  rows: Map<string, MenuAdminRow>,
  code: string,
): MenuPlanResult | MenuSqlStatement[] {
  const row = rows.get(code);
  if (!row) return {error: error("errors.menu.notFound", 404, {code})};
  // 迁移种子的行只允许隐藏（删除仅限管理页自建行），否则新装实例
  // 重放迁移会把它再播种回来，两台机器的菜单从此对不上且无从解释。
  if (!row.id.startsWith(MENU_ROW_CUSTOM_ID_PREFIX)) {
    return {error: error("errors.menu.seedProtected", 409, {code})};
  }
  for (const entry of rows.values()) {
    if (entry.parentCode === code) {
      return {error: error("errors.menu.hasChildren", 409, {code})};
    }
  }
  rows.delete(code);
  return [{params: [row.id], sql: DELETE_ROW}];
}

/**
 * 树形拖拽的「移动」：在同层按 `ids` 顺序重排，并可选地把被拖节点重挂到新父级。
 *
 * `ids` 是目标层兄弟的有序 code（含被拖项的新位置）；`parentCode` 是该层父级
 * （根层为 `null`）。被拖项离开的源层留下 sort 空档，由 `compareMenuRows` 容忍，
 * 不重排源层（与 `planMove` 一致）。
 */
function planReorder(
  rows: Map<string, MenuAdminRow>,
  code: string,
  ids: string[],
  parentCode: string | null,
): MenuPlanResult | MenuSqlStatement[] {
  const row = rows.get(code);
  if (!row) return {error: error("errors.menu.notFound", 404, {code})};
  if (!Array.isArray(ids) || ids.length === 0 || !ids.includes(code)) {
    return {error: error("errors.menu.invalidInput", 400)};
  }
  const nextParent =
    parentCode === null || parentCode === "" ? null : parentCode;
  if (nextParent !== null) {
    if (nextParent === code) {
      return {error: error("errors.menu.cycle", 400, {code})};
    }
    if (!rows.has(nextParent)) {
      return {error: error("errors.menu.notFound", 404, {code: nextParent})};
    }
    if (menuDescendantCodes(rows.values(), code).has(nextParent)) {
      return {error: error("errors.menu.cycle", 400, {code})};
    }
  }
  const statements: MenuSqlStatement[] = [];
  // 仅对 ids 列出的同层兄弟按新顺序写 sort；其余兄弟的 sort 留空档。
  ids.forEach((id, index) => {
    const sibling = rows.get(id);
    if (!sibling) return;
    const targetSort = index + 1;
    if (sibling.sort !== targetSort) {
      statements.push({params: [targetSort, sibling.id], sql: UPDATE_SORT});
      rows.set(id, {...sibling, sort: targetSort});
    }
  });
  const nextRow: MenuAdminRow = {...row, sort: ids.indexOf(code) + 1};
  if (row.parentCode !== nextParent) {
    statements.push({params: [nextParent, row.id], sql: UPDATE_STATEMENTS.parentCode});
    nextRow.parentCode = nextParent;
  }
  rows.set(code, nextRow);
  return statements;
}

/**
 * 把一串操作规划成绑定参数语句。逐条在行快照上模拟执行（后续操作看得到
 * 前面操作的结果），任何一条校验失败即整批拒绝——不产生半套语句。
 */
export function planMenuOps(
  rows: MenuAdminRow[],
  ops: MenuAdminOp[],
  now: number = Date.now(),
): MenuPlanResult {
  if (!Array.isArray(ops) || ops.length === 0) {
    return {error: error("errors.menu.invalidInput", 400)};
  }
  if (ops.length > MENU_ADMIN_MAX_OPS) {
    return {error: error("errors.menu.tooManyOps", 400)};
  }
  const working = new Map(rows.map((row) => [row.code, {...row}]));
  const statements: MenuSqlStatement[] = [];
  for (const op of ops) {
    let planned: MenuPlanResult | MenuSqlStatement[];
    switch (op?.op) {
      case "update":
        planned = planUpdate(working, op.code, op.patch ?? {});
        break;
      case "move":
        planned = planMove(working, op.code, op.direction);
        break;
      case "create-group":
        planned = planCreateGroup(working, op, now);
        break;
      case "delete":
        planned = planDelete(working, op.code);
        break;
      case "reorder":
        planned = planReorder(working, op.code, op.ids, op.parentCode ?? null);
        break;
      default:
        return {error: error("errors.menu.invalidInput", 400)};
    }
    if (!Array.isArray(planned)) return planned;
    statements.push(...planned);
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
 * 「导出 SQL」（票 04）：把当前菜单状态导成 data 迁移文本，交用户自行提交。
 *
 * 只写可变字段：迁移种子行（id 以 `m_` 开头）用 `UPDATE` 改
 * `parent_code / name_zh / name_en / icon / sort / is_visible`，绝不触碰
 * `path / permission_code / i18n_key / created_at_ms`——前两列是「菜单可见 ⇔ 页面可达」
 * 的前提，运行时改动不该覆盖它们。管理页自建行（id 以 `mm_` 开头）迁移里没有，
 * 用 `INSERT` 补齐整行，`path` 固定空串、`permission_code` 固定 NULL。
 *
 * 头注释写明两件事：① `NNNN` 要改成下一个连续编号（check-migrations 门禁）；
 * ② data 迁移必须带 `-- rollback:` 块。
 */
export function buildMenuExportSql(rows: MenuAdminRow[], generatedAtMs: number): string {
  const generatedAt = new Date(generatedAtMs).toISOString();
  const ordered = [...rows].sort(compareMenuRows);
  const lines = [
    "-- NNNN_data_menu_snapshot.sql",
    "--",
    `-- 后台「菜单管理」页于 ${generatedAt} 导出的菜单变更（票 04）。`,
    "-- 用途：把管理页对菜单的运行时改动回写成迁移，让全新安装的实例拿到同一份结构。",
    "-- 使用前：把文件名与本行的 NNNN 改成下一个连续编号（check-migrations 门禁要求编号连续）。",
    "--",
    "-- 范围：种子行（id 以 m_ 开头）只写可变字段 parent_code / name_zh / name_en /",
    "-- icon / sort / is_visible，不改 path / permission_code / i18n_key / created_at_ms；",
    "-- 管理页自建行（id 以 mm_ 开头）用 INSERT 补齐整行，path 为空串、permission_code 为 NULL。",
    "--",
    "-- rollback: 重放上一份菜单快照迁移；没有快照时回到种子迁移的初始结构。",
    "--",
    "-- 幂等：种子行按 id 更新，自建行按 id 插入，重复执行安全。",
    "",
  ];
  for (const row of ordered) {
    if (row.id.startsWith(MENU_ROW_CUSTOM_ID_PREFIX)) {
      const values = [
        sqlLiteral(row.id),
        sqlLiteral(row.code),
        sqlLiteral(row.parentCode),
        "''",
        sqlLiteral(row.i18nKey),
        sqlLiteral(row.icon),
        "NULL",
        sqlLiteral(row.sort),
        sqlLiteral(row.visible ? 1 : 0),
        sqlLiteral(row.createdAtMs),
        sqlLiteral(row.nameZh),
        sqlLiteral(row.nameEn),
      ].join(", ");
      lines.push(
        "INSERT OR REPLACE INTO ext_menu",
        "  (id, code, parent_code, path, i18n_key, icon, permission_code, sort, is_visible, created_at_ms, name_zh, name_en)",
        `VALUES (${values});`,
      );
      continue;
    }
    lines.push(
      "UPDATE ext_menu SET",
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
