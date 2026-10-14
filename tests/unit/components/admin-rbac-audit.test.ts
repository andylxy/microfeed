import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it} from "vitest";

import RbacAuditApp from "@/components/admin/rbac/RbacAuditApp";
import type {RbacAuditRow} from "@/shared/RbacAudit";

/**
 * The RBAC audit board must show what a change actually did, not the raw
 * `before → after` code lists the trail stores. These assertions lock in the
 * two things the board promises: only the moved grants survive, and codes are
 * resolved to 中文名. `tests/unit/i18n-setup.ts` pins the language to English,
 * so the chrome (action labels) is English while the injected permission/role
 * names stay Chinese — which is exactly the split the page relies on.
 */

const PERMISSION_NAMES = {
  "content:book:delete": "删除书",
  "content:book:read": "查看书",
  "content:book:update": "修改书",
};
const ROLE_NAMES = {editor: "编辑", readonly: "只读"};

function auditRow(overrides: Partial<RbacAuditRow> = {}): RbacAuditRow {
  return {
    action: "role.permissions",
    actorLabel: "admin@example.com",
    beforeDetail: null,
    createdAtMs: Date.UTC(2026, 9, 14, 3, 29, 42),
    detail: null,
    id: "audit-1",
    target: "editor",
    ...overrides,
  };
}

function render(rows: RbacAuditRow[]): string {
  return renderToStaticMarkup(
    React.createElement(RbacAuditApp, {
      permissionNames: PERMISSION_NAMES,
      roleNames: ROLE_NAMES,
      rows,
    }),
  );
}

describe("admin RBAC audit board", () => {
  it("shows only the grants that moved, resolved to 中文名", () => {
    const html = render([
      auditRow({
        beforeDetail: "content:book:read,content:book:update",
        detail: "content:book:update,content:book:delete",
      }),
    ]);

    expect(html).toContain("＋删除书");
    expect(html).toContain("－查看书");
    // The grant that did not move is not repeated.
    expect(html).not.toContain("修改书");
  });

  it("formats the time as YYYY-MM-DD HH:mm:ss", () => {
    expect(render([auditRow()])).toContain("2026-10-14 03:29:42");
  });

  it("labels the action and resolves a role target to its name", () => {
    const html = render([auditRow()]);
    expect(html).toContain("Edit role permissions");
    expect(html).toContain(">编辑<");
  });

  it("says no change when a grant edit moved nothing", () => {
    const html = render([
      auditRow({
        beforeDetail: "content:book:read",
        detail: "content:book:read",
      }),
    ]);
    expect(html).toContain("No change");
  });

  it("diffs role assignments against role names", () => {
    const html = render([
      auditRow({
        action: "user.roles",
        beforeDetail: "readonly",
        detail: "readonly,editor",
        target: "user-1",
      }),
    ]);

    expect(html).toContain("＋编辑");
    expect(html).not.toContain("只读");
  });

  it("renders a role code change as old → new", () => {
    const html = render([
      auditRow({action: "role.renameCode", detail: "author", target: "writer"}),
    ]);
    expect(html).toContain("writer → author");
  });

  it("translates the profile fields that changed", () => {
    const html = render([
      auditRow({action: "user.profile", detail: "name,email", target: "user-1"}),
    ]);
    expect(html).toContain("Name");
    expect(html).toContain("Email");
  });

  it("paginates the window at the configured page size", () => {
    const rows = ["a@example.com", "b@example.com", "c@example.com"].map(
      (actorLabel, index) => auditRow({actorLabel, id: `audit-${index}`}),
    );
    const html = renderToStaticMarkup(
      React.createElement(RbacAuditApp, {
        itemsPerPage: 2,
        permissionNames: PERMISSION_NAMES,
        roleNames: ROLE_NAMES,
        rows,
      }),
    );

    expect(html).toContain("a@example.com");
    expect(html).toContain("b@example.com");
    // Page one holds two of the three rows.
    expect(html).not.toContain("c@example.com");
  });
});
