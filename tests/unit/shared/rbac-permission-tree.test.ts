import {describe, expect, it} from "vitest";

import {
  buildPermissionTree,
  permissionBranchState,
  RBAC_MINGCI_PAGE,
  RBAC_OTHER_GROUP,
  RBAC_OTHER_PAGE,
  togglePermissionBranch,
  type RbacPermissionTreeInput,
} from "@/shared/Rbac";

const PERMISSIONS = [
  {code: "*", name: "Everything"},
  {code: "content:book:read", name: "Read books"},
  {code: "content:book:create", name: "Create books"},
  {code: "content:category:read", name: "Read categories"},
  {code: "system:user:manage", name: "Manage users"},
  {code: "content:chapter:read", name: "Read articles"},
];

const MENU = [
  {code: "group_content", pages: ["books", "categories"]},
  {code: "group_account", pages: ["users"]},
];

const MAPPING = {
  books: ["content:book:read", "content:book:create"],
  categories: ["content:category:read"],
  users: ["system:user:manage"],
};

function build(overrides: Partial<RbacPermissionTreeInput> = {}) {
  return buildPermissionTree({
    mapping: MAPPING,
    menu: MENU,
    permissions: PERMISSIONS,
    ...overrides,
  });
}

describe("buildPermissionTree", () => {
  it("nests menu group -> page -> codes and keeps the menu order", () => {
    const groups = build();
    expect(groups.map((group) => group.code)).toEqual([
      "group_content",
      "group_account",
      RBAC_OTHER_GROUP,
    ]);
    expect(groups[0]?.pages.map((page) => page.code))
      .toEqual(["books", "categories"]);
    expect(groups[0]?.pages[0]?.codes)
      .toEqual(["content:book:create", "content:book:read"]);
  });

  it("drops the wildcard and keeps every other code visible exactly once", () => {
    const codes = build()
      .flatMap((group) => group.pages)
      .flatMap((page) => page.codes);
    expect(codes).not.toContain("*");
    const assignable = PERMISSIONS
      .map((permission) => permission.code)
      .filter((code) => code !== "*");
    expect([...codes].sort()).toEqual([...assignable].sort());
  });

  it("collects codes no page maps to into the catch-all group", () => {
    const other = build().find((group) => group.code === RBAC_OTHER_GROUP);
    expect(other?.pages).toEqual([
      {code: RBAC_OTHER_PAGE, codes: ["content:chapter:read"]},
    ]);
  });

  it("omits pages and groups that govern no code", () => {
    const groups = build({mapping: {...MAPPING, users: []}});
    expect(groups.map((group) => group.code)).not.toContain("group_account");
  });

  it("ignores mapping entries that are not in the catalogue", () => {
    const groups = build({
      mapping: {...MAPPING, books: ["content:book:read", "ghost"]},
    });
    expect(groups[0]?.pages[0]?.codes).toEqual(["content:book:read"]);
  });
});

describe("buildPermissionTree App 能力权限分流（合成 page）", () => {
  // 三个 App 能力权限：mingci 一条、search 两条。全部 unmapped（无 menu page 承接）。
  const APP_PERMISSIONS = [
    {code: "*", name: "Everything"},
    {code: "app:mingci:view", name: "名词解释查看"},
    {code: "app:search:global", name: "全局搜索查看"},
    {code: "app:search:book", name: "书内搜索查看"},
  ];

  it("routes app:mingci:* to the mingci page, keeps app:search:* in unmapped", () => {
    const groups = build({permissions: APP_PERMISSIONS, mapping: {}});
    expect(groups).toEqual([
      {
        code: RBAC_OTHER_GROUP,
        pages: [
          {code: RBAC_MINGCI_PAGE, codes: ["app:mingci:view"]},
          {
            code: RBAC_OTHER_PAGE,
            codes: ["app:search:book", "app:search:global"],
          },
        ],
      },
    ]);
  });

  it("omits the mingci page when no app:mingci:* code is in the catalogue", () => {
    const permissions = APP_PERMISSIONS.filter(
      (permission) => !permission.code.startsWith("app:mingci:"),
    );
    const groups = build({permissions, mapping: {}});
    expect(groups).toEqual([
      {
        code: RBAC_OTHER_GROUP,
        pages: [
          {
            code: RBAC_OTHER_PAGE,
            codes: ["app:search:book", "app:search:global"],
          },
        ],
      },
    ]);
  });

  it("omits the whole catch-all group when the catalogue is empty of unmapped codes", () => {
    // mingci 唯一一条 + 已被 menu page 映射到 books
    const groups = build({
      mapping: {books: ["app:mingci:view"]},
      permissions: [{code: "app:mingci:view", name: "名词解释查看"}],
    });
    expect(groups).toEqual([
      {code: "group_content", pages: [{code: "books", codes: ["app:mingci:view"]}]},
    ]);
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
    const groups = build();
    const groupCodes = groups[0]?.pages.flatMap((page) => page.codes) ?? [];
    const next = togglePermissionBranch([], groupCodes, true);

    // The branch nodes themselves are batch-selection units, so a save payload
    // must never carry them; only the leaf codes underneath are grants.
    expect(next).toEqual([...groupCodes].sort());
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
