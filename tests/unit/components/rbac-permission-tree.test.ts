import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it} from "vitest";

import RbacApp from "@/components/admin/rbac/RbacApp";

const GROUPS = [
  {
    code: "group_content",
    pages: [{
      code: "books",
      codes: ["content:book:read", "content:book:update"],
    }],
  },
];

const PERMISSIONS = [
  {code: "*", name: "Everything"},
  {code: "content:book:read", name: "Read books"},
  {code: "content:book:update", name: "Update books"},
];

function render(roleCode: string, grants: string[]): string {
  return renderToStaticMarkup(
    React.createElement(RbacApp, {
      initialBoard: {
        groups: GROUPS,
        permissions: PERMISSIONS,
        roles: [{code: roleCode, name: roleCode, permissions: grants}],
      },
    }),
  );
}

/** React renders a ticked checkbox as `checked=""` and omits it otherwise. */
function checkedCount(html: string): number {
  return (html.match(/checked=""/gu) ?? []).length;
}

describe("RbacApp permission tree", () => {
  it("renders the 权限管理 root, its menu grouping, page and codes", () => {
    const output = render("editor", []);
    expect(output).toContain("Permissions");
    expect(output).toContain("Content");
    expect(output).toContain("Books");
    expect(output).toContain("content:book:read");
    expect(output).toContain("content:book:update");
  });

  it("gives every branch a collapse control, expanded by default", () => {
    // Root + group + page: three arrows, all open (M10: 默认全部展开).
    const output = render("editor", []);
    expect(output.match(/aria-expanded="true"/gu) ?? []).toHaveLength(3);
    expect(output).not.toContain('aria-expanded="false"');
  });

  it("never renders the wildcard as a tickable code", () => {
    // The catalogue holds `*` but the tree must not offer it: ticking it on an
    // ordinary role is an escalation path to super administrator.
    expect(render("editor", [])).not.toContain(">Everything<");
  });

  it("checks only the codes the role actually holds", () => {
    // One leaf granted out of two: the root, group and page branches stay
    // unticked (they are partially granted), so exactly one checkbox is checked.
    expect(checkedCount(render("editor", ["content:book:read"]))).toBe(1);
    expect(checkedCount(render("editor", []))).toBe(0);
  });

  it("shows a wildcard holder as fully selected and read-only", () => {
    // M6: 整树选中且只读. The role is granted `*`, which the tree does not
    // render, so it must surface as "everything selected" rather than an empty
    // tree: root + group + page + two leaves = five checked, all disabled.
    const output = render("super_admin", ["*"]);
    expect(checkedCount(output)).toBe(5);
    expect(output).toContain("disabled");
  });
});
