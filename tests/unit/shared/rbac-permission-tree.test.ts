import {describe, expect, it} from "vitest";

import {buildGrantGroupsFromNodes, type PermissionNodeRow} from "@/shared/PermissionTreeOps";
import {permissionBranchState, togglePermissionBranch} from "@/shared/Rbac";

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

/** The permission catalogue (ext_permissions); only codes present here are grants. */
const CATALOG = new Map<string, string>([
  ["content:book:read", "Read books"],
  ["content:book:create", "Create books"],
  ["content:chapter:read", "Read articles"],
  ["system:user:manage", "Manage users"],
]);

/** A minimal self-hosted tree (ADR-0038): group -> page -> code nodes. */
function tree(): PermissionNodeRow[] {
  return [
    node({
      code: "group_content", kind: "group", parentCode: null, sort: 1,
      nameZh: "内容", nameEn: "Content",
    }),
    node({
      code: "page_books", kind: "page", parentCode: "group_content", sort: 101,
      nameZh: "书籍", nameEn: "Books",
    }),
    node({
      code: "c_read", kind: "code", parentCode: "page_books",
      permissionCode: "content:book:read", sort: 1,
    }),
    node({
      code: "c_create", kind: "code", parentCode: "page_books",
      permissionCode: "content:book:create", sort: 2,
    }),
  ];
}

describe("buildGrantGroupsFromNodes (self-hosted tree, ADR-0038)", () => {
  it("nests group -> page -> codes and strips the page_ prefix", () => {
    const groups = buildGrantGroupsFromNodes(tree(), CATALOG, "desktop");
    expect(groups.map((group) => group.code)).toEqual(["group_content"]);
    // The page node code is `page_books`; the grant view shows `books`.
    expect(groups[0]?.pages.map((page) => page.code)).toEqual(["books"]);
    // Code nodes keep their underlying permission code; order follows node sort.
    expect(groups[0]?.pages[0]?.codes)
      .toEqual(["content:book:read", "content:book:create"]);
  });

  it("carries node nameZh/nameEn/i18nKey onto groups and pages", () => {
    const groups = buildGrantGroupsFromNodes(tree(), CATALOG, "desktop");
    expect(groups[0]?.nameZh).toBe("内容");
    expect(groups[0]?.nameEn).toBe("Content");
    expect(groups[0]?.pages[0]?.nameZh).toBe("书籍");
    expect(groups[0]?.pages[0]?.nameEn).toBe("Books");
  });

  it("drops code nodes whose permission code is not in the catalogue", () => {
    const rows = [
      ...tree(),
      node({
        code: "c_ghost", kind: "code", parentCode: "page_books",
        permissionCode: "ghost:code:read", sort: 3,
      }),
    ];
    const groups = buildGrantGroupsFromNodes(rows, CATALOG, "desktop");
    expect(groups[0]?.pages[0]?.codes).not.toContain("ghost:code:read");
  });

  it("drops the wildcard and never surfaces it as a grant", () => {
    const rows = [
      ...tree(),
      node({
        code: "c_star", kind: "code", parentCode: "page_books",
        permissionCode: "*", sort: 3,
      }),
    ];
    const groups = buildGrantGroupsFromNodes(rows, CATALOG, "desktop");
    expect(groups[0]?.pages[0]?.codes).not.toContain("*");
  });

  it("omits pages and groups that govern no code", () => {
    const rows: PermissionNodeRow[] = [
      ...tree(),
      node({
        code: "group_account", kind: "group", parentCode: null, sort: 2,
        nameZh: "账户", nameEn: "Account",
      }),
      node({code: "page_users", kind: "page", parentCode: "group_account", sort: 201}),
      node({
        code: "c_unmapped", kind: "code", parentCode: "page_users",
        permissionCode: "no-such-code", sort: 1,
      }),
    ];
    const groups = buildGrantGroupsFromNodes(rows, CATALOG, "desktop");
    // group_account's only page has no catalogue-backed code, so the whole
    // branch collapses out; the seeded group_content branch stays.
    expect(groups.map((group) => group.code)).toEqual(["group_content"]);
    expect(groups.find((group) => group.code === "group_account")).toBeUndefined();
  });
});

describe("togglePermissionBranch", () => {
  it("grants every code in the branch, deduped and sorted", () => {
    expect(togglePermissionBranch(["a"], ["b", "a", "c"], true))
      .toEqual(["a", "b", "c"]);
  });

  it("revokes every code in the branch", () => {
    expect(togglePermissionBranch(["a", "b", "c"], ["b", "c"], false))
      .toEqual(["a"]);
  });

  it("grants only real permission codes — never a group or page code", () => {
    // The branch nodes themselves are batch-selection units, so a save payload
    // must never carry them; only the leaf codes underneath are grants.
    const branchCodes = ["content:book:read", "content:book:create"];
    const next = togglePermissionBranch([], branchCodes, true);
    expect(next).toEqual([...branchCodes].sort());
    expect(next).not.toContain("group_content");
    expect(next).not.toContain("books");
    expect(next).not.toContain("*");
  });
});

describe("permissionBranchState", () => {
  it("is checked when the whole branch is granted", () => {
    expect(permissionBranchState(["a", "b"], new Set(["a", "b"])))
      .toEqual({checked: true, indeterminate: false});
  });

  it("is indeterminate when only part of the branch is granted", () => {
    expect(permissionBranchState(["a", "b"], new Set(["a"])))
      .toEqual({checked: false, indeterminate: true});
  });

  it("is unchecked and settled when nothing is granted", () => {
    expect(permissionBranchState(["a", "b"], new Set()))
      .toEqual({checked: false, indeterminate: false});
  });
});
