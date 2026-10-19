import {describe, expect, it} from "vitest";

import {MENU_ICONS} from "@/components/admin/AdminMenuItemLink";
import {translate} from "@/shared/i18n";
import {MENU_ICON_NAMES} from "@/shared/MenuIconNames";
import {
  buildMenuExportSql,
  MENU_ROW_CUSTOM_ID_PREFIX,
  planMenuOps,
  type MenuAdminOp,
  type MenuAdminRow,
} from "@/shared/MenuAdminOps";

function row(overrides: Partial<MenuAdminRow> = {}): MenuAdminRow {
  return {
    code: "books",
    createdAtMs: 1700000000000,
    i18nKey: "menu.item.books",
    icon: "book",
    id: "m_books",
    nameEn: null,
    nameZh: null,
    parentCode: null,
    path: "books",
    permissionCode: "content:book:read",
    sort: 90,
    visible: true,
    ...overrides,
  };
}

/** 组 → 两页 + 管理页自建的组，覆盖 update/move/create/delete 的行集。 */
function baseRows(): MenuAdminRow[] {
  return [
    row({code: "group_content", i18nKey: "menu.item.group_content", icon: null, id: "m_group_content", nameZh: null, parentCode: null, path: "", permissionCode: null, sort: 200}),
    row({code: "books", parentCode: "group_content", sort: 201}),
    row({code: "volumes", i18nKey: "menu.item.volumes", id: "m_volumes", parentCode: "group_content", sort: 202}),
    row({code: "custom_dir", id: `${MENU_ROW_CUSTOM_ID_PREFIX}custom_dir`, parentCode: "group_content", path: "", permissionCode: null, sort: 203}),
    row({code: "child_of_custom", id: `${MENU_ROW_CUSTOM_ID_PREFIX}child_of_custom`, parentCode: "custom_dir", path: "", permissionCode: null, sort: 1}),
  ];
}

function expectError(result: ReturnType<typeof planMenuOps>, key: string, status: number): void {
  expect(result.error?.key).toBe(key);
  expect(result.error?.status).toBe(status);
  expect(result.statements).toBeUndefined();
}

describe("planMenuOps update", () => {
  it("trims names, maps empty strings to NULL, and keeps everything on bound params", () => {
    const plan = planMenuOps(baseRows(), [
      {code: "books", op: "update", patch: {nameEn: "  Book List  ", nameZh: ""}},
    ]);
    expect(plan.error).toBeUndefined();
    expect(plan.statements).toHaveLength(2);
    for (const statement of plan.statements ?? []) {
      // 全部值走占位符：SQL 文本里不允许出现任何字符串字面量。
      expect(statement.sql).toContain("?");
      expect(statement.sql).not.toContain("'");
    }
    const trimmed = plan.statements?.find((s) => s.sql.includes("name_en"));
    expect(trimmed?.params).toEqual(["Book List", "m_books"]);
    const cleared = plan.statements?.find((s) => s.sql.includes("name_zh"));
    expect(cleared?.params).toEqual([null, "m_books"]);
  });

  it("rejects over-long names, unknown icons, missing rows and empty patches", () => {
    expectError(
      planMenuOps(baseRows(), [{code: "books", op: "update", patch: {nameZh: "名".repeat(65)}}]),
      "errors.menu.nameTooLong",
      400,
    );
    expectError(
      planMenuOps(baseRows(), [{code: "books", op: "update", patch: {icon: "not-an-icon"}}]),
      "errors.menu.invalidIcon",
      400,
    );
    expectError(
      planMenuOps(baseRows(), [{code: "nope", op: "update", patch: {nameZh: "x"}}]),
      "errors.menu.notFound",
      404,
    );
    expectError(
      planMenuOps(baseRows(), [{code: "books", op: "update", patch: {}}]),
      "errors.menu.invalidInput",
      400,
    );
  });

  it("页面行不允许清空图标，分组行可以", () => {
    // 页面行（path 非空）清图标会在侧栏静默回退成 list 图标，只有分组行可以无图标。
    expectError(
      planMenuOps(baseRows(), [{code: "books", op: "update", patch: {icon: null}}]),
      "errors.menu.iconRequired",
      400,
    );
    const plan = planMenuOps(baseRows(), [{code: "group_content", op: "update", patch: {icon: null}}]);
    expect(plan.error).toBeUndefined();
    expect(plan.statements).toEqual([
      {params: [null, "m_group_content"], sql: "UPDATE ext_menu SET icon = ? WHERE id = ?"},
    ]);
  });

  it("refuses to re-parent a row under itself or one of its descendants", () => {
    expectError(
      planMenuOps(baseRows(), [{code: "books", op: "update", patch: {parentCode: "books"}}]),
      "errors.menu.cycle",
      400,
    );
    // group_content 挂到自己的孙子 volumes 下 = 成环。
    expectError(
      planMenuOps(baseRows(), [{code: "group_content", op: "update", patch: {parentCode: "volumes"}}]),
      "errors.menu.cycle",
      400,
    );
    // 合法的改父节点：volumes 升到顶层。
    const plan = planMenuOps(baseRows(), [{code: "volumes", op: "update", patch: {parentCode: null}}]);
    expect(plan.error).toBeUndefined();
    expect(plan.statements?.[0]?.sql).toBe("UPDATE ext_menu SET parent_code = ? WHERE id = ?");
    expect(plan.statements?.[0]?.params).toEqual([null, "m_volumes"]);
  });

  it("treats an empty-string parent as the top level (NULL)", () => {
    const plan = planMenuOps(baseRows(), [{code: "books", op: "update", patch: {parentCode: ""}}]);
    expect(plan.statements?.[0]?.params).toEqual([null, "m_books"]);
  });
});

