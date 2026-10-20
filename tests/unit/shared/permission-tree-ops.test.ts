import {describe, expect, it} from "vitest";

import {
  audienceOf,
  buildGrantGroupsFromNodes,
  buildPermissionExportSql,
  comparePermissionNodes,
  nodeDescendantCodes,
  permissionAccordionCollapsed,
  permissionAccordionOpen,
  permissionAccordionReveal,
  permissionAccordionToggle,
  permissionNodeChildren,
  permissionNodeDropAllowed,
  permissionParentCandidates,
  permissionSiblingPosition,
  permissionTopAncestorCode,
  PERMISSION_ROW_CUSTOM_ID_PREFIX,
  PERMISSION_TREE_MAX_OPS,
  planPermissionOps,
  reorderPermissionNodes,
  type PermissionAccordionState,
  type PermissionNodeRow,
} from "@/shared/PermissionTreeOps";
import {rbacTreeLabel} from "@/shared/Rbac";

/** 一棵小树：两分组，各两页，码分散；另有一个子分组与被折叠的孙页。 */
function fixtureRows(): PermissionNodeRow[] {
  const rows: PermissionNodeRow[] = [
    {
      code: "group_content",
      audience: "desktop",
      createdAtMs: 1,
      icon: "book",
      id: "pn_group_content",
      i18nKey: null,
      kind: "group",
      nameEn: "Content",
      nameZh: "内容",
      parentCode: null,
      permissionCode: null,
      sort: 100,
      source: "seed",
      visible: true,
    },
    {
      code: "group_account",
      audience: "desktop",
      createdAtMs: 1,
      icon: "users",
      id: "pn_group_account",
      i18nKey: null,
      kind: "group",
      nameEn: "Account",
      nameZh: "账户",
      parentCode: null,
      permissionCode: null,
      sort: 500,
      source: "seed",
      visible: true,
    },
  ];
  const pages: {code: string; parentCode: string; sort: number}[] = [
    {code: "books", parentCode: "group_content", sort: 101},
    {code: "volumes", parentCode: "group_content", sort: 102},
    {code: "rbac", parentCode: "group_account", sort: 501},
    {code: "users", parentCode: "group_account", sort: 502},
    {code: "nested_page", parentCode: "group_sub", sort: 111},
  ];
  for (const page of pages) {
    rows.push({
      code: `page_${page.code}`,
      audience: "desktop",
      createdAtMs: 1,
      icon: "book",
      id: `pn_page_${page.code}`,
      i18nKey: null,
      kind: "page",
      nameEn: page.code,
      nameZh: page.code,
      parentCode: page.parentCode,
      permissionCode: null,
      sort: page.sort,
      source: "seed",
      visible: true,
    });
  }
  // 子分组挂在 group_content 下，孙页挂子分组下（授权视图应折叠）。
  rows.push({
    code: "group_sub",
    audience: "desktop",
    createdAtMs: 1,
    icon: null,
    id: "pn_group_sub",
    i18nKey: null,
    kind: "group",
    nameEn: "Sub",
    nameZh: "子组",
    parentCode: "group_content",
    permissionCode: null,
    sort: 110,
    source: "seed",
    visible: true,
  });
  const codes: {code: string; parentCode: string; sort: number}[] = [
    {code: "content:book:create", parentCode: "page_books", sort: 0},
    {code: "content:book:read", parentCode: "page_books", sort: 1},
    {code: "content:volume:read", parentCode: "page_volumes", sort: 0},
    {code: "system:role:manage", parentCode: "page_rbac", sort: 0},
    {code: "system:user:manage", parentCode: "page_users", sort: 0},
    {code: "app:search:book", parentCode: "page_nested_page", sort: 0},
  ];
  for (const code of codes) {
    rows.push({
      code: code.code,
      audience: "desktop",
      createdAtMs: 1,
      icon: null,
      id: `pn_${code.code.replace(/:/gu, "_")}`,
      i18nKey: null,
      kind: "code",
      nameEn: null,
      nameZh: null,
      parentCode: code.parentCode,
      permissionCode: code.code,
      sort: code.sort,
      source: "seed",
      visible: true,
    });
  }
  return rows;
}

const NAMES = new Map<string, string>([
  ["content:book:read", "查看书"],
  ["content:book:create", "新建书"],
  ["content:volume:read", "查看卷"],
  ["system:role:manage", "角色管理"],
  ["system:user:manage", "用户管理"],
  ["app:search:book", "搜索-书内"],
  // 通配码在目录里但不应成为可勾选项。
  ["*", "超级管理员（全部）"],
]);

describe("comparePermissionNodes", () => {
  it("先 sort 后 code", () => {
    const rows = fixtureRows();
    const sorted = [...rows].sort(comparePermissionNodes);
    const codes = sorted.map((row) => row.code);
    // 父行排在子行之前（sort 更小），孙页（110）跟在子分组（110 同级按 code）后面。
    expect(codes.indexOf("group_content")).toBeLessThan(codes.indexOf("page_books"));
    expect(codes.indexOf("group_sub")).toBeLessThan(codes.indexOf("page_nested_page"));
    expect(codes.indexOf("group_content")).toBeLessThan(codes.indexOf("group_account"));
  });
});

describe("nodeDescendantCodes", () => {
  it("沿 parent_code 逐层下行，含跨层后代", () => {
    const rows = fixtureRows();
    const descendants = nodeDescendantCodes(rows, "group_content");
    expect([...descendants].sort()).toEqual(
      [
        "group_sub",
        "page_books",
        "page_nested_page",
        "page_volumes",
        "app:search:book",
        "content:book:create",
        "content:book:read",
        "content:volume:read",
      ].sort(),
    );
    // 叶子没有后代。
    expect(nodeDescendantCodes(rows, "content:book:read").size).toBe(0);
  });
});

