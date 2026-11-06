import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it, vi} from "vitest";

import AdminMarkdownEditor from "@/components/admin/shared/AdminMarkdownEditor";

/**
 * 预览区渲染的是作者键入的 Markdown（ADR-0035）：换成成熟预览组件后，
 * 这里锁住三件事——预览用的正是该组件、source 与编辑框同步、空内容有
 * 提示、不留空白框。渲染细节由组件自身与 remark 生态负责，不做重复断言。
 */
vi.mock("@uiw/react-markdown-preview", () => ({
  default: ({source}: {source: string}) =>
    React.createElement("div", {"data-preview-source": source}),
}));
vi.mock("remark-breaks", () => ({default: () => "remark-breaks"}));

function render(value: string, defaultPreview = false): string {
  return renderToStaticMarkup(
    React.createElement(AdminMarkdownEditor, {
      defaultPreview,
      onChange: () => {},
      value,
    }),
  );
}

describe("AdminMarkdownEditor preview", () => {
  it("does not render the preview by default", () => {
    const html = render("# 标题\n\n正文");
    expect(html).not.toContain("data-preview-source");
    expect(html).toContain("Preview");
  });

  it("renders the editor value through the markdown preview component when turned on", () => {
    const html = render("# 标题\n\n正文", true);
    expect(html).toContain('data-preview-source="# 标题\n\n正文"');
  });

  it("shows an empty-state hint instead of an empty preview box when turned on", () => {
    const html = render("   \n  ", true);
    expect(html).not.toContain("data-preview-source");
    expect(html).toContain("Nothing to preview yet.");
  });

  it("keeps the preview toggle available", () => {
    expect(render("正文")).toContain("Preview");
  });

  it("uses a switch (not a checkbox) for the preview toggle", () => {
    const html = render("正文");
    // The visible control must be a real switch, not a bare checkbox toggle.
    expect(html).toContain('role="switch"');
    expect(html).toContain('data-slot="switch"');
    // base-ui Switch renders a hidden, aria-hidden checkbox purely for form
    // semantics; assert no *visible* checkbox toggle exists (a bare <input
    // type="checkbox"> acting as the control would lack aria-hidden).
    expect(html).not.toMatch(/<input(?![^>]*aria-hidden)[^>]*type="checkbox"/);
  });

  it("constrains the editor width so grid dialogs do not stretch when preview is on", () => {
    const html = render("# 标题\n\n正文", true);
    // 只看根节点自己的 class 是否含这些约束，不锁整串（顺序/新增 class 不该弄红）。
    const rootClass = html.match(/class="(admin-markdown-editor[^"]*)"/)?.[1] ?? "";
    const rootTokens = rootClass.split(/\s+/);
    for (const token of ["w-full", "min-w-0", "max-w-full", "overflow-hidden"]) {
      expect(rootTokens).toContain(token);
    }
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("[&amp;_pre]:max-w-full");
    expect(html).toContain("[&amp;_table]:max-w-full");
  });
});
