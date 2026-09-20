import {describe, expect, it} from "vitest";

import {renderMarkdown} from "@/client/markdown";

/**
 * The Markdown editor is only worth having if what it saves renders correctly on
 * the reader page. The reader consumes `data.description`, so `renderMarkdown`
 * has to produce the same kind of HTML the visual and HTML-source editors do:
 * block tags around paragraphs, no raw Markdown left behind, no wrapper
 * artefacts.
 */
describe("renderMarkdown", () => {
  it("turns headings, emphasis and lists into plain HTML", () => {
    const html = renderMarkdown(
      "# 第一章\n\n正文 **粗体** 与 *斜体*。\n\n- 一条\n- 两条",
    );
    expect(html).toContain("<h1>第一章</h1>");
    expect(html).toContain("<strong>粗体</strong>");
    expect(html).toContain("<em>斜体</em>");
    expect(html).toContain("<li>一条</li>");
    // No Markdown syntax can survive into the reader.
    expect(html).not.toContain("**");
    expect(html).not.toContain("\n- ");
  });

  it("keeps single newlines inside a paragraph, the way prose is written", () => {
    // Chapter bodies are typed with single line breaks; without `breaks: true`
    // they would collapse into one paragraph and lose every line break.
    const html = renderMarkdown("第一行\n第二行");
    expect(html).toContain("第一行");
    expect(html).toContain("第二行");
    expect(html).toMatch(/<br>/u);
  });

  it("wraps prose in block tags so the reader theme can style it", () => {
    const html = renderMarkdown("一段普通正文。");
    expect(html.trim()).toMatch(/^<p>/u);
  });

  it("renders an empty or whitespace body as an empty string", () => {
    // An empty body must not save "<p></p>" and show a stray blank paragraph.
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown("   \n  ")).toBe("");
  });

  it("round-trips through the same field the other editors use", () => {
    // Guards the actual design: Markdown -> HTML lands in `description`, so the
    // public feed, reader theme, search index and feeds need no changes at all.
    const html = renderMarkdown("## 小节\n\n内容");
    expect(html).toContain("<h2>小节</h2>");
    expect(html).toContain("<p>内容</p>");
  });
});
