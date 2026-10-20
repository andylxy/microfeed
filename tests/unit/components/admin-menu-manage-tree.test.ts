import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it} from "vitest";

import "@/client/i18n";
import {
  dropPositionFromY,
  MenuBranchToggle,
  MenuTreeNode,
  MenuTreeCtx,
  MENU_ROOT_NODE,
  type MenuTreeCtxValue,
} from "@/components/admin/menu/MenuTreeNode";
import {
  childrenOf,
  isInjectedRow,
  menuInjectedRows,
  menuTopAncestorCode,
  reorderMenuRows,
  type MenuRow,
} from "@/shared/MenuTreeView";

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
    collapsed: {},
    language: "en",
    move: () => {},
    onSelect: () => {},
    rows: SAMPLE,
    search: {isForcedOpen: () => false, isHighlighted: () => false, query: ""},
    selectedCode: null,
    toggleOpen: () => {},
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
          React.createElement(MenuTreeNode, {key: entry.code, row: entry}),
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
    // 缩进来自子节点的嵌套容器 `border-l pl-4`（每个展开分支一个），
    // 不是行内 padding 累加。
    expect(html).toContain("border-l pl-4");
    expect((html.match(/border-l pl-4/gu) ?? []).length).toBe(2);
    expect(html).not.toContain("padding-left:");
  });

  it("renders the name-over-code label block with two weight levels", () => {
    const html = renderTree(SAMPLE);
    // 标签块：显示名在上、mono code 在下（跟 rbac 的叶子结构一致）。
    expect(html).toContain("font-mono text-xs text-muted-foreground");
    // 有子节点的分组行走 `text-sm font-semibold text-foreground` 字重。
    expect(html).toContain("font-semibold text-foreground");
    // 行与行之间没有横向分隔线；`border-transparent` 是按钮自身的类，不算分隔线。
    expect(html).not.toMatch(/ border-t /u);
    expect(html).not.toContain("border-t-0");
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

  it("keeps every row free of inline form controls", () => {
    const html = renderTree(SAMPLE);
    // v4：行内不再放输入框与下拉，编辑全部移到右侧详情面板。
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<select");
  });

  it("marks the selected row with aria-current", () => {
    const html = renderTree(SAMPLE, {selectedCode: "books"});
    const booksStart = html.indexOf('data-menu-node="books"');
    const nextNode = html.indexOf('data-menu-node="', booksStart + 1);
    const booksBlock = html.slice(booksStart, nextNode === -1 ? undefined : nextNode);
    expect(booksBlock).toContain('aria-current="true"');
    // 只有选中行带 aria-current（其余行一个都没有）。
    expect((html.match(/aria-current/gu) ?? []).length).toBe(1);
  });

  it("marks hidden rows with the Hidden badge", () => {
    const rows = SAMPLE.map((entry) =>
      entry.code === "books" ? {...entry, visible: false} : entry,
    );
    const html = renderTree(rows);
    const booksStart = html.indexOf('data-menu-node="books"');
    const nextNode = html.indexOf('data-menu-node="', booksStart + 1);
    const booksBlock = html.slice(booksStart, nextNode === -1 ? undefined : nextNode);
    expect(booksBlock).toContain("Hidden");
  });

  it("renders a drag handle on every node", () => {
    const html = renderTree(SAMPLE);
    // dragHandle 文案 "Drag to reorder" 出现次数 = 节点数（5）。
    expect((html.match(/Drag to reorder/gu) ?? []).length).toBe(5);
  });
});

describe("MenuBranchToggle", () => {
  const render = (expanded: boolean) =>
    renderToStaticMarkup(
      React.createElement(MenuBranchToggle, {
        expanded,
        label: "Books",
        onToggle: () => {},
      }),
    );

  it("renders the rbac branch arrow classes and rotates the chevron when open", () => {
    const html = render(true);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("focus-visible:ring-3");
    expect(html).toContain("rotate-90");
  });

  it("keeps the chevron pointing right when closed", () => {
    const html = render(false);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("rotate-90");
  });

  it("labels the arrow with the branch name", () => {
    expect(render(true)).toContain('aria-label="Toggle Books"');
  });
});

describe("menuTopAncestorCode", () => {
  it("returns the row itself when it is already top level", () => {
    expect(menuTopAncestorCode(SAMPLE, "group_content")).toBe("group_content");
  });

  it("walks the parent chain up to the top-level ancestor", () => {
    // child_of_custom → custom_dir → group_content
    expect(menuTopAncestorCode(SAMPLE, "child_of_custom")).toBe("group_content");
    expect(menuTopAncestorCode(SAMPLE, "books")).toBe("group_content");
  });

  it("returns null for a code that is not in the row set", () => {
    // 注入行只进渲染行集，不在数据行里，手风琴拿不到它的顶层。
    expect(menuTopAncestorCode(SAMPLE, "settings:custom-code")).toBeNull();
  });
});

describe("侧栏注入的三级子项（只读行）", () => {
  // 两列分别取清单文案，界面语言决定最终显示哪一列（单测固定 en）。
  const injected = menuInjectedRows((key) => key, (key) => `EN:${key}`);

  it("把三份清单合成挂在对应二级行下的行", () => {
    const under = (parentCode: string) =>
      injected.filter((entry) => entry.parentCode === parentCode).map((entry) => entry.code);
    expect(under("settings")).toHaveLength(11);
    expect(under("settings")[0]).toBe("settings:custom-code");
    expect(under("api")).toHaveLength(4);
    expect(under("webhooks")).toHaveLength(4);
  });

  it("名称两列都填清单文案，且没有路径与权限码", () => {
    const first = injected.find((entry) => entry.code === "settings:custom-code");
    expect(first?.nameZh).toBe("settings.websiteAppearance");
    expect(first?.nameEn).toBe("EN:settings.websiteAppearance");
    expect(first?.path).toBe("");
    expect(first?.permissionCode).toBeNull();
  });

  it("判据是 code 里的冒号：数据行永不命中", () => {
    expect(isInjectedRow(injected[0]!)).toBe(true);
    for (const entry of SAMPLE) expect(isInjectedRow(entry)).toBe(false);
  });

  it("渲染成不可拖、不可点、不带拖拽目标的只读行", () => {
    const rows = [
      row({
        code: "settings",
        i18nKey: "menu.item.settings",
        parentCode: null,
        path: "settings",
        sort: 200,
      }),
      ...injected.filter((entry) => entry.parentCode === "settings"),
    ];
    const html = renderTree(rows);
    // 注入行显示出来（mono code 带父级前缀），但不挂 data-menu-node。
    expect(html).toContain("settings:custom-code");
    expect(html).toContain('data-menu-node="settings"');
    expect(html).not.toContain('data-menu-node="settings:custom-code"');
    // 拖拽手柄只给数据行（settings 一个，11 个注入行都没有）。
    expect((html.match(/Drag to reorder/gu) ?? []).length).toBe(1);
    // 标签块 disabled：注入行点不中，进不了右侧详情面板。
    expect((html.match(/disabled=""/gu) ?? []).length).toBe(11);
    // 行尾 Injected 标记（title 里那句说明也以 Injected 开头，故按标签文本计数）。
    expect((html.match(/>Injected</gu) ?? []).length).toBe(11);
    expect(html).toContain("EN:settings.websiteAppearance");
  });
});

describe("MENU_ROOT_NODE", () => {
  it("is a synthetic code, so childrenOf never resolves it to rows", () => {
    expect(childrenOf(SAMPLE, MENU_ROOT_NODE)).toEqual([]);
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