describe("planMenuOps move", () => {
  it("swaps sorts with the adjacent sibling in the same parent", () => {
    const plan = planMenuOps(baseRows(), [{code: "books", direction: "down", op: "move"}]);
    expect(plan.error).toBeUndefined();
    expect(plan.statements).toEqual([
      {params: [202, "m_books"], sql: "UPDATE ext_menu SET sort = ? WHERE id = ?"},
      {params: [201, "m_volumes"], sql: "UPDATE ext_menu SET sort = ? WHERE id = ?"},
    ]);
  });

  it("breaks equal sorts with ±1 so the swap actually changes display order", () => {
    const rows = [
      row({code: "a", id: "m_a", parentCode: "p", sort: 5}),
      row({code: "b", id: "m_b", parentCode: "p", sort: 5}),
    ];
    // (sort, code) 序中 b 在后；b 上移与 a 平级 → b 挤出 4，排到 a 之前。
    const plan = planMenuOps(rows, [{code: "b", direction: "up", op: "move"}]);
    expect(plan.statements).toEqual([
      {params: [4, "m_b"], sql: "UPDATE ext_menu SET sort = ? WHERE id = ?"},
    ]);
  });

  it("refuses moves beyond the edge of the sibling run", () => {
    expectError(
      planMenuOps(baseRows(), [{code: "books", direction: "up", op: "move"}]),
      "errors.menu.moveBlocked",
      400,
    );
    expectError(
      planMenuOps(baseRows(), [{code: "child_of_custom", direction: "down", op: "move"}]),
      "errors.menu.moveBlocked",
      400,
    );
  });
});

describe("planMenuOps create-group", () => {
  const valid: MenuAdminOp = {
    code: "ops_notes",
    icon: "history",
    nameEn: "Notes",
    nameZh: "笔记",
    op: "create-group",
    parentCode: "group_content",
  };

  it("inserts a pure group row with the custom id prefix below its siblings", () => {
    const plan = planMenuOps(baseRows(), [valid], 1730000000000);
    expect(plan.error).toBeUndefined();
    const insert = plan.statements?.[0];
    expect(insert?.sql).toContain("INSERT INTO ext_menu");
    expect(insert?.sql).toContain("VALUES (?, ?, ?, '', ?, ?, NULL, ?, 1, ?, ?, ?)");
    // group_content 内最大 sort = 203（custom_dir）→ 新行 204。
    expect(insert?.params).toEqual([
      "mm_ops_notes",
      "ops_notes",
      "group_content",
      "menu.item.ops_notes",
      "history",
      204,
      1730000000000,
      "笔记",
      "Notes",
    ]);
  });

  it("validates code shape, uniqueness, icon and names", () => {
    expectError(
      planMenuOps(baseRows(), [{...valid, code: "Ops_Notes"}], 1),
      "errors.menu.invalidCode",
      400,
    );
    expectError(planMenuOps(baseRows(), [{...valid, code: "books"}], 1), "errors.menu.duplicateCode", 409);
    expectError(planMenuOps(baseRows(), [{...valid, icon: "nope"}], 1), "errors.menu.invalidIcon", 400);
    expectError(
      planMenuOps(baseRows(), [{...valid, nameEn: "  ", nameZh: ""}], 1),
      "errors.menu.nameRequired",
      400,
    );
    expectError(
      planMenuOps(baseRows(), [{...valid, parentCode: "ghost"}], 1),
      "errors.menu.notFound",
      404,
    );
  });

  it("sees rows created earlier in the same batch (no duplicate in one save)", () => {
    const plan = planMenuOps(baseRows(), [valid, {...valid}], 1);
    expectError(plan, "errors.menu.duplicateCode", 409);
  });
});

