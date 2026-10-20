import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it} from "vitest";

import {RbacSaveStatus} from "@/components/admin/rbac/RbacSaveStatus";

function render(state: Parameters<typeof RbacSaveStatus>[0]["state"], detail?: string) {
  return renderToStaticMarkup(
    React.createElement(RbacSaveStatus, {
      detail,
      onRetry: () => {},
      state,
    }),
  );
}

describe("保存状态条", () => {
  it("idle 态不渲染任何东西（不能占掉面板顶部一行）", () => {
    expect(render("idle")).toBe("");
  });

  it("保存中：转圈提示，不发成功文案", () => {
    const output = render("saving");
    expect(output).toContain("Saving");
    expect(output).toContain("animate-spin");
    expect(output).not.toContain("Permissions updated");
  });

  it("已保存：确认文案，不显示保存中", () => {
    const output = render("saved");
    expect(output).toContain("Permissions updated");
    expect(output).not.toContain("Saving");
  });

  it("失败：给失败文案与原因，并提供重试按钮", () => {
    const output = render("error", "the row changed elsewhere");
    expect(output).toContain("Could not save permissions");
    expect(output).toContain("the row changed elsewhere");
    expect(output).toContain(">Retry</button>");
  });

  it("失败但没传原因时只显示失败文案本身", () => {
    const output = render("error");
    expect(output).toContain("Could not save permissions");
    expect(output).not.toContain("：</span>");
  });
});