describe("planPermissionOps · update", () => {
  it("改名写 name 语句并更新快照", () => {
    const result = planPermissionOps(fixtureRows(), [
      {code: "group_content", op: "update", patch: {nameZh: "新内容"}},
    ]);
    expect(result.error).toBeUndefined();
    expect(result.statements).toEqual([
      {
        params: ["新内容", "pn_group_content"],
        sql: "UPDATE ext_permission_nodes SET name_zh = ? WHERE id = ?",
      },
    ]);
  });

  it("code 节点拒绝改名/图标，允许换父与显隐", () => {
    const rows = fixtureRows();
    expect(
      planPermissionOps(rows, [
        {code: "content:book:read", op: "update", patch: {nameZh: "x"}},
      ]).error?.key,
    ).toBe("errors.permission.invalidInput");
    expect(
      planPermissionOps(rows, [
        {code: "content:book:read", op: "update", patch: {icon: "book"}},
      ]).error?.key,
    ).toBe("errors.permission.invalidInput");
    const result = planPermissionOps(rows, [
      {
        code: "content:book:read",
        op: "update",
        patch: {isVisible: false, parentCode: "page_volumes"},
      },
    ]);
    expect(result.error).toBeUndefined();
    expect(result.statements?.map((statement) => statement.sql)).toEqual([
      "UPDATE ext_permission_nodes SET is_visible = ? WHERE id = ?",
      "UPDATE ext_permission_nodes SET parent_code = ? WHERE id = ?",
    ]);
  });

  it("换父指向 code 节点拒绝", () => {
    const rows = fixtureRows();
    const result = planPermissionOps(rows, [
      {code: "group_content", op: "update", patch: {parentCode: "content:book:read"}},
    ]);
    expect(result.error).toEqual({
      key: "errors.permission.codeNodeParent",
      params: {code: "content:book:read"},
      status: 400,
    });
  });

  it("code 节点只能挂到 page 行", () => {
    const rows = fixtureRows();
    const result = planPermissionOps(rows, [
      {code: "content:book:read", op: "update", patch: {parentCode: "group_content"}},
    ]);
    expect(result.error?.key).toBe("errors.permission.codeNodeParent");
  });

  it("页面行与权限码行不能停在根层", () => {
    expect(
      planPermissionOps(fixtureRows(), [
        {code: "page_books", op: "update", patch: {parentCode: null}},
      ]).error?.key,
    ).toBe("errors.permission.parentLevel");
    expect(
      planPermissionOps(fixtureRows(), [
        {code: "content:book:read", op: "update", patch: {parentCode: null}},
      ]).error?.key,
    ).toBe("errors.permission.codeNodeParent");
  });

  it("页面行只能挂到分组行", () => {
    expect(
      planPermissionOps(fixtureRows(), [
        {code: "page_books", op: "update", patch: {parentCode: "page_volumes"}},
      ]).error?.key,
    ).toBe("errors.permission.parentLevel");
  });

  it("页面行可以清空图标", () => {
    const result = planPermissionOps(fixtureRows(), [
      {code: "page_books", op: "update", patch: {icon: null}},
    ]);
    expect(result.error).toBeUndefined();
    expect(result.statements?.[0]?.params).toEqual([null, "pn_page_books"]);
  });

  it("自环与成环拒绝", () => {
    const rows = fixtureRows();
    expect(
      planPermissionOps(rows, [
        {code: "group_content", op: "update", patch: {parentCode: "group_content"}},
      ]).error?.key,
    ).toBe("errors.permission.cycle");
    expect(
      planPermissionOps(rows, [
        {code: "group_sub", op: "update", patch: {parentCode: "page_nested_page"}},
      ]).error?.key,
    ).toBe("errors.permission.cycle");
  });

  it("空补丁拒绝", () => {
    const result = planPermissionOps(fixtureRows(), [
      {code: "group_content", op: "update", patch: {}},
    ]);
    expect(result.error?.key).toBe("errors.permission.invalidInput");
  });

  it("名称超长拒绝", () => {
    const result = planPermissionOps(fixtureRows(), [
      {code: "group_content", op: "update", patch: {nameZh: "x".repeat(65)}},
    ]);
    expect(result.error?.key).toBe("errors.permission.nameTooLong");
  });

  it("不在集合里的 code 报 notFound", () => {
    const result = planPermissionOps(fixtureRows(), [
      {code: "group_missing", op: "update", patch: {nameZh: "x"}},
    ]);
    expect(result.error).toEqual({
      key: "errors.permission.notFound",
      params: {code: "group_missing"},
      status: 404,
    });
  });
});

describe("planPermissionOps · move", () => {
  it("与相邻兄弟交换 sort", () => {
    const result = planPermissionOps(fixtureRows(), [
      {code: "page_volumes", direction: "up", op: "move"},
    ]);
    expect(result.error).toBeUndefined();
    expect(result.statements).toEqual([
      {params: [101, "pn_page_volumes"], sql: "UPDATE ext_permission_nodes SET sort = ? WHERE id = ?"},
      {params: [102, "pn_page_books"], sql: "UPDATE ext_permission_nodes SET sort = ? WHERE id = ?"},
    ]);
  });

  it("边界行 moveBlocked", () => {
    const result = planPermissionOps(fixtureRows(), [
      {code: "page_books", direction: "up", op: "move"},
    ]);
    expect(result.error).toEqual({
      key: "errors.permission.moveBlocked",
      params: {code: "page_books"},
      status: 400,
    });
  });

  it("code 节点允许 move（换位即移动权限对象）", () => {
    const result = planPermissionOps(fixtureRows(), [
      {code: "content:book:read", direction: "up", op: "move"},
    ]);
    expect(result.error).toBeUndefined();
    expect(result.statements).toEqual([
      {params: [0, "pn_content_book_read"], sql: "UPDATE ext_permission_nodes SET sort = ? WHERE id = ?"},
      {params: [1, "pn_content_book_create"], sql: "UPDATE ext_permission_nodes SET sort = ? WHERE id = ?"},
    ]);
  });

  it("code 节点首行上移 moveBlocked", () => {
    const result = planPermissionOps(fixtureRows(), [
      {code: "content:book:create", direction: "up", op: "move"},
    ]);
    expect(result.error).toEqual({
      key: "errors.permission.moveBlocked",
      params: {code: "content:book:create"},
      status: 400,
    });
  });
});

