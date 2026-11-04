import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it, vi} from "vitest";

import {AdminGroupTree} from "@/components/admin/shared/AdminGroupTree";
import type {AdminTreeGroup} from "@/components/admin/shared/AdminGroupTree";

// 环境说明：单元测试跑在 node（无 jsdom），组件经 renderToStaticMarkup 静态渲染；
// tests/unit/i18n-setup.ts 固定语言为英文。回调只验签名不被误触发——静态渲染
// 不会派发点击，交互态留给页面层（ADR-0063：组件完全受控）。

const leaf = (id: string, label: string, description?: string) => ({
  id,
  label,
  ...(description ? {description} : {}),
});

function render(groups: AdminTreeGroup[], options?: {
  expandedKeys?: readonly string[];
  emptyLeafText?: string;
  emptyTreeText?: string;
  selectedLeafId?: string | null;
}) {
  return renderToStaticMarkup(
    React.createElement(AdminGroupTree, {
      emptyLeafText: options?.emptyLeafText,
      emptyTreeText: options?.emptyTreeText,
      expandedKeys: options?.expandedKeys ?? [],
      groups,
      onSelectLeaf: vi.fn(),
      onToggleGroup: vi.fn(),
      root: {count: 445, label: "Book chapters"},
      selectedLeafId: options?.selectedLeafId ?? null,
    }),
  );
}

describe("AdminGroupTree — two-level compatibility", () => {
  const twoLevel: AdminTreeGroup[] = [
    {
      count: 2,
      key: "shanghan",
      label: "Shanghan",
      leaves: [leaf("c1", "Chapter one"), leaf("c2", "Chapter two", "No. 2 · 0")],
    },
  ];

  it("keeps the original two-level shape when subgroups is absent", () => {
    const output = render(twoLevel, {expandedKeys: ["shanghan"]});
    expect(output).toContain("Book chapters");
    expect(output).toContain("Shanghan");
    expect(output).toContain("Chapter one");
    expect(output).toContain("Chapter two");
    expect(output).toContain("No. 2 · 0");
    // 叶子行仍用两栏类名；未给 selectedLeafId 时不应有选中态
    expect(output).toContain("w-full rounded-[10px] px-3 py-2 text-left text-sm");
    expect(output).not.toContain('aria-current="true"');
  });

  it("renders the group row and badge but no leaves while collapsed", () => {
    const output = render(twoLevel, {expandedKeys: []});
    expect(output).toContain("Shanghan");
    expect(output).not.toContain("Chapter one");
  });

  it("falls back to emptyLeafText for an expanded empty group", () => {
    const output = render(
      [{count: 0, key: "empty", label: "Empty group", leaves: []}],
      {expandedKeys: ["empty"], emptyLeafText: "No members yet."},
    );
    expect(output).toContain("No members yet.");
  });

  it("replaces the whole list with emptyTreeText when no group has leaves", () => {
    const output = render(
      [{count: 0, key: "empty", label: "Empty group", leaves: []}],
      {emptyTreeText: "No matching chapters"},
    );
    expect(output).toContain("No matching chapters");
    expect(output).toContain("Book chapters"); // 根行永远可见
    expect(output).not.toContain("Empty group");
  });
});

describe("AdminGroupTree — three-level tree (ADR-0063)", () => {
  const threeLevel: AdminTreeGroup[] = [
    {
      count: 3,
      emptyText: "This category has no books yet.",
      key: "cat:neijing",
      label: "Neijing",
      leaves: [],
      subgroups: [
        {
          count: 2,
          key: "book:bookA",
          label: "Huangdi Neijing Suwen",
          leaves: [leaf("c1", "Chapter one"), leaf("c2", "Chapter two")],
        },
        {
          count: 1,
          key: "book:bookB",
          label: "Nanjing",
          leaves: [leaf("c3", "Chapter three")],
        },
      ],
    },
  ];

  it("does not treat a group with empty leaves but populated subgroups as an empty tree", () => {
    const output = render(threeLevel, {
      emptyTreeText: "No matching chapters",
      expandedKeys: ["cat:neijing"],
    });
    expect(output).not.toContain("No matching chapters");
    expect(output).toContain("Neijing");
    expect(output).toContain("Huangdi Neijing Suwen");
    expect(output).toContain("Nanjing");
  });

  it("only reveals third-level leaves when both the category and the book are expanded", () => {
    const categoryOnly = render(threeLevel, {expandedKeys: ["cat:neijing"]});
    expect(categoryOnly).toContain("Huangdi Neijing Suwen");
    expect(categoryOnly).not.toContain("Chapter one");

    const both = render(threeLevel, {
      expandedKeys: ["cat:neijing", "book:bookA"],
    });
    expect(both).toContain("Chapter one");
    expect(both).toContain("Chapter two");
    expect(both).not.toContain("Chapter three");
  });

  it("uses the node's own emptyText for the category layer", () => {
    const output = render(
      [{...threeLevel[0]!, subgroups: []}],
      {emptyLeafText: "This book has no chapters yet.", expandedKeys: ["cat:neijing"]},
    );
    expect(output).toContain("This category has no books yet.");
    expect(output).not.toContain("This book has no chapters yet.");
  });

  it("falls back to emptyLeafText for a book with no chapters", () => {
    const output = render(
      [{
        ...threeLevel[0]!,
        subgroups: [{count: 0, key: "book:empty", label: "Empty book", leaves: []}],
      }],
      {emptyLeafText: "This book has no chapters yet.", expandedKeys: ["cat:neijing", "book:empty"]},
    );
    expect(output).toContain("This book has no chapters yet.");
  });

  it("marks the selected third-level leaf with aria-current", () => {
    const output = render(threeLevel, {
      expandedKeys: ["cat:neijing", "book:bookA"],
      selectedLeafId: "c2",
    });
    expect(output).toContain('aria-current="true"');
    expect(output).toContain("bg-muted font-medium text-foreground");
  });

  it("keeps two-level and three-level groups side by side in one tree", () => {
    const output = render(
      [...threeLevel, {count: 1, key: "flat", label: "Flat group", leaves: [leaf("c9", "Flat leaf")]}],
      {expandedKeys: ["cat:neijing", "book:bookA", "flat"]},
    );
    expect(output).toContain("Chapter one");
    expect(output).toContain("Flat leaf");
  });
});
