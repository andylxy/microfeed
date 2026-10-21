import {describe, expect, it} from "vitest";

import {
  buildPermissionExportSql,
  normalizeEntryPath,
  PERMISSION_NODE_COLUMNS,
  planPermissionOps,
  toPermissionNodeRow,
  type PermissionNodeRow,
} from "@/shared/PermissionTreeOps";

function node(
  overrides: Partial<PermissionNodeRow> & {code: string},
): PermissionNodeRow {
  return {
    audience: "desktop",
    createdAtMs: 1,
    entryCode: null,
    path: null,
    icon: null,
    id: `pn_${overrides.code}`,
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

/** 一页两个码：`system:role:manage` 可作门码，`page_rbac` 挂在账户分组下。 */
function rows(): PermissionNodeRow[] {
  return [
    node({code: "group_account", kind: "group", sort: 500, source: "seed"}),
    node({
      code: "page_rbac",
      kind: "page",
      parentCode: "group_account",
      sort: 501,
      source: "seed",
    }),
    node({
      code: "system:role:manage",
      parentCode: "page_rbac",
      permissionCode: "system:role:manage",
    }),
    node({
      code: "system:menu:manage",
      parentCode: "page_rbac",
      permissionCode: "system:menu:manage",
    }),
  ];
}

describe("页面节点的 path 与 entry_code（ADR-0041 D1/D2、ADR-0042 D3）", () => {
  it("同时设置 path 与 entry_code，各出一条 UPDATE", () => {
    const result = planPermissionOps(rows(), [
      {
        code: "page_rbac",
        op: "update",
        patch: {path: "rbac", entryCode: "system:role:manage"},
      },
    ]);
    expect(result.error).toBeUndefined();
    expect(result.statements).toEqual([
      {
        params: ["rbac", "pn_page_rbac"],
        sql: "UPDATE ext_permission_nodes SET path = ? WHERE id = ?",
      },
      {
        params: ["system:role:manage", "pn_page_rbac"],
        sql: "UPDATE ext_permission_nodes SET entry_code = ? WHERE id = ?",
      },
    ]);
  });

  it("只设 path 允许：只挂码不进侧栏的页面也能带地址", () => {
    const result = planPermissionOps(rows(), [
      {code: "page_rbac", op: "update", patch: {path: "rbac"}},
    ]);
    expect(result.error).toBeUndefined();
    expect(result.statements?.length).toBe(1);
  });

  it("entry_code 非空但 path 为空被拒", () => {
    const result = planPermissionOps(rows(), [
      {
        code: "page_rbac",
        op: "update",
        patch: {entryCode: "system:role:manage"},
      },
    ]);
    expect(result.error?.key).toBe("errors.permission.entryCodeNeedsPath");
  });

  it("清掉 path 而 entry_code 还在被拒", () => {
    const current = rows();
    current[1] = {...current[1]!, path: "rbac", entryCode: "system:role:manage"};
    const result = planPermissionOps(current, [
      {code: "page_rbac", op: "update", patch: {path: null}},
    ]);
    expect(result.error?.key).toBe("errors.permission.entryCodeNeedsPath");
  });

  it("entry_code 指向本端已有的码：不存在的码被拒", () => {
    const result = planPermissionOps(rows(), [
      {
        code: "page_rbac",
        op: "update",
        patch: {path: "rbac", entryCode: "content:book:read"},
      },
    ]);
    expect(result.error?.key).toBe("errors.permission.invalidInput");
  });

  it("分组行与码行不接受 path / entry_code", () => {
    for (const code of ["group_account", "system:role:manage"]) {
      expect(
        planPermissionOps(rows(), [
          {code, op: "update", patch: {path: "x"}},
        ]).error?.key,
      ).toBe("errors.permission.invalidInput");
      expect(
        planPermissionOps(rows(), [
          {code, op: "update", patch: {entryCode: "system:role:manage"}},
        ]).error?.key,
      ).toBe("errors.permission.invalidInput");
    }
  });

  it("path 两侧多余的斜杠与空白被去掉", () => {
    const result = planPermissionOps(rows(), [
      {code: "page_rbac", op: "update", patch: {path: " /admin/rbac/ "}},
    ]);
    expect(result.error).toBeUndefined();
    expect(result.statements?.[0]?.params).toEqual(["admin/rbac", "pn_page_rbac"]);
  });
});

describe("入口字段的读写两侧一致", () => {
  it("列清单包含 path 与 entry_code", () => {
    const columns = PERMISSION_NODE_COLUMNS.split(",").map((entry) => entry.trim());
    expect(columns).toContain("path");
    expect(columns).toContain("entry_code");
  });

  it("toPermissionNodeRow 映射 path 与 entry_code", () => {
    expect(
      toPermissionNodeRow({
        audience: "desktop",
        code: "page_rbac",
        created_at_ms: 1,
        entry_code: "system:role:manage",
        i18n_key: null,
        icon: "shield-check",
        id: "pn_page_rbac",
        is_visible: 1,
        kind: "page",
        name_en: "Roles",
        name_zh: "角色",
        parent_code: "group_account",
        path: "rbac",
        permission_code: null,
        sort: 501,
        source: "seed",
      }),
    ).toMatchObject({path: "rbac", entryCode: "system:role:manage"});
  });

  it("导出 SQL 的种子行分支写 path 与 entry_code", () => {
    // 共用夹具里 page_rbac 两列都是空（「entry_code 非空但 path 为空」那条要用），
    // 这里单独给它填上值再导出。
    const current = rows();
    current[1] = {...current[1]!, path: "rbac", entryCode: "system:role:manage"};
    const sql = buildPermissionExportSql(current, 1700000000000);
    expect(sql).toContain("path = 'rbac'");
    expect(sql).toContain("entry_code = 'system:role:manage'");
  });
});

describe("normalizeEntryPath", () => {
  it("trims blanks and both kinds of slash", () => {
    expect(normalizeEntryPath("  /rbac/  ")).toBe("rbac");
    expect(normalizeEntryPath("rbac/audit")).toBe("rbac/audit");
    expect(normalizeEntryPath("//rbac/audit//")).toBe("rbac/audit");
  });

  it("turns blank input into null, which is the column's empty value", () => {
    expect(normalizeEntryPath("")).toBeNull();
    expect(normalizeEntryPath("   ")).toBeNull();
    expect(normalizeEntryPath("/")).toBeNull();
    expect(normalizeEntryPath(null)).toBeNull();
    expect(normalizeEntryPath(undefined)).toBeNull();
  });
});
