import {describe, expect, it} from "vitest";

import {
  applyMarkdownAction,
  EDITOR_TOOLBAR_ACTIONS,
} from "@/client/markdownActions";

/**
 * The Markdown toolbar works by editing text, so the behaviour lives in a pure
 * function and can be tested without a DOM. Guards against the toolbar silently
 * mangling the source — which would be worse than having no toolbar at all.
 */
describe("markdown toolbar actions", () => {
  it("wraps a selection for inline formats", () => {
    expect(applyMarkdownAction("正文", 0, 2, "bold")).toEqual({
      value: "**正文**",
      selectionStart: 2,
      selectionEnd: 4,
    });
    expect(applyMarkdownAction("正文", 0, 2, "code").value).toBe("`正文`");
  });

  it("uses a placeholder when nothing is selected, and selects it", () => {
    const result = applyMarkdownAction("", 0, 0, "bold");
    expect(result.value).toBe("**粗体**");
    expect(result.value.slice(result.selectionStart, result.selectionEnd)).toBe("粗体");
  });

  it("preserves the text around the edit", () => {
    const source = "前言 正文 后语";
    const result = applyMarkdownAction(source, 3, 5, "italic");
    expect(result.value).toBe("前言 *正文* 后语");
  });

  it("prefixes whole lines for block formats", () => {
    // The caret sits mid-line: the prefix still belongs at the start of the line.
    const result = applyMarkdownAction("第一章", 2, 2, "header-2");
    expect(result.value).toBe("## 第一章");
  });

  it("toggles a block prefix off when it is already applied", () => {
    const on = applyMarkdownAction("第一章", 0, 3, "blockquote");
    expect(on.value).toBe("> 第一章");
    const off = applyMarkdownAction(on.value, 0, 5, "blockquote");
    expect(off.value).toBe("第一章");
  });

  it("builds a fenced code block on its own lines", () => {
    const result = applyMarkdownAction("代码", 0, 2, "code-block");
    expect(result.value).toBe("```\n代码\n```");
  });

  it("builds a link with a url placeholder", () => {
    expect(applyMarkdownAction("点我", 0, 2, "link").value)
      .toBe("[点我](https://)");
  });

  it("every toolbar action has a label key", () => {
    for (const {action, labelKey} of EDITOR_TOOLBAR_ACTIONS) {
      expect(labelKey.startsWith("richEditor.")).toBe(true);
      expect(action.length).toBeGreaterThan(0);
    }
  });
});
