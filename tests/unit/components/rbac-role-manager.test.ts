import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it} from "vitest";

import {RoleManagerPanels} from "@/components/admin/rbac/RoleManagerDialog";
import type {RbacBoardRole} from "@/shared/Rbac";

/** 角色工厂：只写测试关心的字段。 */
function role(
  code: string,
  name: string,
  permissions: string[] = [],
  allowAdminLogin = true,
): RbacBoardRole {
  return {allowAdminLogin, code, name, permissions};
}

function renderPanels(roles: RbacBoardRole[], selectedCode: string): string {
  return renderToStaticMarkup(
    React.createElement(RoleManagerPanels, {
      countOf: (code: string) =>
        roles.find((entry) => entry.code === code)?.permissions.length ?? 0,
      onAdminLogin: async () => true,
      onCreate: async () => true,
      onDelete: async () => true,
      onSelect: () => {},
      onUpdate: async () => true,
      roles,
      saving: false,
      selectedCode,
    }),
  );
}

/** 静态标记里找「某个文案的按钮是否带 disabled」。按钮的 class 里有 `disabled:` 变体，
 *  所以只认 React 给布尔属性输出的空值形态。 */
function buttonDisabled(html: string, label: string): boolean {
  return new RegExp(`<button[^>]*\\sdisabled=""[^>]*>${label}</button>`, "u").test(html);
}

/** 「登录后台」那颗开关是否为禁用态（base-ui 渲染成 `role="switch"` 的 span）。 */
function switchDisabled(html: string): boolean {
  const tag = html.match(/<span[^>]*role="switch"[^>]*>/u)?.[0] ?? "";
  return tag.includes('aria-disabled="true"');
}

describe("角色管理弹窗", () => {
  it("左列按角色目录出名单，行内是名称 + 代码 + 授权数", () => {
    const output = renderPanels(
      [role("editor", "Editor", ["content:book:read", "content:book:update"]), role("auditor", "Auditor")],
      "editor",
    );
    expect(output).toContain("Editor");
    expect(output).toContain("editor · 2 codes");
    expect(output).toContain("Auditor");
    expect(output).toContain("auditor · 0 codes");
  });

  it("右栏给显示名称与角色代码各一个编辑入口", () => {
    const output = renderPanels([role("editor", "Editor")], "editor");
    expect(output).toContain("Edit name");
    expect(output).toContain("Edit code");
  });

  it("通配角色：给出通配说明，删除按钮不可点", () => {
    const output = renderPanels([role("super_admin", "Super admin")], "super_admin");
    expect(output).toContain("holds the * wildcard");
    expect(buttonDisabled(output, "Delete role")).toBe(true);
  });

  it("代码被依赖的角色：说明只改名称，改代码与删除都不可点", () => {
    const output = renderPanels([role("readonly", "Read only")], "readonly");
    expect(output).toContain("only its display name can change");
    expect(buttonDisabled(output, "Edit code")).toBe(true);
    expect(buttonDisabled(output, "Delete role")).toBe(true);
  });

  it("普通角色：给出维护说明，删除与改代码都可点", () => {
    const output = renderPanels([role("editor", "Editor")], "editor");
    expect(output).toContain("A role is a container for permissions");
    expect(buttonDisabled(output, "Edit code")).toBe(false);
    expect(buttonDisabled(output, "Delete role")).toBe(false);
  });

  it("空目录给出提示，左列仍留新建入口", () => {
    const output = renderPanels([], "");
    expect(output).toContain("No roles have been seeded yet.");
    expect(output).toContain("New role");
  });

  it("右栏给出「登录后台」开关，默认允许", () => {
    const output = renderPanels([role("editor", "Editor")], "editor");
    expect(output).toContain("Admin sign-in");
    expect(output).toContain("Allowed");
    expect(switchDisabled(output)).toBe(false);
  });

  it("关掉登录后台的角色显示「不允许」", () => {
    const output = renderPanels(
      [role("app_user", "App user", [], false)],
      "app_user",
    );
    expect(output).toContain("Not allowed");
  });

  it("通配角色的登录开关固定为允许，并说明原因", () => {
    const output = renderPanels([role("super_admin", "Super admin")], "super_admin");
    expect(output).toContain("Super admin must keep admin sign-in on.");
    expect(switchDisabled(output)).toBe(true);
  });
});