describe("planPermissionOps · create-group", () => {
  it("新建分组登记为 custom 行，sort 排在同层末尾", () => {
    const result = planPermissionOps(fixtureRows(), [
      {
        code: "group_new",
        icon: "book",
        nameZh: "新组",
        nameEn: "New",
        op: "create-group",
        parentCode: null,
      },
    ], 1700);
    expect(result.error).toBeUndefined();
    expect(result.statements?.[0]?.params?.[0]).toBe(`${PERMISSION_ROW_CUSTOM_ID_PREFIX}group_new`);
    expect(result.statements?.[0]?.params?.[3]).toBe(501); // 根层最大 sort 500 → 501
    expect(result.statements?.[0]?.sql).toContain("INSERT INTO ext_permission_nodes");
  });

  it("两个名字全空拒绝", () => {
    const result = planPermissionOps(fixtureRows(), [
      {code: "group_new", icon: "book", nameEn: "", nameZh: "", op: "create-group", parentCode: null},
    ]);
    expect(result.error?.key).toBe("errors.permission.nameRequired");
  });

  it("code 形状非法拒绝", () => {
    const result = planPermissionOps(fixtureRows(), [
      {code: "Bad-Code", icon: "book", nameZh: "x", nameEn: "y", op: "create-group", parentCode: null},
    ]);
    expect(result.error?.key).toBe("errors.permission.invalidCode");
  });

  it("重复 code 409", () => {
    const result = planPermissionOps(fixtureRows(), [
      {code: "group_content", icon: "book", nameZh: "x", nameEn: "y", op: "create-group", parentCode: null},
    ]);
    expect(result.error).toEqual({
      key: "errors.permission.duplicateCode",
      params: {code: "group_content"},
      status: 409,
    });
  });

  it("图标不在白名单拒绝", () => {
    const result = planPermissionOps(fixtureRows(), [
      {code: "group_new", icon: "nope", nameZh: "x", nameEn: "y", op: "create-group", parentCode: null},
    ]);
    expect(result.error?.key).toBe("errors.permission.invalidIcon");
  });

  it("父级指向 code 节点拒绝", () => {
    const result = planPermissionOps(fixtureRows(), [
      {code: "group_new", icon: "book", nameZh: "x", nameEn: "y", op: "create-group", parentCode: "content:book:read"},
    ]);
    expect(result.error?.key).toBe("errors.permission.codeNodeParent");
  });

  it("分组不能挂到页面下", () => {
    const result = planPermissionOps(fixtureRows(), [
      {code: "group_new", icon: "book", nameZh: "x", nameEn: "y", op: "create-group", parentCode: "page_books"},
    ]);
    expect(result.error?.key).toBe("errors.permission.parentLevel");
  });
});

describe("planPermissionOps · delete", () => {
  it("种子行拒绝删除", () => {
    const result = planPermissionOps(fixtureRows(), [
      {code: "group_content", op: "delete"},
    ]);
    expect(result.error).toEqual({
      key: "errors.permission.seedProtected",
      params: {code: "group_content"},
      status: 409,
    });
  });

  it("code 节点拒绝删除", () => {
    const result = planPermissionOps(fixtureRows(), [
      {code: "content:book:read", op: "delete"},
    ]);
    expect(result.error?.key).toBe("errors.permission.codeNodeUndeletable");
  });

  it("有子节点拒绝删除", () => {
    const rows = fixtureRows();
    rows.push({
      code: "group_leaf",
      audience: "desktop",
      createdAtMs: 1,
      icon: "book",
      id: "pm_group_leaf",
      i18nKey: null,
      kind: "group",
      nameEn: "Leaf",
      nameZh: "空叶组",
      parentCode: null,
      permissionCode: null,
      sort: 900,
      source: "custom",
      visible: true,
    });
    rows.push({
      code: "page_under_leaf",
      audience: "desktop",
      createdAtMs: 1,
      icon: "book",
      id: "pm_page_under_leaf",
      i18nKey: null,
      kind: "page",
      nameEn: "x",
      nameZh: "x",
      parentCode: "group_leaf",
      permissionCode: null,
      sort: 901,
      source: "custom",
      visible: true,
    });
    const result = planPermissionOps(rows, [{code: "group_leaf", op: "delete"}]);
    expect(result.error?.key).toBe("errors.permission.hasChildren");
  });

  it("自建空组可删", () => {
    const rows = fixtureRows();
    rows.push({
      code: "group_leaf",
      audience: "desktop",
      createdAtMs: 1,
      icon: "book",
      id: "pm_group_leaf",
      i18nKey: null,
      kind: "group",
      nameEn: "Leaf",
      nameZh: "空叶组",
      parentCode: null,
      permissionCode: null,
      sort: 900,
      source: "custom",
      visible: true,
    });
    const result = planPermissionOps(rows, [{code: "group_leaf", op: "delete"}]);
    expect(result.error).toBeUndefined();
    expect(result.statements).toEqual([
      {params: ["pm_group_leaf"], sql: "DELETE FROM ext_permission_nodes WHERE id = ?"},
    ]);
  });
});

