import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it} from "vitest";

import {
  PermissionTreeCtx,
  PermissionTreeNode,
  permissionDescendantCodes,
  type PermissionTreeCtxValue,
} from "@/components/admin/rbac/PermissionTreeNode";
import {PermissionNodeEditor} from "@/components/admin/rbac/PermissionNodeEditor";
import type {InterfaceCatalogRow} from "@/shared/AppInterface";
import {
  permissionBranchState,
} from "@/shared/Rbac";
import type {PermissionNodeRowWithMeta} from "@/shared/PermissionTreeOps";

/** 行工厂：非空缺省值让 fixture 只写测试关心的字段。 */
function node(
  code: string,
  patch: Partial<PermissionNodeRowWithMeta> = {},
): PermissionNodeRowWithMeta {
  return {
    audience: "desktop",
    code,
    createdAtMs: 0,
    deletable: false,
    editable: true,
    icon: null,
    id: code,
    i18nKey: null,
    kind: "code",
    nameEn: null,
    nameZh: null,
    parentCode: null,
    permissionCode: null,
    sort: 0,
    source: "seed",
    visible: true,
    ...patch,
  };
}

/** 分组 → 页面 → 两个码，单页口径下树勾选的最小三层数据。 */
function rows(): PermissionNodeRowWithMeta[] {
  return [
    node("group_content", {kind: "group", nameEn: "Content", parentCode: null, sort: 1}),
    node("page_books", {
      kind: "page",
      nameEn: "Books",
      parentCode: "group_content",
      sort: 101,
    }),
    node("code_read", {
      parentCode: "page_books",
      permissionCode: "content:book:read",
      sort: 1,
    }),
    node("code_update", {
      parentCode: "page_books",
      permissionCode: "content:book:update",
      sort: 2,
    }),
  ];
}

/** 权限目录名（`ext_permissions.name`）：码行标签只从这里取（ADR-0038）。 */
const PERMISSION_NAMES = new Map([
  ["content:book:read", "读图书"],
  ["content:book:update", "改图书"],
  ["app:fang:read", "中药方剂读取"],
]);

function ctxValue(
  granted: readonly string[],
  patch: Partial<PermissionTreeCtxValue> = {},
): PermissionTreeCtxValue {
  const grantedSet = new Set(granted);
  return {
    collapsed: {},
    grants: {
      disabled: false,
      state: (codes) => permissionBranchState([...codes], grantedSet),
      toggle: () => undefined,
    },
    language: "en",
    move: () => undefined,
    onSelect: () => undefined,
    permissionNames: PERMISSION_NAMES,
    rows: rows(),
    search: {
      isForcedOpen: () => true,
      isHighlighted: () => false,
      query: "",
    },
    selectedCode: null,
    toggleOpen: () => undefined,
    ...patch,
  };
}

function renderTree(granted: readonly string[], patch: Partial<PermissionTreeCtxValue> = {}) {
  const root = rows().find((row) => row.code === "group_content") ?? node("group_content");
  return renderToStaticMarkup(
    React.createElement(
      PermissionTreeCtx.Provider,
      {value: ctxValue(granted, patch)},
      React.createElement(PermissionTreeNode, {row: root}),
    ),
  );
}

/** React renders a ticked checkbox as `checked=""` and omits it otherwise. */
function checkedCount(html: string): number {
  return (html.match(/checked=""/gu) ?? []).length;
}

describe("PermissionTreeNode grant checkboxes", () => {
  it("renders the grouping, page and code rows of the tree", () => {
    const output = renderTree([]);
    expect(output).toContain("Content");
    expect(output).toContain("Books");
    // 码行行内只有中文用途名，不再跟权限码。
    expect(output).toContain("读图书");
    expect(output).toContain("改图书");
  });

  it("checks only the codes the role actually holds", () => {
    // One leaf granted out of two: the group and page branches stay
    // unticked (they are partially granted), so exactly one box is checked.
    expect(checkedCount(renderTree(["content:book:read"]))).toBe(1);
    expect(checkedCount(renderTree([]))).toBe(0);
    // Both leaves: group + page + two codes all read as checked.
    expect(checkedCount(renderTree(["content:book:read", "content:book:update"]))).toBe(4);
  });

  it("disables every checkbox for a wildcard holder", () => {
    // 通配角色全禁用（RbacApp 传 disabled=true）：树仍渲染，但勾不掉也勾不进。
    const output = renderTree([], {
      grants: {
        disabled: true,
        state: () => ({checked: true, indeterminate: false}),
        toggle: () => undefined,
      },
    });
    expect(output).toContain("disabled");
    expect(output.match(/disabled=""/gu) ?? []).toHaveLength(4);
  });

  it("labels code rows with the permission catalog name only", () => {
    // 码结点自身 name 列为空，行标签必须取权限目录名（中文用途名）；
    // 行内不再跟原码，码只在右栏详情里出现。
    const output = renderTree([]);
    expect(output).toContain("读图书");
    expect(output).toContain("改图书");
    expect(output).not.toContain("content:book:read");
    expect(output).not.toContain("content:book:update");
  });

  it("collects every descendant code for batch grant rows", () => {
    // 分组/页面行批量勾的是全部后代码；码行没有后代，自己的码由勾选框直取。
    expect(permissionDescendantCodes(rows(), "group_content")).toEqual([
      "content:book:read",
      "content:book:update",
    ]);
    expect(permissionDescendantCodes(rows(), "page_books")).toEqual([
      "content:book:read",
      "content:book:update",
    ]);
    expect(permissionDescendantCodes(rows(), "code_read")).toEqual([]);
  });
});

