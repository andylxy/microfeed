import {describe, expect, it} from "vitest";

import {htmlToMarkdown} from "@/shared/HtmlToMarkdown";
import {renderMarkdown} from "@/shared/BodyFormat";

/**
 * HTML → Markdown is a one-way door for a chapter, so the mapping is pinned here
 * rather than discovered in production. Each case states what an author's HTML
 * turns into, and the last group proves the result is still readable as Markdown.
 */
describe("htmlToMarkdown", () => {
  it("separates paragraphs with a blank line", () => {
    expect(htmlToMarkdown("<p>第一段</p><p>第二段</p>"))
      .toBe("第一段\n\n第二段");
  });

  it("maps headings to hashes", () => {
    expect(htmlToMarkdown("<h2>标题</h2><h3>小标题</h3>"))
      .toBe("## 标题\n\n### 小标题");
  });

  it("maps emphasis", () => {
    expect(htmlToMarkdown("<p><strong>粗</strong>和<em>斜</em></p>"))
      .toBe("**粗**和*斜*");
    expect(htmlToMarkdown("<p><s>删</s></p>")).toBe("~~删~~");
  });

  it("maps inline code without escaping what is inside", () => {
    expect(htmlToMarkdown("<p>用 <code>a * b</code> 计算</p>"))
      .toBe("用 `a * b` 计算");
  });

  it("fences code blocks verbatim", () => {
    expect(htmlToMarkdown("<pre><code>a * b\nc_d</code></pre>"))
      .toBe("```\na * b\nc_d\n```");
  });

  it("quotes a blockquote as one unit", () => {
    expect(htmlToMarkdown("<blockquote><p>引用一</p><p>引用二</p></blockquote>"))
      .toBe("> 引用一\n>\n> 引用二");
  });

  it("keeps list items on consecutive lines", () => {
    // A blank line between items would end the list and turn it into paragraphs.
    expect(htmlToMarkdown("<ul><li>甲</li><li>乙</li></ul>")).toBe("- 甲\n- 乙");
    expect(htmlToMarkdown("<ol><li>甲</li><li>乙</li></ol>"))
      .toBe("1. 甲\n1. 乙");
  });

  it("indents a nested list under its parent item", () => {
    expect(
      htmlToMarkdown("<ul><li>甲<ul><li>甲一</li></ul></li><li>乙</li></ul>"),
    ).toBe("- 甲\n  - 甲一\n- 乙");
  });

  it("maps links and images", () => {
    expect(htmlToMarkdown('<p><a href="https://e.com/a">点这里</a></p>'))
      .toBe("[点这里](https://e.com/a)");
    expect(htmlToMarkdown('<p><img src="/m/a.png" alt="图"></p>'))
      .toBe("![图](/m/a.png)");
  });

  it("keeps a line break inside a paragraph", () => {
    expect(htmlToMarkdown("<p>上行<br>下行</p>")).toBe("上行\n下行");
  });

  it("maps a horizontal rule", () => {
    expect(htmlToMarkdown("<p>上</p><hr><p>下</p>")).toBe("上\n\n---\n\n下");
  });

  it("decodes entities", () => {
    expect(htmlToMarkdown("<p>a &amp; b &lt; c</p>")).toBe("a & b < c");
  });

  it("escapes characters that would turn into Markdown syntax", () => {
    // Without this, `2 * 3` comes back italicised and `a_b` loses the underscore.
    expect(htmlToMarkdown("<p>2 * 3</p>")).toBe("2 \\* 3");
    expect(htmlToMarkdown("<p>a_b_c</p>")).toBe("a\\_b\\_c");
    expect(htmlToMarkdown("<p># 不是标题</p>")).toBe("\\# 不是标题");
  });

  it("passes through what Markdown cannot express", () => {
    expect(htmlToMarkdown("<p><u>下划线</u></p>")).toBe("<u>下划线</u>");
    expect(htmlToMarkdown("<p>x<sup>2</sup></p>")).toBe("x<sup>2</sup>");
    expect(htmlToMarkdown('<p><video src="/m/a.mp4" controls></video></p>'))
      .toContain('<video src="/m/a.mp4" controls></video>');
  });

  it("drops styling it cannot express but keeps the text", () => {
    expect(
      htmlToMarkdown('<p><span style="color:#f00">红字</span></p>'),
    ).toBe("红字");
    expect(htmlToMarkdown('<p class="ql-align-center">居中</p>')).toBe("居中");
  });

  it("ignores script and style content", () => {
    expect(htmlToMarkdown("<p>正文</p><script>alert(1)</script>"))
      .toBe("正文");
  });

  it("returns an empty string for an empty body", () => {
    expect(htmlToMarkdown("")).toBe("");
    expect(htmlToMarkdown("   ")).toBe("");
    expect(htmlToMarkdown(null)).toBe("");
  });

  describe("the result is still readable as Markdown", () => {
    const chapter = [
      "<h2>第一章</h2>",
      "<p>他抬头看天，<strong>星光</strong>很冷。</p>",
      "<blockquote><p>“你来了。”</p></blockquote>",
      "<ul><li>剑</li><li>灯</li></ul>",
      "<p><a href=\"https://e.com\">出处</a></p>",
    ].join("");

    it("renders back to the same text", () => {
      const markdown = htmlToMarkdown(chapter);
      const rendered = renderMarkdown(markdown);
      for (const text of ["第一章", "星光", "你来了", "剑", "灯", "出处"]) {
        expect(rendered).toContain(text);
      }
    });

    it("keeps the block structure it was given", () => {
      const rendered = renderMarkdown(htmlToMarkdown(chapter));
      expect(rendered).toContain("<h2>");
      expect(rendered).toContain("<strong>");
      expect(rendered).toContain("<blockquote>");
      expect(rendered).toContain("<li>");
      expect(rendered).toContain("<a href=\"https://e.com\">");
    });
  });
});