describe("planPermissionOps · reorder", () => {
  it("同层按 ids 重排并跨页改父（拖拽核心路径）", () => {
    const result = planPermissionOps(fixtureRows(), [
      {
        code: "content:volume:read",
        ids: ["content:volume:read", "content:book:create", "content:book:read"],
        op: "reorder",
        parentCode: "page_books",
      },
    ]);
    expect(result.error).toBeUndefined();
    // ids 全列重排：三个兄弟按新位置各写一条 sort，再补一条 parent 改父。
    expect(result.statements).toEqual([
      {params: [1, "pn_content_volume_read"], sql: "UPDATE ext_permission_nodes SET sort = ? WHERE id = ?"},
      {params: [2, "pn_content_book_create"], sql: "UPDATE ext_permission_nodes SET sort = ? WHERE id = ?"},
      {params: [3, "pn_content_book_read"], sql: "UPDATE ext_permission_nodes SET sort = ? WHERE id = ?"},
      {params: ["page_books", "pn_content_volume_read"], sql: "UPDATE ext_permission_nodes SET parent_code = ? WHERE id = ?"},
    ]);
  });

  it("ids 不含被拖项拒绝", () => {
    const result = planPermissionOps(fixtureRows(), [
      {code: "content:book:read", ids: ["content:book:create"], op: "reorder"},
    ]);
    expect(result.error?.key).toBe("errors.permission.invalidInput");
  });

  it("省略 parentCode 留在原父级", () => {
    const result = planPermissionOps(fixtureRows(), [
      {code: "page_books", ids: ["page_books"], op: "reorder"},
    ]);
    expect(result.error).toBeUndefined();
    // 只写同层 sort，不写 parent_code。
    expect((result.statements ?? []).some((statement) => statement.sql.includes("parent_code")))
      .toBe(false);
  });

  it("显式把页面行挂到根层拒绝", () => {
    const result = planPermissionOps(fixtureRows(), [
      {code: "page_books", ids: ["page_books"], op: "reorder", parentCode: null},
    ]);
    expect(result.error?.key).toBe("errors.permission.parentLevel");
  });

  it("ids 混进别层行拒绝", () => {
    const result = planPermissionOps(fixtureRows(), [
      {
        code: "content:book:read",
        ids: ["content:book:create", "content:volume:read"],
        op: "reorder",
        parentCode: "page_books",
      },
    ]);
    expect(result.error?.key).toBe("errors.permission.invalidInput");
  });
});

describe("planPermissionOps · 批量", () => {
  it("op 数超限拒绝", () => {
    const ops = Array.from({length: PERMISSION_TREE_MAX_OPS + 1}, () => ({
      code: "page_books",
      direction: "up" as const,
      op: "move" as const,
    }));
    expect(planPermissionOps(fixtureRows(), ops).error?.key).toBe(
      "errors.permission.tooManyOps",
    );
  });

  it("空 op 集合拒绝", () => {
    expect(planPermissionOps(fixtureRows(), []).error?.key).toBe(
      "errors.permission.invalidInput",
    );
  });

  it("一条失败整批拒绝（0 条语句）", () => {
    const result = planPermissionOps(fixtureRows(), [
      {code: "group_content", op: "update", patch: {nameZh: "ok"}},
      {code: "group_content", op: "delete"},
    ]);
    expect(result.error?.key).toBe("errors.permission.seedProtected");
    expect(result.statements).toBeUndefined();
  });

  it("后续 op 看得到前面 op 的结果", () => {
    const result = planPermissionOps(fixtureRows(), [
      {
        code: "group_new",
        icon: "book",
        nameZh: "新组",
        nameEn: "New",
        op: "create-group",
        parentCode: null,
      },
      {code: "group_new", op: "update", patch: {nameZh: "改名后"}},
    ]);
    expect(result.error).toBeUndefined();
    expect(result.statements?.length).toBe(2);
  });

  it("未知 op 类型拒绝", () => {
    const result = planPermissionOps(fixtureRows(), [
      {code: "page_books", op: "teleport"} as never,
    ]);
    expect(result.error?.key).toBe("errors.permission.invalidInput");
  });
});

