import {describe, expect, it} from "vitest";

import {applyMarkdownAction} from "@/client/markdownActions";
import {renderMarkdown} from "@/shared/BodyFormat";

/**
 * 工具栏插入的语法，必须在文本真正显示的地方渲染正确：阅读页正文经的正是
 * 这个 renderMarkdown（BodyFormat）。这些测试走那条往返——按钮动作 →
 * Markdown 源码 → renderMarkdown → HTML——某种语法若在阅读页露出源码，
 * 就在此失败，免得到读者面前才暴露。
 *
 * admin 编辑器不再自行渲染预览（只读回显存入的原文，ADR-0034），故本文件
 * 守的是插入语法对唯一真实渲染方持续有效。
 *
 * `body-format.test.ts` 覆盖手写源码的 renderMarkdown；本文件覆盖的恰是
 * 工具栏按钮的产出。
 */
describe("markdown toolbar → reader-page render round trip", () => {
  it("renders strikethrough as <del> with no leftover tildes", () => {
    const html = renderMarkdown(
      applyMarkdownAction("文字", 0, 2, "strikethrough").value,
    );
    expect(html).toContain("<del>文字</del>");
    expect(html).not.toContain("~~");
  });

  it("renders the horizontal rule as <hr> on its own line", () => {
    const result = applyMarkdownAction("前文", 2, 2, "horizontal-rule");
    const html = renderMarkdown(result.value);
    expect(html).toContain("<hr>");
    expect(html).toContain("<p>前文</p>");
    expect(html).not.toContain("---");
  });

  it("renders the GFM table template as a real table", () => {
    const html = renderMarkdown(
      applyMarkdownAction("", 0, 0, "table").value,
    );
    expect(html).toContain("<table>");
    expect(html).toContain("<th>列1</th>");
    expect(html).toContain("<td>内容</td>");
  });

  it("renders the task list item as a checkbox", () => {
    const html = renderMarkdown(
      applyMarkdownAction("买菜", 0, 2, "task-list").value,
    );
    expect(html).toContain("checkbox");
    expect(html).toContain("买菜");
    expect(html).not.toContain("[ ]");
  });

  it("renders the inserted image with its alt and url", () => {
    const html = renderMarkdown(
      applyMarkdownAction("图注", 0, 2, "image").value,
    );
    expect(html).toContain("<img");
    expect(html).toContain('alt="图注"');
    expect(html).toContain('src="https://"');
  });

  it("renders the autolink as a real anchor", () => {
    const html = renderMarkdown(
      applyMarkdownAction("https://x.com", 0, 13, "autolink").value,
    );
    expect(html).toContain('<a href="https://x.com">');
  });

  it("renders a www autolink as a clean anchor, not mangled brackets", () => {
    // 尖括号 autolink 要求 scheme；<www.x.com> 直接包会渲染出畸形 HTML
    // （尖括号残留、> 被吞进 href），补 http:// 后必须是干净锚点。
    const html = renderMarkdown(
      applyMarkdownAction("www.x.com", 0, 10, "autolink").value,
    );
    expect(html).toContain('<a href="http://www.x.com">http://www.x.com</a>');
    expect(html).not.toContain("&lt;");
    expect(html).not.toContain("%3E");
  });

  it("renders every heading level H1–H6 the dropdown offers", () => {
    const levels = [
      [1, "h1"],
      [2, "h2"],
      [3, "h3"],
      [4, "h4"],
      [5, "h5"],
      [6, "h6"],
    ] as const;
    for (const [level, tag] of levels) {
      const html = renderMarkdown(
        applyMarkdownAction("章", 0, 1, `header-${level}` as const).value,
      );
      expect(html).toContain(`<${tag}>章</${tag}>`);
      expect(html).not.toContain("#");
    }
  });

  it("renders the inserted link as an anchor", () => {
    const html = renderMarkdown(
      applyMarkdownAction("点我", 0, 2, "link").value,
    );
    expect(html).toContain('<a href="https://">点我</a>');
  });

  it("renders bold, italic and inline code as their inline tags", () => {
    expect(renderMarkdown(applyMarkdownAction("粗", 0, 1, "bold").value))
      .toContain("<strong>粗</strong>");
    expect(renderMarkdown(applyMarkdownAction("斜", 0, 1, "italic").value))
      .toContain("<em>斜</em>");
    expect(renderMarkdown(applyMarkdownAction("码", 0, 1, "code").value))
      .toContain("<code>码</code>");
  });

  it("renders bullet and ordered lists as list items", () => {
    expect(renderMarkdown(applyMarkdownAction("甲", 0, 1, "list-bullet").value))
      .toContain("<li>甲</li>");
    const ordered = renderMarkdown(
      applyMarkdownAction("甲\n乙", 0, 3, "list-ordered").value,
    );
    expect(ordered).toContain("<li>甲</li>");
    expect(ordered).toContain("<li>乙</li>");
  });

  it("renders the autolink fallback form as an anchor, not literal brackets", () => {
    // 非 URL 选区绝不能带着尖括号原样出来。
    const html = renderMarkdown(
      applyMarkdownAction("点我", 0, 2, "autolink").value,
    );
    expect(html).toContain('<a href="https://">点我</a>');
    expect(html).not.toContain("&lt;点我&gt;");
  });

  it("replaces an existing heading prefix with the picked level", () => {
    // 下拉是设置级别："## 小节" 选 H1 渲染为 <h1>，旧前缀不得残留在
    // 标题文本里。
    const html = renderMarkdown(
      applyMarkdownAction("## 小节", 3, 3, "header-1").value,
    );
    expect(html).toContain("<h1>小节</h1>");
    expect(html).not.toContain("##");
  });

  it("renders the fenced code block as pre/code", () => {
    const html = renderMarkdown(
      applyMarkdownAction("代码", 0, 2, "code-block").value,
    );
    expect(html).toContain("<pre><code>");
    expect(html).toContain("代码");
  });

  it("renders the blockquote as <blockquote>", () => {
    const html = renderMarkdown(
      applyMarkdownAction("引用", 0, 2, "blockquote").value,
    );
    expect(html).toContain("<blockquote>");
    expect(html).toContain("引用");
  });
});
