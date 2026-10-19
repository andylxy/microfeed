import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it} from "vitest";

import "@/client/i18n";
import {
  childrenOf,
  dropPositionFromY,
  MenuTreeNode,
  MenuTreeCtx,
  reorderMenuRows,
  type MenuRow,
  type MenuTreeCtxValue,
} from "@/components/admin/menu/MenuTreeNode";

// 组件单测跑在 node（无 jsdom），经 renderToStaticMarkup 静态渲染；
// vitest 的 setup 把语言固定为英文，i18n 回退取 en.ts 的值。

function row(overrides: Partial<MenuRow> = {}): MenuRow {
  return {
    code: "books",
    createdAtMs: 0,
    deletable: false,
    i18nKey: "menu.item.books",
    icon: "book",
    id: "m_books",
    nameEn: null,
    nameZh: null,
    parentCode: null,
    path: "books",
    permissionCode: "content:book:read",
    sort: 10,
    visible: true,
    ...overrides,
  };
}

const SAMPLE: MenuRow[] = [
  row({code: "group_content", i18nKey: "menu.item.group_content", icon: null, id: "m_group_content", nameZh: null, parentCode: null, path: "", permissionCode: null, sort: 200}),
  row({code: "books", parentCode: "group_content", sort: 201}),
  row({code: "volumes", i18nKey: "menu.item.volumes", id: "m_volumes", parentCode: "group_content", sort: 202}),
  row({code: "child_of_custom", id: "mm_child_of_custom", parentCode: "custom_dir", path: "", permissionCode: null, sort: 1}),
  row({code: "custom_dir", id: "mm_custom_dir", parentCode: "group_content", path: "", permissionCode: null, sort: 203, deletable: true}),
];

function baseCtx(overrides: Partial<MenuTreeCtxValue> = {}): MenuTreeCtxValue {
  return {
    addChildGroup: () => {},
    collapsed: {},
    confirmPageParent: () => true,
    disabled: false,
    language: "en",
    move: () => {},
    removeRow: () => {},
    restoreDefault: () => {},
    rows: SAMPLE,
    search: {isForcedOpen: () => false, isHighlighted: () => false, query: ""},
    toggleOpen: () => {},
    updateField: () => {},
    ...overrides,
  };
}

function renderTree(rows: MenuRow[], overrides: Partial<MenuTreeCtxValue> = {}): string {
  const ctx = baseCtx({rows, ...overrides});
  const roots = childrenOf(rows, "");
  return renderToStaticMarkup(
    React.createElement(
      MenuTreeCtx.Provider,
      {value: ctx},
      React.createElement(
        "div",
        null,
        ...roots.map((entry) =>
          React.createElement(MenuTreeNode, {key: entry.code, depth: 0, row: entry}),
        ),
      ),
    ),
  );
}

describe("childrenOf", () => {
  it("returns the direct children of a parent sorted by (sort, code)", () => {
    const kids = childrenOf(SAMPLE, "group_content").map((entry) => entry.code);
    expect(kids).toEqual(["books", "volumes", "custom_dir"]);
  });

  it("returns the roots when the parent is empty", () => {
    expect(childrenOf(SAMPLE, "").map((entry) => entry.code)).toEqual(["group_content"]);
  });
});