describe("planMenuOps delete", () => {
  it("only deletes rows created by the admin page", () => {
    expectError(
      planMenuOps(baseRows(), [{code: "books", op: "delete"}]),
      "errors.menu.seedProtected",
      409,
    );
    const plan = planMenuOps(baseRows(), [{code: "child_of_custom", op: "delete"}]);
    expect(plan.statements).toEqual([{params: ["mm_child_of_custom"], sql: "DELETE FROM ext_menu WHERE id = ?"}]);
  });

  it("refuses while children still point at the row", () => {
    expectError(
      planMenuOps(baseRows(), [{code: "custom_dir", op: "delete"}]),
      "errors.menu.hasChildren",
      409,
    );
    // 先删掉子行，同一批里父行就可删了（快照模拟生效）。
    const plan = planMenuOps(baseRows(), [
      {code: "child_of_custom", op: "delete"},
      {code: "custom_dir", op: "delete"},
    ]);
    expect(plan.error).toBeUndefined();
    expect(plan.statements).toHaveLength(2);
  });
});

describe("planMenuOps batching", () => {
  it("rejects the whole batch when any op fails validation", () => {
    const plan = planMenuOps(baseRows(), [
      {code: "books", op: "update", patch: {nameZh: "书名"}},
      {code: "books", op: "delete"},
    ]);
    expectError(plan, "errors.menu.seedProtected", 409);
    expect(plan.statements).toBeUndefined();
  });

  it("requires a non-empty list and bounds its size", () => {
    expectError(planMenuOps(baseRows(), []), "errors.menu.invalidInput", 400);
    const many = Array.from({length: 101}, () => ({code: "books", op: "update", patch: {nameZh: "x"}}) as MenuAdminOp);
    expectError(planMenuOps(baseRows(), many), "errors.menu.tooManyOps", 400);
  });

  it("refuses unknown op shapes", () => {
    const plan = planMenuOps(baseRows(), [{op: "rename", code: "books"} as unknown as MenuAdminOp]);
    expectError(plan, "errors.menu.invalidInput", 400);
  });
});

describe("buildMenuExportSql", () => {
  const rows = baseRows();
  rows[1] = row({...rows[1], nameZh: "书'O'Brien"});
  const sql = buildMenuExportSql(rows, Date.UTC(2026, 9, 18, 12, 0, 0));
  const lines = sql.split("\n");

  it("opens with the migration header, NNNN placeholder and rollback block", () => {
    expect(lines[0]).toBe("-- NNNN_data_menu_snapshot.sql");
    expect(sql).toContain("-- rollback:");
    expect(sql).toContain("2026-10-18T12:00:00.000Z");
  });

  it("updates seeded rows and inserts only custom rows", () => {
    const updates = lines.filter((line) => line.startsWith("UPDATE ext_menu SET"));
    const inserts = lines.filter((line) => line.startsWith("VALUES ("));
    // baseRows：3 条种子行（m_*）+ 2 条自建行（mm_*）。
    expect(updates).toHaveLength(3);
    expect(inserts).toHaveLength(2);
    const insertedCodes = inserts.map(
      (line) => /VALUES \('(?:[^']*)', '(?<code>[^']+)'/u.exec(line)?.groups?.code,
    );
    // 自建行按 (sort, code) 排序：child_of_custom(1) 在前、custom_dir(203) 在后。
    expect(insertedCodes).toEqual(["child_of_custom", "custom_dir"]);
  });

  it("never writes path or permission_code for seeded rows", () => {
    // 种子行的 UPDATE 只碰可变字段；两列可达性前提不出现在导出里。
    expect(sql).toContain("WHERE id = 'm_group_content';");
    expect(sql).not.toMatch(/path\s*=/u);
    expect(sql).not.toMatch(/permission_code\s*=/u);
  });

  it("escapes single quotes and renders NULLs as keywords", () => {
    expect(sql).toContain("'书''O''Brien'");
    // group_content：父级与图标为 NULL 时写成关键字。
    expect(sql).toContain("parent_code = NULL,");
    expect(sql).toContain("icon = NULL,");
  });

  it("preserves created_at_ms for custom rows instead of inventing 0", () => {
    expect(sql).toContain("1700000000000");
  });
});

describe("menu icon registry", () => {
  it("keeps MENU_ICONS (renderer) exactly in sync with MENU_ICON_NAMES (validator)", () => {
    expect(Object.keys(MENU_ICONS).sort()).toEqual([...MENU_ICON_NAMES].sort());
  });

  // The picker renders `menu.icon.${name}` for every registered name, so a
  // name without a label shows the raw key in the dropdown. scripts/check-i18n.ts
  // guards the same set at the gate level; this keeps the failure next to the
  // registry it belongs to.
  it("labels every icon name in both languages", () => {
    for (const name of MENU_ICON_NAMES) {
      const key = `menu.icon.${name}`;
      expect(translate(key, "en"), key).not.toBe(key);
      expect(translate(key, "zh-CN"), key).not.toBe(key);
    }
  });
});
