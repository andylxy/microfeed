import {describe, expect, it} from "vitest";

import {
  buildSidebarItems,
  homeMenuItem,
  menuCodeFromNodeCode,
  roleSeesEntry,
} from "@/shared/AdminSidebarItems";
import type {PermissionNodeRow} from "@/shared/PermissionTreeOps";

/** 行工厂：非空缺省值让 fixture 只写测试关心的字段。 */
function node(code: string, patch: Partial<PermissionNodeRow> = {}): PermissionNodeRow {
  return {
    audience: "desktop",
    code,
    createdAtMs: 0,
    entryCode: null,
    icon: null,
    id: `pn_${code}`,
    i18nKey: null,
    kind: "page",
    nameEn: null,
    nameZh: null,
    parentCode: null,
    path: null,
    permissionCode: null,
    sort: 0,
    source: "seed",
    visible: true,
    ...patch,
  };
}

/** 侧栏预览用的门控：纯集合判定（真实侧栏传 `rbacAllows`，结论一致）。 */
function gate(permissions: readonly string[]): (entryCode: string) => boolean {
  return (entryCode) => roleSeesEntry(permissions, entryCode);
}

describe("menuCodeFromNodeCode", () => {
  it("strips the page_ prefix and leaves group codes alone", () => {
    expect(menuCodeFromNodeCode("page_rbac")).toBe("rbac");
    expect(menuCodeFromNodeCode("page_rbac_audit")).toBe("rbac_audit");
    expect(menuCodeFromNodeCode("group_account")).toBe("group_account");
  });
});

describe("roleSeesEntry", () => {
  it("never shows a page whose entry code is empty, even for the wildcard holder", () => {
    expect(roleSeesEntry(["*"], null)).toBe(false);
    expect(roleSeesEntry(["*"], "")).toBe(false);
    expect(roleSeesEntry([], null)).toBe(false);
  });

  it("accepts the matching code and the wildcard, and rejects everything else", () => {
    expect(roleSeesEntry(["content:book:read"], "content:book:read")).toBe(true);
    expect(roleSeesEntry(["*"], "content:book:read")).toBe(true);
    expect(roleSeesEntry(["content:book:read"], "content:book:update")).toBe(false);
    expect(roleSeesEntry([], "content:book:read")).toBe(false);
  });
});

describe("homeMenuItem", () => {
  it("always points at the admin root and takes the configured prefix", () => {
    expect(homeMenuItem()).toMatchObject({
      active: false,
      disabled: false,
      icon: "home",
      id: "admin_home",
      url: "/admin/",
    });
    expect(homeMenuItem("studio")).toMatchObject({active: false, url: "/studio/"});
    expect(homeMenuItem("studio", true).active).toBe(true);
  });
});

/** 一个分组挂两个页面，另一个分组挂一个页面，再加一个不在分组里的孤儿页面。 */
function nodes(): PermissionNodeRow[] {
  return [
    node("group_content", {
      icon: "library",
      kind: "group",
      nameEn: "Content",
      nameZh: "内容",
      parentCode: null,
      sort: 100,
    }),
    node("group_account", {
      icon: "users",
      kind: "group",
      nameEn: "Account",
      nameZh: "账号",
      parentCode: null,
      sort: 200,
    }),
    node("page_books", {
      entryCode: "content:book:read",
      kind: "page",
      nameEn: "Books",
      nameZh: "图书",
      parentCode: "group_content",
      path: "books",
      sort: 101,
    }),
    node("page_audit", {
      entryCode: "system:role:manage",
      kind: "page",
      nameEn: "Audit log",
      nameZh: "操作日志",
      parentCode: "group_account",
      path: "rbac/audit",
      sort: 202,
    }),
    node("page_settings", {
      entryCode: "content:settings:manage",
      kind: "page",
      nameEn: "Settings",
      nameZh: "设置",
      parentCode: null,
      path: "settings",
      sort: 300,
    }),
  ];
}

