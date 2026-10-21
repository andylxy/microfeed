import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it} from "vitest";

import SidebarPreview from "@/components/admin/rbac/SidebarPreview";
import type {PermissionNodeRow} from "@/shared/PermissionTreeOps";

// 环境说明：单元测试跑在 node（无 jsdom），组件经 renderToStaticMarkup 静态渲染；
// tests/unit/i18n-setup.ts 把语言固定为英文，所以断言写 en.ts 的文案。

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

/** 内容分组挂图书、账号分组挂操作日志，设置是顶层页面（带三级注入子项）。 */
function nodes(): PermissionNodeRow[] {
  return [
    node("group_content", {
      icon: "book",
      kind: "group",
      nameEn: "Content",
      nameZh: "内容",
      sort: 100,
    }),
    node("group_account", {
      icon: "users",
      kind: "group",
      nameEn: "Account",
      nameZh: "账号",
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
      sort: 201,
    }),
    node("page_settings", {
      entryCode: "content:settings:manage",
      icon: "settings",
      kind: "page",
      nameEn: "Settings",
      nameZh: "设置",
      path: "settings",
      sort: 300,
    }),
  ];
}

function render(patch: Partial<Parameters<typeof SidebarPreview>[0]> = {}): string {
  return renderToStaticMarkup(
    React.createElement(SidebarPreview, {
      collapsed: false,
      nodes: nodes(),
      onToggle: () => undefined,
      permissions: ["*"],
      ...patch,
    }),
  );
}

/** React renders a disclosed row as `aria-expanded="true"`; collapsed rows say false. */
function expandedCount(html: string): number {
  return (html.match(/aria-expanded="true"/gu) ?? []).length;
}

describe("SidebarPreview", () => {
  it("renders the header, the entry count, and the third-level sections the sidebar injects", () => {
    const output = render();

    expect(output).toContain("Sidebar preview");
    expect(output).toContain("The entries this role can see in the admin sidebar.");
    expect(output).toContain("3 entries");
    expect(output).toContain("Content");
    expect(output).toContain("Account");
    expect(output).toContain("Settings");
    // 设置分区与真实侧栏同一份清单，预览必须画出同样的第三级子项。
    expect(output).toContain("Website appearance &amp; code");
  });

  it("renders rows as static text so the preview never navigates", () => {
    const output = render();

    expect(output).not.toContain("href=");
    expect(output).not.toContain("<a ");
  });

  it("expands every group by default and labels each toggle with its group name", () => {
    const output = render();

    // 两个分组 + 带注入子项的设置行。
    expect(expandedCount(output)).toBe(3);
    expect(output).toContain('aria-label="Expand or collapse Content"');
    expect(output).toContain('aria-label="Expand or collapse Account"');
  });

  it("drops the entries the selected role may not open, and counts the rest", () => {
    const output = render({permissions: ["content:book:read"]});

    expect(output).toContain("Books");
    expect(output).not.toContain("Audit log");
    expect(output).not.toContain("Account");
    expect(output).toContain("1 entry");
  });

  it("counts pages rather than rows when a single page survives the gate", () => {
    const output = render({permissions: ["system:role:manage"]});

    expect(output).toContain("Audit log");
    expect(output).not.toContain("Books");
    expect(output).toContain("1 entry");
  });

  it("falls back to the empty state when no entry passes the gate", () => {
    const output = render({permissions: []});

    expect(output).toContain("This role can only reach the dashboard.");
    expect(output).not.toContain("Content");
    expect(output).toContain("0 entries");
    // 真实侧栏零入口时仍画出首页行，再补一句「没有别的入口」；预览必须一致。
    expect(output).toContain("Home");
  });

  it("keeps only the header when the caller collapses the panel", () => {
    const output = render({collapsed: true});

    expect(output).toContain("Sidebar preview");
    expect(output).toContain('aria-label="Show the preview"');
    expect(output).not.toContain("Content");
    expect(output).not.toContain("3 entries");
  });

  it("offers the collapse control while the tree is open", () => {
    const output = render();

    expect(output).toContain('aria-label="Hide the preview"');
  });
});
