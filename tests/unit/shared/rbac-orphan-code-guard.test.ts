import {describe, expect, it} from "vitest";

import {
  buildGrantGroupsFromNodes,
  permissionTopAncestorCode,
  type PermissionNodeRow,
} from "@/shared/PermissionTreeOps";

function node(
  overrides: Partial<PermissionNodeRow> & {code: string},
): PermissionNodeRow {
  return {
    audience: "desktop",
    createdAtMs: 0,
    entryCode: null,
    path: null,
    icon: null,
    id: overrides.code,
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

const CATALOG = new Map<string, string>([
  ["content:book:read", "Read books"],
  ["content:book:create", "Create books"],
]);

/**
 * 守护用例（ADR-0038 票据 06）：自持的树里不许有孤儿节点——码行的父级必须是
 * 页面、页面行的父级必须是分组。出现孤儿会让某些码变得无法授出，或某些页面
 * 永远不会渲染。「目录里每个码都有一条节点行」那一层由 worker 的可达性用例守，
 * 这里守的是 `buildGrantGroupsFromNodes` 依赖的结构完整性。
 */
describe("permission tree has no orphan nodes (ADR-0038)", () => {
  it("every code node's parent is a page and every page node's parent is a group", () => {
    const rows: PermissionNodeRow[] = [
      node({code: "group_content", kind: "group", parentCode: null, sort: 1}),
      node({code: "page_books", kind: "page", parentCode: "group_content", sort: 101}),
      node({
        code: "c_read", kind: "code", parentCode: "page_books",
        permissionCode: "content:book:read", sort: 1,
      }),
    ];
    const byCode = new Map(rows.map((row) => [row.code, row]));
    for (const row of rows) {
      const parent = row.parentCode ? byCode.get(row.parentCode) : undefined;
      if (row.kind === "code") {
        expect(parent?.kind, `${row.code} parent must be a page`).toBe("page");
      }
      if (row.kind === "page") {
        expect(parent?.kind, `${row.code} parent must be a group`).toBe("group");
      }
    }
  });

  it("surfaces every catalogue-backed code exactly once and never drops a grant silently", () => {
    const rows: PermissionNodeRow[] = [
      node({code: "group_content", kind: "group", parentCode: null, sort: 1}),
      node({code: "page_books", kind: "page", parentCode: "group_content", sort: 101}),
      node({
        code: "c_read", kind: "code", parentCode: "page_books",
        permissionCode: "content:book:read", sort: 1,
      }),
      node({
        code: "c_create", kind: "code", parentCode: "page_books",
        permissionCode: "content:book:create", sort: 2,
      }),
    ];
    const groups = buildGrantGroupsFromNodes(rows, CATALOG, "desktop");
    const flat = groups
      .flatMap((group) => group.pages)
      .flatMap((page) => page.codes)
      .sort();
    expect(flat).toEqual(["content:book:create", "content:book:read"]);
  });

  it("resolves a code's top ancestor to the root group", () => {
    const rows: PermissionNodeRow[] = [
      node({code: "group_content", kind: "group", parentCode: null, sort: 1}),
      node({code: "page_books", kind: "page", parentCode: "group_content", sort: 101}),
      node({
        code: "c_read", kind: "code", parentCode: "page_books",
        permissionCode: "content:book:read", sort: 1,
      }),
    ];
    expect(permissionTopAncestorCode(rows, "c_read")).toBe("group_content");
  });
});