describe("buildGrantGroupsFromNodes", () => {
  it("产出两层授权视图：组 code 原样、页 code 剥前缀、码按读序，并带节点双语名", () => {
    const groups = buildGrantGroupsFromNodes(fixtureRows(), NAMES, "desktop");
    expect(groups).toEqual([
      {
        code: "group_content",
        i18nKey: null,
        nameEn: "Content",
        nameZh: "内容",
        pages: [
          {code: "books", codes: ["content:book:create", "content:book:read"], i18nKey: null, nameEn: "books", nameZh: "books"},
          {code: "volumes", codes: ["content:volume:read"], i18nKey: null, nameEn: "volumes", nameZh: "volumes"},
          {code: "nested_page", codes: ["app:search:book"], i18nKey: null, nameEn: "nested_page", nameZh: "nested_page"},
        ],
      },
      {
        code: "group_account",
        i18nKey: null,
        nameEn: "Account",
        nameZh: "账户",
        pages: [
          {code: "rbac", codes: ["system:role:manage"], i18nKey: null, nameEn: "rbac", nameZh: "rbac"},
          {code: "users", codes: ["system:user:manage"], i18nKey: null, nameEn: "users", nameZh: "users"},
        ],
      },
    ]);
  });

  it("通配码不进视图", () => {
    const rows = fixtureRows();
    const groups = buildGrantGroupsFromNodes(
      [...rows, ...[
        {
          code: "*",
          audience: "desktop" as const,
          createdAtMs: 1,
          icon: null,
          id: "pn__",
          i18nKey: null,
          kind: "code" as const,
          nameEn: null,
          nameZh: null,
          parentCode: "page_books",
          permissionCode: "*",
          sort: 9,
          source: "seed" as const,
          visible: true,
        },
      ]],
      NAMES, "desktop",
    );
    const codes = groups.flatMap((group) => group.pages).flatMap((page) => page.codes);
    expect(codes).not.toContain("*");
  });

  it("空页与空组跳过", () => {
    const rows = fixtureRows();
    rows.push({
      code: "page_empty",
      audience: "desktop",
      createdAtMs: 1,
      icon: "book",
      id: "pn_page_empty",
      i18nKey: null,
      kind: "page",
      nameEn: "empty",
      nameZh: "空页",
      parentCode: "group_account",
      permissionCode: null,
      sort: 600,
      source: "seed",
      visible: true,
    });
    rows.push({
      code: "group_empty",
      audience: "desktop",
      createdAtMs: 1,
      icon: null,
      id: "pn_group_empty",
      i18nKey: null,
      kind: "group",
      nameEn: "empty group",
      nameZh: "空组",
      parentCode: null,
      permissionCode: null,
      sort: 900,
      source: "seed",
      visible: true,
    });
    const groups = buildGrantGroupsFromNodes(rows, NAMES, "desktop");
    expect(groups.map((group) => group.code)).toEqual(["group_content", "group_account"]);
    for (const group of groups) {
      for (const page of group.pages) {
        expect(page.codes.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("buildPermissionExportSql", () => {
  it("种子行只 UPDATE 可变字段，绝不含 permission_code", () => {
    const sql = buildPermissionExportSql(fixtureRows(), Date.UTC(2026, 9, 20));
    expect(sql).toContain("UPDATE ext_permission_nodes SET");
    expect(sql).not.toContain("permission_code = '");
    // 自建行（INSERT 分支）整行补齐。
    const custom: PermissionNodeRow = {
      code: "group_mine",
      audience: "desktop",
      createdAtMs: 5,
      icon: "book",
      id: "pm_group_mine",
      i18nKey: "rbac.node.group_mine",
      kind: "group",
      nameEn: "Mine",
      nameZh: "我的",
      parentCode: null,
      permissionCode: null,
      sort: 999,
      source: "custom",
      visible: true,
    };
    const withCustom = buildPermissionExportSql([...fixtureRows(), custom], 0);
    expect(withCustom).toContain("INSERT OR REPLACE INTO ext_permission_nodes");
    expect(withCustom).toContain("'pm_group_mine'");
    expect(withCustom).toContain("'我的'");
    // 自建行的终端归属必须进导出：漏了会在新实例上按列默认值掉进 PC 端。
    expect(withCustom).toContain("parent_code, audience, sort, permission_code");
    expect(withCustom).toContain("'desktop'");
  });

  it("头注释带 rollback 与编号提醒（data 迁移门禁）", () => {
    const sql = buildPermissionExportSql(fixtureRows(), 0);
    expect(sql).toContain("NNNN_data_permission_nodes_snapshot.sql");
    expect(sql).toContain("-- rollback:");
  });
});

describe("树视图助手 · permissionNodeChildren", () => {
  it("根层与子层都按 (sort, code) 读序", () => {
    const rows = fixtureRows();
    expect(permissionNodeChildren(rows, null).map((row) => row.code)).toEqual([
      "group_content",
      "group_account",
    ]);
    expect(permissionNodeChildren(rows, "group_content").map((row) => row.code)).toEqual([
      "page_books",
      "page_volumes",
      "group_sub",
    ]);
  });

  it("叶子与未知父级返回空", () => {
    const rows = fixtureRows();
    expect(permissionNodeChildren(rows, "content:book:read")).toEqual([]);
    expect(permissionNodeChildren(rows, "group_missing")).toEqual([]);
  });

  it("泛型保持行对象引用（WithMeta 元数据不丢）", () => {
    const rows = fixtureRows();
    const books = rows.find((row) => row.code === "page_books");
    expect(books).toBeDefined();
    const children = permissionNodeChildren(rows, "group_content");
    expect(children[0]).toBe(books);
  });
});

describe("树视图助手 · permissionSiblingPosition", () => {
  it("首行禁上移、末行禁下移、中间行双向可动", () => {
    const rows = fixtureRows();
    expect(permissionSiblingPosition(rows, "page_books")).toEqual({canDown: true, canUp: false});
    expect(permissionSiblingPosition(rows, "page_volumes")).toEqual({canDown: true, canUp: true});
    expect(permissionSiblingPosition(rows, "group_sub")).toEqual({canDown: false, canUp: true});
  });

  it("叶子码同样按同层兄弟判定", () => {
    const rows = fixtureRows();
    expect(permissionSiblingPosition(rows, "content:book:create")).toEqual({
      canDown: true,
      canUp: false,
    });
    expect(permissionSiblingPosition(rows, "content:book:read")).toEqual({
      canDown: false,
      canUp: true,
    });
  });

  it("未知 code 双向禁用", () => {
    expect(permissionSiblingPosition(fixtureRows(), "nope")).toEqual({
      canDown: false,
      canUp: false,
    });
  });
});

describe("树视图助手 · permissionTopAncestorCode", () => {
  it("跨层上行到顶层分组", () => {
    const rows = fixtureRows();
    expect(permissionTopAncestorCode(rows, "group_content")).toBe("group_content");
    expect(permissionTopAncestorCode(rows, "page_books")).toBe("group_content");
    expect(permissionTopAncestorCode(rows, "group_sub")).toBe("group_content");
    expect(permissionTopAncestorCode(rows, "page_nested_page")).toBe("group_content");
    expect(permissionTopAncestorCode(rows, "app:search:book")).toBe("group_content");
    expect(permissionTopAncestorCode(rows, "system:role:manage")).toBe("group_account");
  });

  it("不在行集里返回 null", () => {
    expect(permissionTopAncestorCode(fixtureRows(), "nope")).toBeNull();
  });
});

describe("树视图助手 · permissionNodeDropAllowed", () => {
  const rows = fixtureRows();
  const row = (code: string): PermissionNodeRow => {
    const found = rows.find((entry) => entry.code === code);
    if (!found) throw new Error(`fixture 缺行: ${code}`);
    return found;
  };

  it("inside：group 可互挂，page 只能进 group，code 只能进 page", () => {
    expect(permissionNodeDropAllowed(rows, row("page_books"), row("group_account"), "inside")).toBe(true);
    expect(permissionNodeDropAllowed(rows, row("group_sub"), row("group_account"), "inside")).toBe(true);
    expect(permissionNodeDropAllowed(rows, row("content:book:create"), row("page_volumes"), "inside")).toBe(true);
  });

  it("inside：页面不能放进页面，分组也不能放进页面", () => {
    expect(permissionNodeDropAllowed(rows, row("page_volumes"), row("page_books"), "inside")).toBe(false);
    expect(permissionNodeDropAllowed(rows, row("group_sub"), row("page_books"), "inside")).toBe(false);
  });

  it("inside：code 行不得成为拖放目标，code 也不进 group", () => {
    expect(permissionNodeDropAllowed(rows, row("page_books"), row("content:book:create"), "inside")).toBe(false);
    expect(permissionNodeDropAllowed(rows, row("content:book:create"), row("group_account"), "inside")).toBe(false);
  });

  it("inside：拖进自己的后代成环，拖回当前父级合法", () => {
    expect(permissionNodeDropAllowed(rows, row("group_content"), row("group_sub"), "inside")).toBe(false);
    expect(permissionNodeDropAllowed(rows, row("group_content"), row("page_books"), "inside")).toBe(false);
    // 拖回当前父级：旧实现把成环两端写反，会误禁这种合法放置。
    expect(permissionNodeDropAllowed(rows, row("page_books"), row("group_content"), "inside")).toBe(true);
    expect(permissionNodeDropAllowed(rows, row("page_nested_page"), row("group_sub"), "inside")).toBe(true);
  });

  it("before/after：只允许同类行换序，可改父级", () => {
    expect(permissionNodeDropAllowed(rows, row("group_account"), row("group_content"), "before")).toBe(true);
    expect(permissionNodeDropAllowed(rows, row("page_books"), row("page_volumes"), "after")).toBe(true);
    expect(permissionNodeDropAllowed(rows, row("page_books"), row("page_nested_page"), "before")).toBe(true);
  });

  it("before/after：跨层级互换一律拒绝", () => {
    expect(permissionNodeDropAllowed(rows, row("group_content"), row("page_books"), "before")).toBe(false);
    expect(permissionNodeDropAllowed(rows, row("content:book:create"), row("page_books"), "before")).toBe(false);
    expect(permissionNodeDropAllowed(rows, row("page_books"), row("content:book:read"), "after")).toBe(false);
  });

  it("before/after：新父级是被拖项自身或后代时成环", () => {
    // group_sub 的父级是 group_content：把 group_content 拖到 group_sub 前，
    // 新父级会变成它自己。
    expect(permissionNodeDropAllowed(rows, row("group_content"), row("group_sub"), "before")).toBe(false);
    const base = row("group_content");
    const chain: PermissionNodeRow[] = [
      {...base, code: "g", id: "pn_g", parentCode: null, sort: 1},
      {...base, code: "g_mid", id: "pn_g_mid", kind: "group", parentCode: "g", sort: 2},
      {...base, code: "g_leaf", id: "pn_g_leaf", kind: "group", parentCode: "g_mid", sort: 3},
    ];
    const g = chain[0]!;
    const gMid = chain[1]!;
    const gLeaf = chain[2]!;
    // 把 g 拖到 g_mid 前：新父级 = g 自己。
    expect(permissionNodeDropAllowed(chain, g, gMid, "before")).toBe(false);
    // 把 g 拖到 g_leaf 前：新父级 = g_mid，是 g 的后代。
    expect(permissionNodeDropAllowed(chain, g, gLeaf, "before")).toBe(false);
    // g_leaf 拖到 g 前：新父级 = null，合法。
    expect(permissionNodeDropAllowed(chain, gLeaf, g, "before")).toBe(true);
  });

  it("拖到自己身上任何位置都拒绝", () => {
    expect(permissionNodeDropAllowed(rows, row("group_content"), row("group_content"), "inside")).toBe(false);
    expect(permissionNodeDropAllowed(rows, row("group_content"), row("group_content"), "before")).toBe(false);
  });
});

describe("树视图助手 · permissionParentCandidates", () => {
  function mk(overrides: Partial<PermissionNodeRow> & {code: string}): PermissionNodeRow {
    return {
      audience: "desktop",
      createdAtMs: 0, icon: null, id: overrides.code, i18nKey: null,
      kind: "code", nameEn: null, nameZh: null, parentCode: null,
      permissionCode: null, sort: 1, source: "seed", visible: true, ...overrides,
    };
  }
  it("excludes self, descendants and code rows; a code row only lists pages", () => {
    const rows: PermissionNodeRow[] = [
      mk({code: "g1", kind: "group", parentCode: null, sort: 1}),
      mk({code: "g2", kind: "group", parentCode: null, sort: 2}),
      mk({code: "g1_p", kind: "page", parentCode: "g1", sort: 1}),
      mk({code: "g1_c", kind: "code", parentCode: "g1_p", permissionCode: "x:read", sort: 1}),
      mk({code: "g1_gchild", kind: "group", parentCode: "g1", sort: 2}),
    ];
    // g1 reparenting: only other groups (g2); self and descendant g1_gchild excluded.
    expect(permissionParentCandidates(rows, "g1").map((row) => row.code).sort())
      .toEqual(["g2"]);
    // g1_c is a code row: only page candidates (g1_p), never a group.
    expect(permissionParentCandidates(rows, "g1_c").map((row) => row.code).sort())
      .toEqual(["g1_p"]);
    // g1_p is a page row: only groups (its current parent included, plus the
    // nested group), never another page.
    expect(permissionParentCandidates(rows, "g1_p").map((row) => row.code).sort())
      .toEqual(["g1", "g1_gchild", "g2"]);
  });
});

describe("树视图助手 · reorderPermissionNodes", () => {
  it("before/after 同层换序并把该层 sort 重排为 1..n", () => {
    const rows = fixtureRows();
    const next = reorderPermissionNodes(rows, "group_account", "group_content", "before");
    expect(next).not.toBe(rows);
    // 显示顺序看 sort 值，不看数组位置（reordered 由 map 产出，位置不动）。
    expect(permissionNodeChildren(next, null).map((row) => row.code)).toEqual([
      "group_account",
      "group_content",
    ]);
    expect(next.find((row) => row.code === "group_account")?.sort).toBe(1);
    expect(next.find((row) => row.code === "group_content")?.sort).toBe(2);
    // 其他层不受影响。
    expect(next.find((row) => row.code === "page_books")?.sort).toBe(101);
  });

  it("inside 挂到目标行下并排到该层末尾", () => {
    const rows = fixtureRows();
    const next = reorderPermissionNodes(rows, "page_books", "group_account", "inside");
    expect(next.find((row) => row.code === "page_books")?.parentCode).toBe("group_account");
    expect(permissionNodeChildren(next, "group_account").map((row) => row.code)).toEqual([
      "page_rbac",
      "page_users",
      "page_books",
    ]);
    expect(next.find((row) => row.code === "page_books")?.sort).toBe(3);
    // 旧父级下不再有它。
    expect(permissionNodeChildren(next, "group_content").map((row) => row.code)).toEqual([
      "page_volumes",
      "group_sub",
    ]);
  });

  it("非法拖放目标与未知目标原样返回（同一引用）", () => {
    const rows = fixtureRows();
    expect(reorderPermissionNodes(rows, "content:book:create", "group_account", "inside")).toBe(rows);
    expect(reorderPermissionNodes(rows, "group_content", "page_books", "before")).toBe(rows);
    expect(reorderPermissionNodes(rows, "group_content", "group_content", "before")).toBe(rows);
    expect(reorderPermissionNodes(rows, "group_content", "nope", "before")).toBe(rows);
    expect(reorderPermissionNodes(rows, "nope", "group_content", "before")).toBe(rows);
  });

  it("成环原样返回", () => {
    const rows = fixtureRows();
    // inside：group_content 拖进自己的后代 group_sub。
    expect(reorderPermissionNodes(rows, "group_content", "group_sub", "inside")).toBe(rows);
    // before：新父级会变成被拖项自己。
    expect(reorderPermissionNodes(rows, "group_content", "group_sub", "before")).toBe(rows);
  });

  it("拖到相邻但顺序不变时原样返回（快路径）", () => {
    const rows = fixtureRows();
    // page_books 拖到 page_volumes 后：顺序本就是这样。
    expect(reorderPermissionNodes(rows, "page_books", "page_volumes", "after")).toBe(rows);
    // page_volumes 拖到 page_books 前：真换序。
    const next = reorderPermissionNodes(rows, "page_volumes", "page_books", "before");
    expect(next).not.toBe(rows);
    expect(permissionNodeChildren(next, "group_content").map((row) => row.code)).toEqual([
      "page_volumes",
      "page_books",
      "group_sub",
    ]);
  });
});

describe("rbacTreeLabel", () => {
  const t = (key: string, options?: {defaultValue: string}): string =>
    key === "rbac.node.group_mine" ? "我的分组" : (options?.defaultValue ?? key);

  it("当前语言的双语名优先，空列取另一列", () => {
    expect(rbacTreeLabel({code: "x", nameEn: "Content", nameZh: "内容"}, "zh-CN", t)).toBe("内容");
    expect(rbacTreeLabel({code: "x", nameEn: "Content", nameZh: "内容"}, "en", t)).toBe("Content");
    expect(rbacTreeLabel({code: "x", nameEn: "Content", nameZh: null}, "zh-CN", t)).toBe("Content");
    expect(rbacTreeLabel({code: "x", nameEn: "", nameZh: "内容"}, "en", t)).toBe("内容");
  });

  it("双名全空走 i18n 兜底键", () => {
    expect(
      rbacTreeLabel(
        {code: "group_mine", i18nKey: "rbac.node.group_mine", nameEn: null, nameZh: null},
        "zh-CN",
        t,
      ),
    ).toBe("我的分组");
  });

  it("兜底键译为空串时退回 code", () => {
    expect(
      rbacTreeLabel(
        {code: "group_plain", i18nKey: "rbac.node.blank", nameEn: null, nameZh: null},
        "zh-CN",
        () => "",
      ),
    ).toBe("group_plain");
    expect(rbacTreeLabel({code: "group_plain", nameEn: null, nameZh: null}, "zh-CN", t)).toBe(
      "group_plain",
    );
  });
});

/**
 * 终端归属（ADR-0039）：两个控制台按 `audience` 互斥分区。规则在纯函数层与
 * 端点两处镜像（端点只读本端行集），这里锁纯函数这一侧。
 */
describe("终端归属（ADR-0039）", () => {
  function node(
    code: string,
    overrides: Partial<PermissionNodeRow> = {},
  ): PermissionNodeRow {
    return {
      audience: "desktop",
      code,
      createdAtMs: 0,
      icon: null,
      id: code,
      i18nKey: null,
      kind: "code",
      nameEn: null,
      nameZh: null,
      parentCode: null,
      permissionCode: null,
      sort: 1,
      source: "seed",
      visible: true,
      ...overrides,
    };
  }

  /** 一端一棵小树：PC 的 books 页、App 的接入页。 */
  function crossRows(): PermissionNodeRow[] {
    return [
      node("group_content", {kind: "group", parentCode: null, sort: 1}),
      node("page_books", {kind: "page", parentCode: "group_content", sort: 101}),
      node("c_read", {
        kind: "code",
        parentCode: "page_books",
        permissionCode: "content:book:read",
        sort: 1,
      }),
      node("group_app", {audience: "app", kind: "group", parentCode: null, sort: 900}),
      node("page_app_access", {
        audience: "app",
        kind: "page",
        parentCode: "group_app",
        sort: 901,
      }),
      node("c_mobile", {
        audience: "app",
        kind: "code",
        parentCode: "page_app_access",
        permissionCode: "app:nav:read",
        sort: 1,
      }),
    ];
  }

  it("audienceOf 由 kind='code' 叶子推导，没有叶子时返回 null", () => {
    const rows = crossRows();
    expect(audienceOf("app:nav:read", rows)).toBe("app");
    expect(audienceOf("content:book:read", rows)).toBe("desktop");
    // 没有挂靠点的码不能被默认成桌面端：null 让调用方 fail-closed。
    expect(audienceOf("content:book:delete", rows)).toBeNull();
  });

  it("拖放不跨终端", () => {
    const rows = crossRows();
    const cApp = rows.find((row) => row.code === "c_mobile");
    const cRead = rows.find((row) => row.code === "c_read");
    const pageApp = rows.find((row) => row.code === "page_app_access");
    const pagePc = rows.find((row) => row.code === "page_books");
    const groupApp = rows.find((row) => row.code === "group_app");
    const groupPc = rows.find((row) => row.code === "group_content");
    if (!cApp || !cRead || !pageApp || !pagePc || !groupApp || !groupPc) {
      throw new Error("fixture rows missing");
    }
    expect(permissionNodeDropAllowed(rows, cApp, pageApp, "inside")).toBe(true);
    expect(permissionNodeDropAllowed(rows, cApp, pagePc, "inside")).toBe(false);
    expect(permissionNodeDropAllowed(rows, groupApp, groupPc, "inside")).toBe(false);
    // before/after 同样按端收窄：App 码不能插进桌面码之间。
    expect(permissionNodeDropAllowed(rows, cApp, cRead, "before")).toBe(false);
  });

  it("父级候选只列同端的行", () => {
    const rows = crossRows();
    expect(permissionParentCandidates(rows, "c_mobile").map((row) => row.code))
      .toEqual(["page_app_access"]);
    expect(permissionParentCandidates(rows, "page_app_access").map((row) => row.code))
      .toEqual(["group_app"]);
  });

  it("保存时跨终端重挂被拒", () => {
    const result = planPermissionOps(crossRows(), [
      {code: "c_mobile", op: "update", patch: {parentCode: "page_books"}},
    ], 0);
    expect(result.error?.key).toBe("errors.permission.audienceMismatch");
  });

  it("新建分组继承行集的终端归属", () => {
    const appRows = crossRows().filter((row) => row.audience === "app");
    const inherited = planPermissionOps(appRows, [
      {code: "group_new", icon: "book", nameEn: "", nameZh: "新组", op: "create-group", parentCode: null},
    ], 0);
    expect(inherited.error).toBeUndefined();
    const [statement] = inherited.statements ?? [];
    expect(statement?.sql).toContain("audience");
    // 绑定参数顺序：id, code, parent_code, sort, audience, …
    expect(statement?.params[4]).toBe("app");

    const explicit = planPermissionOps([], [
      {code: "group_new", icon: "book", nameEn: "", nameZh: "新组", op: "create-group", parentCode: null},
    ], 0, "app");
    expect((explicit.statements ?? [])[0]?.params[4]).toBe("app");
  });
});

describe("权限树手风琴", () => {
  /** 未展开的行一律折叠：空状态就是「整棵树收起来」。 */
  it("空状态把所有行判成折叠", () => {
    const collapsed = permissionAccordionCollapsed(fixtureRows(), {}, "desktop");
    expect(Object.values(collapsed).every((value) => value)).toBe(true);
    expect(Object.keys(collapsed)).toHaveLength(fixtureRows().length);
  });

  it("同一父下只留一个展开位，展开兄弟会把前一个折回", () => {
    const rows = fixtureRows();
    let state: PermissionAccordionState = {};
    state = permissionAccordionToggle(state, "desktop", null, "group_content");
    expect(permissionAccordionCollapsed(rows, state, "desktop").group_content).toBe(false);

    // 同层（根层）换成 group_account：group_content 自动折回。
    state = permissionAccordionToggle(state, "desktop", null, "group_account");
    let collapsed = permissionAccordionCollapsed(rows, state, "desktop");
    expect(collapsed.group_account).toBe(false);
    expect(collapsed.group_content).toBe(true);

    // 更深一层同样互斥：page_books 展开后 page_volumes、group_sub 都折叠。
    state = permissionAccordionToggle(state, "desktop", "group_content", "page_books");
    collapsed = permissionAccordionCollapsed(rows, state, "desktop");
    expect(collapsed.page_books).toBe(false);
    expect(collapsed.page_volumes).toBe(true);
    expect(collapsed.group_sub).toBe(true);
    state = permissionAccordionToggle(state, "desktop", "group_content", "page_volumes");
    collapsed = permissionAccordionCollapsed(rows, state, "desktop");
    expect(collapsed.page_volumes).toBe(false);
    expect(collapsed.page_books).toBe(true);
  });

  it("再点一次就折回该父的展开位", () => {
    let state = permissionAccordionToggle({}, "desktop", null, "group_content");
    state = permissionAccordionToggle(state, "desktop", null, "group_content");
    expect(permissionAccordionOpen(state, "desktop", null)).toBeNull();
  });

  it("定位到某行只展开它那条链", () => {
    const rows = fixtureRows();
    const state = permissionAccordionReveal(rows, {}, "desktop", "app:search:book");
    const collapsed = permissionAccordionCollapsed(rows, state, "desktop");
    // 祖先链：group_content → group_sub → page_nested_page → 码。
    expect(collapsed.group_content).toBe(false);
    expect(collapsed.group_sub).toBe(false);
    expect(collapsed.page_nested_page).toBe(false);
    // 同层兄弟一律折叠，只有一条展开链。
    expect(collapsed.group_account).toBe(true);
    expect(collapsed.page_books).toBe(true);
    expect(collapsed.page_volumes).toBe(true);
  });

  it("定位时码不在集合里就原样返回", () => {
    const state: PermissionAccordionState = {desktop: "group_content"};
    expect(permissionAccordionReveal(fixtureRows(), state, "desktop", "no_such_code")).toBe(state);
  });

  it("两端的展开位互不干扰", () => {
    const rows = fixtureRows();
    const state = permissionAccordionToggle({}, "desktop", null, "group_content");
    expect(permissionAccordionCollapsed(rows, state, "desktop").group_content).toBe(false);
    expect(
      Object.values(permissionAccordionCollapsed(rows, state, "app")).every((value) => value),
    ).toBe(true);
  });
});