describe("PermissionNodeEditor narrow edit for code rows", () => {
  function renderEditor(row: PermissionNodeRowWithMeta) {
    return renderToStaticMarkup(
      React.createElement(PermissionNodeEditor, {
        busy: false,
        confirmReparent: () => true,
        language: "en" as const,
        onAddChildGroup: () => undefined,
        onDelete: () => undefined,
        onField: () => undefined,
        onMove: () => undefined,
        permissionNames: PERMISSION_NAMES,
        row,
        rows: rows(),
      }),
    );
  }

  it("keeps the parent picker and visibility switch on a code row", () => {
    // 码结点按 ADR-0038 只能改父级与显隐；详情面板不能只剩只读卡片。
    const output = renderEditor(rows()[2]!);
    expect(output).toContain("读图书");
    expect(output).toContain("content:book:read");
    expect(output).toContain("Parent");
    expect(output).toContain("Visibility");
    expect(output).toContain('role="switch"');
  });

  it("still hides the name and icon fields on a code row", () => {
    const output = renderEditor(rows()[2]!);
    expect(output).not.toContain("Chinese name");
    expect(output).not.toContain("English name");
  });

  it("offers the full field set on a page row", () => {
    const output = renderEditor(rows()[1]!);
    expect(output).toContain("Chinese name");
    expect(output).toContain("English name");
    expect(output).toContain("Icon");
    expect(output).toContain("Parent");
    expect(output).toContain("Visibility");
    // 页面行不走码行的只读卡片。
    expect(output).not.toContain("Permission name (read-only)");
  });
});

describe("PermissionTreeNode interface leaves", () => {
  const leaves: InterfaceCatalogRow[] = [
    {auth: "mflc", method: "GET", path: "/api/AppBookRequest/GetBookIdFang/", permissionCodes: ["app:fang:read"]},
  ];
  const byCode = new Map([["app:fang:read", leaves]]);
  const interfaces = {
    byCode,
    onSelect: () => undefined,
    selectedPath: null as string | null,
  };

  it("mounts read-only path leaves under their code node", () => {
    const tree = rows().concat(
      node("code_fang", {audience: "app", parentCode: null, permissionCode: "app:fang:read"}),
    );
    const output = renderToStaticMarkup(
      React.createElement(
        PermissionTreeCtx.Provider,
        {value: ctxValue([], {interfaces: {...interfaces, selectedPath: null}, rows: tree})},
        React.createElement(PermissionTreeNode, {
          row: node("code_fang", {
            audience: "app",
            parentCode: null,
            permissionCode: "app:fang:read",
          }),
        }),
      ),
    );
    // ADR-0039 R3：叶子行给路径 + 方法徽章 + 「只读」徽章。
    expect(output).toContain("/api/AppBookRequest/GetBookIdFang/");
    expect(output).toContain("GET");
    expect(output).toContain("Read-only");
  });

  it("marks the selected leaf with aria-current", () => {
    const tree = rows().concat(
      node("code_fang", {audience: "app", parentCode: null, permissionCode: "app:fang:read"}),
    );
    const output = renderToStaticMarkup(
      React.createElement(
        PermissionTreeCtx.Provider,
        {
          value: ctxValue([], {
            interfaces: {...interfaces, selectedPath: "/api/AppBookRequest/GetBookIdFang/"},
            rows: tree,
          }),
        },
        React.createElement(PermissionTreeNode, {
          row: node("code_fang", {
            audience: "app",
            parentCode: null,
            permissionCode: "app:fang:read",
          }),
        }),
      ),
    );
    expect(output).toContain('aria-current="true"');
  });

  it("renders no leaves for a code without catalog entries", () => {
    const output = renderTree([], {interfaces: {...interfaces, selectedPath: null}});
    expect(output).not.toContain("/api/AppBookRequest/");
  });
});
