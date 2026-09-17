import {describe, expect, it} from "vitest";

import {splitChapters, toArabic} from "@/shared/novelChapterImport";

describe("novel chapter import parser", () => {
  it("converts Arabic and simple Chinese numerals", () => {
    expect(toArabic("12")).toBe(12);
    expect(toArabic("三")).toBe(3);
    expect(toArabic("十")).toBe(10);
    expect(toArabic("十一")).toBe(11);
    expect(toArabic("二十")).toBe(20);
    expect(toArabic("三十五")).toBe(35);
    expect(toArabic("一百")).toBe(100);
    expect(toArabic("两百零六")).toBe(206);
  });

  it("splits on blank lines and numbers untitled blocks sequentially", () => {
    const chapters = splitChapters("第一段内容。\n\n第二段内容。");
    expect(chapters).toHaveLength(2);
    expect(chapters.map((chapter) => chapter.chapterNo)).toEqual([1, 2]);
    expect(chapters[0]?.title).toBe("第1章");
    expect(chapters[1]?.content).toBe("第二段内容。");
  });

  it("recognises 第N章 headings and keeps the heading as the title", () => {
    const chapters = splitChapters(
      "第一章 起点\n正文一\n\n第二章 转折\n正文二",
    );
    expect(chapters).toHaveLength(2);
    expect(chapters[0]?.title).toBe("第一章 起点");
    expect(chapters[0]?.chapterNo).toBe(1);
    expect(chapters[0]?.content).toBe("正文一");
    expect(chapters[1]?.chapterNo).toBe(2);
  });

  it("recognises markdown headings, English chapter headings, and 回/节", () => {
    const markdown = splitChapters("# Prologue\nBody");
    expect(markdown[0]?.title).toBe("Prologue");

    const english = splitChapters("Chapter 7\nThe seventh.");
    expect(english[0]?.chapterNo).toBe(7);

    const hui = splitChapters("第三回 大闹\n正文");
    expect(hui[0]?.chapterNo).toBe(3);
  });

  it("attaches a volume marker to following chapters and emits the lead-in", () => {
    const chapters = splitChapters(
      "第一卷 初入江湖\n引子内容\n\n第一章 拜师\n正文一\n\n第二章 下山\n正文二",
    );
    expect(chapters).toHaveLength(3);
    expect(chapters[0]?.title).toBe("第一卷·起始");
    expect(chapters[0]?.content).toBe("引子内容");
    expect(chapters.map((chapter) => chapter.volume)).toEqual([
      "第一卷",
      "第一卷",
      "第一卷",
    ]);
  });

  it("continues auto-numbering after an explicitly numbered chapter", () => {
    const chapters = splitChapters(
      "第十章 十\n正文\n\n未命名的后续段落。",
    );
    expect(chapters[0]?.chapterNo).toBe(10);
    // The untitled block follows the explicit number rather than restarting at 1.
    expect(chapters[1]?.chapterNo).toBe(11);
  });

  it("returns nothing for empty or whitespace-only input", () => {
    expect(splitChapters("")).toEqual([]);
    expect(splitChapters("   \n\n  \n")).toEqual([]);
  });

  it("handles CRLF input", () => {
    const chapters = splitChapters("第一章 一\r\n正文\r\n\r\n第二章 二\r\n正文");
    expect(chapters).toHaveLength(2);
    expect(chapters[1]?.title).toBe("第二章 二");
  });
});
