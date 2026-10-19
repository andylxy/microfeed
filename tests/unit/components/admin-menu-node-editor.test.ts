import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it} from "vitest";

import "@/client/i18n";
import {
  MenuGroupCreator,
  MenuNodeEditor,
  type MenuGroupDraft,
} from "@/components/admin/menu/MenuNodeEditor";
import type {MenuRow} from "@/components/admin/menu/MenuTreeNode";

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
    parentCode: "group_content",
    path: "books",
    permissionCode: "content:book:read",
    sort: 201,
    visible: true,
    ...overrides,
  };
}

const SAMPLE: MenuRow[] = [
  row({
    code: "group_content",
    i18nKey: "menu.item.group_content",
    icon: null,
    id: "m_group_content",
    parentCode: null,
    path: "",
    permissionCode: null,
    sort: 200,
  }),
  row({code: "books", parentCode: "group_content", sort: 201}),
  row({
    code: "volumes",
    i18nKey: "menu.item.volumes",
    id: "m_volumes",
    parentCode: "group_content",
    sort: 202,
  }),
];

function renderEditor(target: MenuRow, rows: MenuRow[] = SAMPLE): string {
  return renderToStaticMarkup(
    React.createElement(MenuNodeEditor, {
      busy: false,
      confirmPageParent: () => true,
      language: "en",
      onAddChildGroup: () => {},
      onDelete: () => {},
      onField: () => {},
      onMove: () => {},
      onRestoreDefault: () => {},
      row: target,
      rows,
    }),
  );
}

function renderCreator(draft: MenuGroupDraft, rows: MenuRow[] = SAMPLE): string {
  return renderToStaticMarkup(
    React.createElement(MenuGroupCreator, {
      busy: false,
      draft,
      onCancel: () => {},
      onDraftChange: () => {},
      onSubmit: () => {},
      rows,
    }),
  );
}

describe("MenuNodeEditor", () => {
  it("renders the header with the effective name and the mono code", () => {
    const html = renderEditor(row());
    // 生效名走 i18n 回退（menu.item.books = Books），code 在 mono 段落里。
    expect(html).toContain("<h2");
    expect(html).toContain("Books");
    expect(html).toContain('mt-1 font-mono text-xs text-muted-foreground">books<');
  });

  it("gates the move buttons at the sibling edges", () => {
    // books 是 group_content 的第一个子节点：上移禁用、下移可用。
    const first = renderEditor(row());
    expect(first).toMatch(/<button[^>]*disabled=""[^>]*>\s*Move up one row/u);
    expect(first).not.toMatch(/<button[^>]*disabled=""[^>]*>\s*Move down one row/u);
    // volumes 是最后一个子节点：下移禁用、上移可用。
    const last = renderEditor(row({code: "volumes", i18nKey: "menu.item.volumes", id: "m_volumes", sort: 202}));
    expect(last).not.toMatch(/<button[^>]*disabled=""[^>]*>\s*Move up one row/u);
    expect(last).toMatch(/<button[^>]*disabled=""[^>]*>\s*Move down one row/u);
  });

  it("shows delete only on self-created rows", () => {
    expect(renderEditor(row())).not.toContain(">Delete<");
    expect(renderEditor(row({deletable: true, id: "mm_custom"}))).toContain(">Delete<");
  });

  it("shows add sub-group only on group rows (empty path)", () => {
    expect(renderEditor(row())).not.toContain("Add sub-group");
    const group = renderEditor(
      row({code: "group_content", i18nKey: "menu.item.group_content", id: "m_group_content", icon: null, parentCode: null, path: "", permissionCode: null, sort: 200}),
    );
    expect(group).toContain("Add sub-group");
  });

  it("renders the read-only path and permission code block", () => {
    const html = renderEditor(row());
    expect(html).toContain("Path (read-only)");
    expect(html).toContain("Permission code (read-only)");
    expect(html).toContain("content:book:read");
    // 分组行两项皆空，用占位符展示。
    const group = renderEditor(
      row({code: "group_content", i18nKey: "menu.item.group_content", id: "m_group_content", icon: null, parentCode: null, path: "", permissionCode: null, sort: 200}),
    );
    expect(group).toContain("—");
  });

  it("shows restore default only when a custom name exists", () => {
    expect(renderEditor(row())).not.toContain("Restore default");
    expect(renderEditor(row({nameZh: "自定义名"}))).toContain("Restore default");
  });

  it("renders the visibility checkbox following the row state", () => {
    expect(renderEditor(row())).toContain('type="checkbox"');
    expect(renderEditor(row({visible: false}))).not.toMatch(/<input[^>]*checked/u);
  });

  it("keeps the parent candidate list free of the row and its descendants", () => {
    const rows: MenuRow[] = [
      ...SAMPLE,
      row({code: "mm_custom", id: "mm_custom", parentCode: "group_content", path: "", permissionCode: null, sort: 203, deletable: true}),
      row({code: "mm_child", id: "mm_child", parentCode: "mm_custom", path: "", permissionCode: null, sort: 1, deletable: true}),
    ];
    // 编辑 mm_custom 时，候选里不能有它自己，也不能有它的后代 mm_child。
    const html = renderEditor(
      row({code: "mm_custom", id: "mm_custom", parentCode: "group_content", path: "", permissionCode: null, sort: 203, deletable: true}),
      rows,
    );
    // 父级下拉是唯一带 max-w-40 的 select；React 把 defaultValue 渲染成 option 的 selected。
    const selectStart = html.indexOf("max-w-40");
    const selectBlock = html.slice(selectStart, selectStart + 800);
    expect(selectBlock).toContain(">group_content<");
    expect(selectBlock).not.toContain(">mm_custom<");
    expect(selectBlock).not.toContain(">mm_child<");
  });
});

describe("MenuGroupCreator", () => {
  const draft: MenuGroupDraft = {
    code: "",
    icon: "list",
    nameEn: "",
    nameZh: "",
    parentCode: "",
  };

  it("renders the create form with save and cancel", () => {
    const html = renderCreator(draft);
    expect(html).toContain("New group");
    expect(html).toContain("Save");
    expect(html).toContain("Cancel");
    expect(html).toContain('placeholder="Group code (letters, digits, underscore)"');
    expect(html).toContain('placeholder="Chinese name"');
    expect(html).toContain('placeholder="English name"');
    expect(html).toContain("Top level");
  });

  it("lists every existing row as a parent candidate", () => {
    const html = renderCreator({...draft, parentCode: "group_content"});
    expect(html).toContain(">group_content<");
    expect(html).toContain(">books<");
    expect(html).toContain(">volumes<");
  });
});
