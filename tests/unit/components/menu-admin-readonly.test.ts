import {readFile} from "node:fs/promises";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it} from "vitest";

import {MenuReadOnlyNotice} from "@/components/admin/menu/MenuAdminApp";

const SOURCE = new URL(
  "../../../src/components/admin/menu/MenuAdminApp.tsx",
  import.meta.url,
);

describe("menu management page (read-only for one version)", () => {
  it("tells the operator where menu entries are maintained now", () => {
    const output = renderToStaticMarkup(React.createElement(MenuReadOnlyNotice));

    expect(output).toContain("This page is read-only");
    expect(output).toContain("Menu entries now live in the permission tree.");
    expect(output).toContain('href="/admin/rbac/"');
    expect(output).toContain("Open Role management");
  });

  it("keeps every write behind one switch, and greys the controls out", async () => {
    const source = await readFile(SOURCE, "utf8");

    expect(source).toContain("const READ_ONLY: boolean = true;");
    // 前端单一收口：所有 op 都经 postOps，守卫必须放在那一处。
    expect(source).toContain("if (READ_ONLY) return false;");
    // 拖拽是唯一不经 postOps 的写入口。
    expect(source).toContain("if (READ_ONLY || event.button !== 0");
    // 控件置灰，否则「点了没反应」读起来像坏掉了。
    expect(source).toContain("disabled={busy || READ_ONLY}");
    expect(source).toContain("busy={busy || READ_ONLY}");
  });

  it("closes the write on the server too, not only in the browser", async () => {
    const handler = await readFile(
      new URL("../../../src/server/admin/menu-admin-handlers.ts", import.meta.url),
      "utf8",
    );

    expect(handler).toContain('localizedError(request, "errors.menu.readOnly", 409)');
    // 写入计划器不再被端点调用：侧栏改读节点后，写进 ext_menu 已无任何渲染效果。
    expect(handler).not.toContain("planMenuOps");
  });
});
