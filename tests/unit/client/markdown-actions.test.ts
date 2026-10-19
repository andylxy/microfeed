import {describe, expect, it} from "vitest";

import {
  applyMarkdownAction,
  EDITOR_TOOLBAR_ACTIONS,
} from "@/client/markdownActions";

/**
 * Markdown 工具栏靠编辑文本生效，故行为住在纯函数里，无需 DOM 即可测试。
 * 防止工具栏悄悄弄坏源码——那比没有工具栏更糟。
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
    // 光标在行中：前缀仍属于行首。
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

  it("wraps a selection with strikethrough", () => {
    expect(applyMarkdownAction("文字", 0, 2, "strikethrough").value)
      .toBe("~~文字~~");
  });

  it("inserts a horizontal rule on its own line", () => {
    const result = applyMarkdownAction("前文", 2, 2, "horizontal-rule");
    // 规则前必须是空行："前文\n---" 在阅读页会被解析成 setext 二级标题，
    // <hr> 会丢失。
    expect(result.value).toBe("前文\n\n---");
    // 光标停在规则之后，作者接着在下一行写。
    expect(result.value.slice(result.selectionStart, result.selectionEnd))
      .toBe("---");
  });

  it("separates an inserted block from text on both sides", () => {
    // 选区被块替换，且两侧都保留空行分隔，表格才能渲染，不会与正文粘连。
    const result = applyMarkdownAction("前中后", 1, 2, "table");
    expect(result.value).toBe("前\n\n| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| 内容 |  |  |\n\n后");
    expect(result.value.slice(result.selectionStart, result.selectionEnd))
      .toBe("内容");
  });

  it("inserts a GFM table template and selects the first data cell", () => {
    const result = applyMarkdownAction("", 0, 0, "table");
    expect(result.value).toContain("| 列1 | 列2 | 列3 |");
    expect(result.value).toContain("| --- | --- | --- |");
    expect(result.value).toContain("| 内容 |  |  |");
    expect(result.value.slice(result.selectionStart, result.selectionEnd))
      .toBe("内容");
  });

  it("prefixes task list items and toggles them off", () => {
    const on = applyMarkdownAction("买菜", 0, 2, "task-list");
    expect(on.value).toBe("- [ ] 买菜");
    const off = applyMarkdownAction(on.value, 0, 8, "task-list");
    expect(off.value).toBe("买菜");
  });

  it("every toolbar action has a label key", () => {
    for (const item of EDITOR_TOOLBAR_ACTIONS) {
      if ('heading' in item) {
        expect(item.labelKey.startsWith("richEditor.")).toBe(true);
        for (const opt of item.options) {
          expect(opt.labelKey.startsWith("richEditor.")).toBe(true);
        }
      } else {
        expect(item.labelKey.startsWith("richEditor.")).toBe(true);
        expect(item.action.length).toBeGreaterThan(0);
      }
    }
  });

  it("prefixes every heading level H1–H6", () => {
    expect(applyMarkdownAction("章", 0, 1, "header-1").value).toBe("# 章");
    expect(applyMarkdownAction("章", 0, 1, "header-4").value).toBe("#### 章");
    expect(applyMarkdownAction("章", 0, 1, "header-6").value).toBe("###### 章");
  });

  it("sets the heading level instead of stacking prefixes", () => {
    // 下拉是选级别：行首已有的标题前缀被替换，"## 小节" 选 H1 得
    // "# 小节"，不会出现 "# ## 小节"。
    expect(applyMarkdownAction("## 小节", 3, 3, "header-1").value)
      .toBe("# 小节");
    expect(applyMarkdownAction("### 小节", 4, 4, "header-2").value)
      .toBe("## 小节");
    // 选已应用的级别是幂等，再次点击不会取消标题。
    expect(applyMarkdownAction("# 小节", 3, 3, "header-1").value)
      .toBe("# 小节");
  });

  it("wraps a selection as an image with an alt and url placeholder", () => {
    expect(applyMarkdownAction("图注", 0, 2, "image").value)
      .toBe("![图注](https://)");
  });

  it("wraps a URL selection as an angle-bracket autolink", () => {
    expect(applyMarkdownAction("https://x.com", 0, 13, "autolink").value)
      .toBe("<https://x.com>");
    // 无选区时尖括号内是 url 占位符。
    expect(applyMarkdownAction("", 0, 0, "autolink").value)
      .toBe("<https://>");
  });

  it("prefixes a scheme before wrapping a www selection", () => {
    // 尖括号 autolink 不认无 scheme 的 www.：直接包会渲染出畸形 HTML
    // （尖括号残留、> 被吞进 href），故补 http:// 再包。
    expect(applyMarkdownAction("www.x.com", 0, 10, "autolink").value)
      .toBe("<http://www.x.com>");
  });

  it("falls back to the link form when the autolink selection is not a url", () => {
    // "<点我>" 会渲染成字面文本；普通链接形式才能把它变成链接。
    expect(applyMarkdownAction("点我", 0, 2, "autolink").value)
      .toBe("[点我](https://)");
  });
});
