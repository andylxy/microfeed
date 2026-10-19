import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {afterEach, describe, expect, it} from "vitest";

import AdminMenuItemLink, {hasActiveDescendant} from "@/components/admin/AdminMenuItemLink";
import {bindMenuAccount, openMenuCode} from "@/client/menu-open-state";
import type {AdminMenuItem} from "@/shared/AdminNavigation";

// 环境说明：单元测试跑在 node（无 jsdom），组件经 renderToStaticMarkup 静态渲染；
// tests/unit/i18n-setup.ts 把语言固定为英文，所以 i18n 回退文案取 en.ts 的值
// （menu.item.books = "Books"，menu.group.content = "Content"）。

function leafItem(overrides: Partial<AdminMenuItem> = {}): AdminMenuItem {
  return {
    active: false,
    disabled: false,
    icon: "book",
    id: "books",
    url: "/admin/books/",
    ...overrides,
  };
}

function groupItem(children: AdminMenuItem[], overrides: Partial<AdminMenuItem> = {}): AdminMenuItem {
  return {
    active: false,
    children,
    disabled: false,
    icon: null,
    id: "group_content",
    url: "/admin/",
    ...overrides,
  };
}

/** 记账用的 localStorage 替身：window 缺失时组件会 try/catch 退回空集合。 */
function installWindow(storage: Map<string, string>): void {
  (globalThis as Record<string, unknown>).window = {
    localStorage: {
      getItem: (key: string): string | null => storage.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        storage.set(key, value);
      },
    },
  };
}

function render(item: AdminMenuItem, accountKey?: string): string {
  // 账号绑定由 AdminSidebar 在渲染前同步执行；「当前页祖先链展开」走节点行的
  // effect——静态渲染不跑 effect，这里按运行时的同一步骤手动触发，断言才指向
  // 真实行为（store 的读取则完全走真实路径）。
  // 注意：store 对同一账号只读一次存储（渲染期每次渲染都会调绑定，必须幂等），
  // 所以每个装配新 localStorage 的测试都要用不同的账号键，否则读到的是上一个
  // 测试残留的状态。
  bindMenuAccount(accountKey);
  if (hasActiveDescendant(item)) {
    openMenuCode(item.id);
  }
  return renderToStaticMarkup(
    React.createElement(AdminMenuItemLink, {item}),
  );
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
});

describe("AdminMenuItemLink 树形侧栏", () => {
  it("祖先链包含当前页时自动展开，子行渲染出来", () => {
    installWindow(new Map());
    const output = render(groupItem([leafItem({active: true})]), "active-chain");
    expect(output).toContain('aria-expanded="true"');
    expect(output).toContain('href="/admin/books/"');
    expect(output).toContain('aria-current="page"');
  });

  it("没有当前页、也没有记忆展开态时收起，子行不渲染", () => {
    installWindow(new Map());
    const output = render(groupItem([leafItem()]), "empty");
    expect(output).toContain('aria-expanded="false"');
    expect(output).not.toContain('href="/admin/books/"');
  });

  it("localStorage 里记着的行重新打开时展开", () => {
    const storage = new Map([["microfeed-admin-menu-open:u1", '["group_content"]']]);
    installWindow(storage);
    const output = render(groupItem([leafItem()]), "u1");
    expect(output).toContain('aria-expanded="true"');
    expect(output).toContain('href="/admin/books/"');
  });

  it("展开态按账号记忆：同一份存储换账号就是收起态", () => {
    const storage = new Map([
      ["microfeed-admin-menu-open:u1", '["group_content"]'],
      // 全局键（无账号的内壳）保持独立，不受账号键影响。
      ["microfeed-admin-menu-open", "[]"],
    ]);
    installWindow(storage);
    expect(render(groupItem([leafItem()]), "u1")).toContain('aria-expanded="true"');
    expect(render(groupItem([leafItem()]), "u2")).toContain('aria-expanded="false"');
    expect(render(groupItem([leafItem()]))).toContain('aria-expanded="false"');
  });

  it("带名称的行：当前语言列优先，空则回退另一列，两列全空才走 i18n", () => {
    installWindow(new Map());
    // 数据库名称优先（英文语环境下取 name_en）。
    expect(render(leafItem({label: {en: "Library", zh: "书库"}}), "labels")).toContain("Library");
    // 当前语言列为空 → 回退另一列（跨语言回退，方案 §2.3.1）。
    expect(render(leafItem({label: {en: "", zh: "书库"}}), "labels")).toContain("书库");
    // 两列全空（服务端不会给这种行挂 label）→ 回退 i18n 文案。
    expect(render(leafItem(), "labels")).toContain("Books");
    expect(render(groupItem([leafItem()]), "labels")).toContain("Content");
    // 回退后不再显示原始占位文案。
    expect(render(leafItem({label: {en: "Library", zh: "书库"}}), "labels")).not.toContain("Books");
  });

  it("有子节点的行只有展开箭头：不渲染链接、不显示子行计数（拍板 1/4）", () => {
    installWindow(new Map());
    const output = render(
      groupItem([leafItem(), leafItem({id: "volumes", url: "/admin/volumes/"})]),
      "arrow-only",
    );
    // 组行自身渲染为 button，其 url 不作为任何 href 出现。
    expect(output).toContain("<button");
    expect(output).toContain('aria-expanded="false"');
    expect(output).not.toContain('href="/admin/"');
    // 箭头行不带图标占位以外的计数徽标。
    expect(output).not.toContain("text-xs text-muted-foreground");
  });

  it("叶子行保持链接，禁用行渲染为 aria-disabled 的 span", () => {
    installWindow(new Map());
    const link = render(leafItem(), "leaf");
    expect(link).toContain("<a");
    expect(link).toContain('href="/admin/books/"');
    const disabled = render(leafItem({disabled: true}), "leaf");
    expect(disabled).toContain('aria-disabled="true"');
    expect(disabled).not.toContain("<a");
  });

  it("禁用态父行渲染为原生 disabled 按钮，不能展开（交互样式规则）", () => {
    installWindow(new Map());
    const output = render(groupItem([leafItem()], {disabled: true}), "disabled-parent");
    expect(output).toContain("<button");
    expect(output).toContain("disabled");
    expect(output).not.toContain('href="/admin/books/"');
  });

  it("node 环境（window 缺失）读取展开态不崩溃，正常渲染", () => {
    const output = render(groupItem([leafItem()]), "no-window");
    expect(output).toContain('aria-expanded="false"');
    expect(output).toContain("Content");
  });
});
