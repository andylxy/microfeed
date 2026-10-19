import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it} from "vitest";

import EditorFormatToolbar from "@/components/admin/shared/EditorFormatToolbar";
import {EDITOR_TOOLBAR_ACTIONS} from "@/client/markdownActions";

/**
 * The Markdown editor has no built-in toolbar, so this component is the only way
 * to format text there. Locks the buttons actually rendered — a missing or
 * mislabelled action is invisible until someone tries to use it and finds no
 * button.
 */
function renderToolbar(): string {
  return renderToStaticMarkup(
    React.createElement(EditorFormatToolbar, {onAction: () => {}}),
  ).replaceAll("<!-- -->", "");
}

describe("EditorFormatToolbar", () => {
  it("renders one control per shared action", () => {
    // 动作 id 是内部的；必须成立的是每个共享动作恰好产出一个控件
    // （按钮，或标题下拉 <select>）。
    const html = renderToolbar();
    const controls =
      (html.match(/<button\b/gu)?.length ?? 0) +
      (html.match(/<select\b/gu)?.length ?? 0);
    expect(controls).toBe(EDITOR_TOOLBAR_ACTIONS.length);
  });

  it("labels each control so the toolbar is not a row of blank boxes", () => {
    const html = renderToolbar();
    // 标签来自共享的 richEditor.* 字符串，键名打错就会留下空白按钮。
    // 可见文本与 aria-label 都要断言。
    expect(html).toContain("Bold");
    expect(html).toContain("Italic");
    expect(html).toContain("Strikethrough");
    expect(html).toContain("Table");
    expect(html).toContain("Horizontal rule");
    expect(html).toContain("Insert image");
    expect(html).toContain("Auto link");
    // 标题下拉：自身标签加每一级选项。
    expect(html).toContain("Heading");
    expect(html).toContain("Heading 1");
    expect(html).toContain("Heading 6");
    const ariaLabels = html.match(/aria-label="[^"]+"/gu) ?? [];
    expect(ariaLabels.length).toBe(EDITOR_TOOLBAR_ACTIONS.length);
    for (const label of ariaLabels) {
      expect(label).not.toContain("richEditor.");
    }
  });

  it("is a toolbar for assistive technology", () => {
    expect(renderToolbar()).toContain('role="toolbar"');
  });
});