describe("MenuTreeNode recursive render", () => {
  it("renders nested levels for the whole forest", () => {
    const html = renderTree(SAMPLE);
    // 顶层分组、它的三个子、以及 custom_dir 下的 child_of_custom 都出现。
    expect(html).toContain('data-menu-node="group_content"');
    expect(html).toContain('data-menu-node="books"');
    expect(html).toContain('data-menu-node="volumes"');
    expect(html).toContain('data-menu-node="custom_dir"');
    expect(html).toContain('data-menu-node="child_of_custom"');
    // 缩进随深度递增：child 的 paddingLeft 大于 parent。
    expect(html).toContain("padding-left:8px");
    expect(html).toContain("padding-left:44px");
  });

  it("hides children of a collapsed group", () => {
    const html = renderTree(SAMPLE, {collapsed: {group_content: true}});
    expect(html).toContain('data-menu-node="group_content"');
    expect(html).not.toContain('data-menu-node="books"');
  });

  it("forces ancestors open during search even when collapsed", () => {
    const html = renderTree(SAMPLE, {
      collapsed: {group_content: true},
      search: {
        isForcedOpen: (code) => code === "group_content",
        isHighlighted: (code) => code === "books",
        query: "books",
      },
    });
    // 分组被强制展开，命中子节点渲染出来。
    expect(html).toContain('data-menu-node="books"');
  });

  it("marks a matched node with the highlight class", () => {
    const html = renderTree(SAMPLE, {
      search: {
        isForcedOpen: (code) => code === "group_content",
        isHighlighted: (code) => code === "volumes",
        query: "volumes",
      },
    });
    // 命中节点的 code 文案带 text-primary（高亮）。
    expect(html).toContain("text-primary");
    expect(html).toContain('data-menu-node="volumes"');
  });

  it("shows the add sub-group button only on group rows (empty path)", () => {
    const html = renderTree(SAMPLE);
    // 分组行（path 空）含 Add sub-group；本例 group_content / custom_dir / child_of_custom 三个分组 → 三次。
    expect((html.match(/Add sub-group/gu) ?? []).length).toBe(3);
    // 仅截出 books 节点自身（到下一个 data-menu-node 之前），确认页面行不含该按钮。
    const booksStart = html.indexOf('data-menu-node="books"');
    const nextNode = html.indexOf('data-menu-node="', booksStart + 1);
    const booksBlock = html.slice(booksStart, nextNode === -1 ? undefined : nextNode);
    expect(booksBlock).not.toContain("Add sub-group");
  });

  it("renders a drag handle on every node", () => {
    const html = renderTree(SAMPLE);
    // dragHandle 文案 "Drag to reorder" 出现次数 = 节点数（5）。
    expect((html.match(/Drag to reorder/gu) ?? []).length).toBe(5);
  });
});

describe("dropPositionFromY", () => {
  const rect = {top: 0, bottom: 30, height: 30};

  it("maps the three vertical thirds to before / inside / after", () => {
    expect(dropPositionFromY(rect, 5, true)).toBe("before");
    expect(dropPositionFromY(rect, 15, true)).toBe("inside");
    expect(dropPositionFromY(rect, 25, true)).toBe("after");
  });

  it("falls back to before/after on the midline when inside is not allowed", () => {
    expect(dropPositionFromY(rect, 5, false)).toBe("before");
    expect(dropPositionFromY(rect, 25, false)).toBe("after");
    expect(dropPositionFromY(rect, 15, false)).toBe("after");
  });
});

describe("reorderMenuRows", () => {
  it("reorders siblings within the same parent (before)", () => {
    const out = reorderMenuRows(SAMPLE, "books", "volumes", "before");
    const books = out.find((row) => row.code === "books");
    const volumes = out.find((row) => row.code === "volumes");
    expect(books?.parentCode).toBe("group_content");
    expect(books?.sort).toBeLessThan(volumes?.sort ?? 0);
  });

  it("re-parents a row under a group with inside", () => {
    const out = reorderMenuRows(SAMPLE, "books", "custom_dir", "inside");
    expect(out.find((row) => row.code === "books")?.parentCode).toBe("custom_dir");
    const kids = out
      .filter((row) => (row.parentCode ?? null) === "custom_dir")
      .sort((left, right) => left.sort - right.sort)
      .map((row) => row.code);
    // books 挂到 custom_dir 末尾（sort 最大）。
    expect(kids).toEqual(["child_of_custom", "books"]);
  });

  it("refuses a cycle (drag a node into its own descendant)", () => {
    expect(reorderMenuRows(SAMPLE, "group_content", "custom_dir", "inside")).toBe(SAMPLE);
  });

  it("returns the same reference for a no-op drag", () => {
    expect(reorderMenuRows(SAMPLE, "books", "books", "before")).toBe(SAMPLE);
  });
});
