import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it, vi} from "vitest";

import i18n from "@/client/i18n";
import {AdminTreeSearchInput} from "@/components/admin/shared/AdminTreeSearchInput";

// 环境说明：单元测试跑在 node（无 jsdom），组件经 renderToStaticMarkup 静态渲染；
// tests/unit/i18n-setup.ts 固定语言为英文。清空按钮的无障碍名走 i18n，故断言从
// 同一个单例取实际译文，不硬编码语言。静态渲染不派发点击，这里只验「有值才渲染
// 清空按钮」与受控属性透传；回调触发留给页面层（组件完全受控）。

function render(value: string) {
  return renderToStaticMarkup(
    React.createElement(AdminTreeSearchInput, {
      ariaLabel: "Search chapters",
      onValueChange: vi.fn(),
      placeholder: "Search categories, books, chapters…",
      value,
    }),
  );
}

describe("AdminTreeSearchInput", () => {
  it("renders a labelled, controlled input with the given value", () => {
    const html = render("伤寒");
    expect(html).toContain('aria-label="Search chapters"');
    expect(html).toContain('placeholder="Search categories, books, chapters…"');
    expect(html).toContain('value="伤寒"');
  });

  it("shows the clear button only when the value is non-empty", () => {
    const clearLabel = `aria-label="${i18n.t("common.clearSearch")}"`;
    expect(render("伤寒")).toContain(clearLabel);
    expect(render("")).not.toContain(clearLabel);
  });

  it("keeps the clear button as a non-submitting ghost button", () => {
    const html = render("x");
    expect(html).toContain('type="button"');
    expect(html).toContain("hover:text-destructive");
  });
});