describe("buildSidebarItems", () => {
  it("prepends the dashboard home and lists the allowed pages under their groups", () => {
    const {items, pageCount} = buildSidebarItems(
      nodes(),
      gate(["content:book:read", "content:settings:manage"]),
    );

    expect(items.map((item) => item.id)).toEqual([
      "admin_home",
      "group_content",
      "settings",
    ]);
    expect(items[1]).toMatchObject({
      children: [{id: "books", nodeCode: "page_books", url: "/admin/books/"}],
      icon: "library",
      label: {en: "Content", zh: "内容"},
      // 分组本身不是页面，链接指回第一个子项。
      url: "/admin/books/",
    });
    expect(items[2]).toMatchObject({url: "/admin/settings/"});
    expect(items[2]!.children).toBeUndefined();
    expect(pageCount).toBe(2);
  });

  it("keeps groups in (sort, code) order, so the sidebar never reshuffles", () => {
    const {items} = buildSidebarItems(nodes(), gate(["*"]));
    expect(items.map((item) => item.id)).toEqual([
      "admin_home",
      "group_content",
      "group_account",
      "settings",
    ]);
  });

  it("leaves out a page the role may not open, and drops the group that is left empty", () => {
    const {items, pageCount} = buildSidebarItems(nodes(), gate(["system:role:manage"]));

    expect(items.map((item) => item.id)).toEqual(["admin_home", "group_account"]);
    expect(items[1]!.children?.map((child) => child.id)).toEqual(["audit"]);
    expect(items[1]!.url).toBe("/admin/rbac/audit/");
    expect(pageCount).toBe(1);
  });

  it("only returns the dashboard home when nothing else passes the gate", () => {
    const {items, pageCount} = buildSidebarItems(nodes(), gate([]));
    expect(items.map((item) => item.id)).toEqual(["admin_home"]);
    expect(pageCount).toBe(0);
  });

  it("treats the wildcard as seeing everything", () => {
    const {items, pageCount} = buildSidebarItems(nodes(), gate(["*"]));
    expect(pageCount).toBe(3);
    expect(items.filter((item) => item.children).length).toBe(2);
  });

  it("excludes hidden rows, code rows, and the mobile console", () => {
    const {items, pageCount} = buildSidebarItems(
      [
        ...nodes(),
        node("page_hidden", {
          entryCode: "content:book:read",
          kind: "page",
          nameEn: "Hidden",
          parentCode: "group_content",
          path: "hidden",
          sort: 102,
          visible: false,
        }),
        node("code_book_read", {
          kind: "code",
          nameEn: "Read books",
          parentCode: "page_books",
          permissionCode: "content:book:read",
          sort: 1,
        }),
        node("page_mobile_only", {
          audience: "app",
          entryCode: "content:book:read",
          kind: "page",
          nameEn: "Mobile",
          parentCode: "group_content",
          path: "books",
          sort: 103,
        }),
      ],
      gate(["*"]),
    );

    expect(items[1]!.children?.map((child) => child.id)).toEqual(["books"]);
    expect(pageCount).toBe(3);
  });

  it("promotes a sub-group to the top level when its parent group is filtered out", () => {
    const {items} = buildSidebarItems(
      [
        node("group_admin", {kind: "group", nameEn: "Admin", parentCode: null, sort: 100}),
        node("group_rbac", {kind: "group", nameEn: "Access", parentCode: "group_admin", sort: 101}),
        node("page_rbac", {
          entryCode: "system:role:manage",
          kind: "page",
          nameEn: "Roles",
          parentCode: "group_rbac",
          path: "rbac",
          sort: 102,
        }),
        node("page_admin", {
          entryCode: "content:settings:manage",
          kind: "page",
          nameEn: "Settings",
          parentCode: "group_admin",
          path: "settings",
          sort: 103,
        }),
      ],
      gate(["system:role:manage"]),
    );

    expect(items.map((item) => item.id)).toEqual(["admin_home", "group_admin"]);
    expect(items[1]!.children?.map((child) => child.id)).toEqual(["group_rbac"]);
    expect(items[1]!.children?.[0]!.children?.map((child) => child.id))
      .toEqual(["rbac"]);
  });

  it("marks the active page and prefixes every url with the configured admin path", () => {
    const {items} = buildSidebarItems(
      nodes(),
      gate(["content:book:read"]),
      "studio",
      "books",
    );

    expect(items[0]).toMatchObject({id: "admin_home", active: false, url: "/studio/"});
    expect(items[1]).toMatchObject({id: "group_content", active: false});
    expect(items[1]!.children?.[0]).toMatchObject({
      active: true,
      id: "books",
      url: "/studio/books/",
    });
  });

  it("omits the label when the node has no display name, so the renderer can fall back", () => {
    const {items} = buildSidebarItems(
      [node("page_anonymous", {entryCode: "content:book:read", path: "anonymous", sort: 1})],
      gate(["*"]),
    );

    expect(items[1]).not.toHaveProperty("label");
  });

  it("carries the node code so the third-level registry can key on it", () => {
    const {items} = buildSidebarItems(
      [node("page_settings", {entryCode: "content:settings:manage", path: "settings", sort: 101})],
      gate(["*"]),
    );

    expect(items[1]).toMatchObject({id: "settings", nodeCode: "page_settings"});
  });
});
