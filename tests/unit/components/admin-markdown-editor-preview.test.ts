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
});
