import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it} from "vitest";

import {FieldDiff, FieldDiffList, toLines} from "@/components/admin/shared/FieldDiff";

/**
 * The audit trail and the review queue share this renderer, so a regression
 * here breaks both pages at once — and it is the only way an approver can see
 * what a change actually did.
 */
function renderDiff(change: Record<string, unknown>): string {
  return renderToStaticMarkup(
    React.createElement(FieldDiff, {change: change as never}),
  )
    // React SSR separates adjacent text nodes with an empty comment, which would
    // break assertions that span the diff marker and the line itself.
    .replaceAll("<!-- -->", "")
    // Un-escape so the assertions can be written as the text the user sees.
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&");
}

describe("FieldDiff", () => {
  it("splits a value into lines for the line-level diff", () => {
    expect(toLines("一\n二")).toEqual(["一", "二"]);
    expect(toLines(null)).toEqual([]);
    expect(toLines({a: 1})).toEqual(["{", '  "a": 1', "}"]);
  });

  it("splits a single-line HTML body into block lines", () => {
    // Chapter bodies are stored without newlines (Quill output). Splitting only
    // on \n would diff the entire chapter as one line.
    expect(toLines("<p>第一段</p><p>第二段</p>")).toEqual([
      "<p>第一段</p>",
      "<p>第二段</p>",
    ]);
    // Markdown-rendered bodies already have newlines and must not be touched.
    expect(toLines("<p>一</p>\n<p>二</p>")).toEqual(["<p>一</p>", "<p>二</p>"]);
    // Plain text without any block tag is left as-is.
    expect(toLines("没有标签的纯文本")).toEqual(["没有标签的纯文本"]);
  });

  it("diffs an HTML body paragraph by paragraph", () => {
    const html = renderDiff({
      op: "update",
      path: "description",
      before: "<p>第一段</p><p>第二段</p><p>第三段</p><p>第四段</p>",
      after: "<p>第一段</p><p>第二段改了</p><p>第三段</p><p>第四段</p>",
    });

    expect(html).toContain("-<p>第二段</p>");
    expect(html).toContain("+<p>第二段改了</p>");
    // The untouched paragraphs must show up as context, not as one giant line.
    expect(html).toContain("<p>第一段</p>");
    expect(html).toContain("<p>第三段</p>");
  });

  it("renders a changed body as a git-style hunk with - and + lines", () => {
    const html = renderDiff({
      op: "update",
      path: "description",
      before: "第一段\n第二段\n第三段\n第四段\n第五段\n第六段",
      after: "第一段\n第二段改了\n第三段\n第四段\n第五段\n第六段",
    });

    // Hunk header, the removed line, the added line — the shape `git diff` uses.
    expect(html).toContain("@@ -");
    expect(html).toContain("description");
    expect(html).toContain("-第二段");
    expect(html).toContain("+第二段改了");
    // Unchanged neighbours are shown as context, not as changes.
    expect(html).toContain("第一段");
  });

  it("collapses untouched stretches instead of printing a long body twice", () => {
    const lines = (n: number) => Array.from({length: n}, (_, i) => `第${i}行`);
    const html = renderDiff({
      op: "update",
      path: "description",
      before: lines(120).join("\n"),
      after: lines(120)
        .map((line) => (line === "第60行" ? "第60行改" : line))
        .join("\n"),
    });

    // Only the changed line and a few lines of context survive.
    expect(html).toContain("-第60行");
    expect(html).toContain("+第60行改");
    expect(html).not.toContain("第0行");
    expect(html).not.toContain("第119行");
  });

  it("renders every change of a record as its own block", () => {
    const html = renderToStaticMarkup(
      React.createElement(FieldDiffList, {
        changes: [
          {op: "update", path: "title", before: "旧标题", after: "新标题"},
          {op: "add", path: "tags", after: ["热血"]},
        ] as never,
      }),
    );

    expect(html).toContain("title");
    expect(html).toContain("tags");
    expect(html).toContain("-旧标题");
    expect(html).toContain("+新标题");
  });
});
