import {describe, expect, it} from "vitest";

import {parseItemSearchQuery} from "@/shared/ItemSearch";

// 查询词解析之后怎么用，见 `tests/worker/item-search.test.ts`：每个词转成一条
// LIKE 子串谓词，多个词之间取 AND。引号只在切词阶段生效——短语不被空格劈开。
describe("item search query grammar", () => {
  it("parses terms, both quote styles, escapes, and an unfinished phrase", () => {
    expect(parseItemSearchQuery(
      `launch "season finale" 'director\\'s cut' don\\'t last`,
    )).toEqual([
      {phrase: false, text: "launch"},
      {phrase: true, text: "season finale"},
      {phrase: true, text: "director's cut"},
      {phrase: false, text: "don't"},
      {phrase: false, text: "last"},
    ]);
    expect(parseItemSearchQuery("one 'unfinished phrase")).toEqual([
      {phrase: false, text: "one"},
      {phrase: true, text: "unfinished phrase"},
    ]);
    expect(parseItemSearchQuery('one "unfinished phrase')).toEqual([
      {phrase: false, text: "one"},
      {phrase: true, text: "unfinished phrase"},
    ]);
    expect(parseItemSearchQuery('"the \\"finale\\"" next')).toEqual([
      {phrase: true, text: 'the "finale"'},
      {phrase: false, text: "next"},
    ]);
    expect(parseItemSearchQuery(`don't stop `).at(0)?.text).toBe("don't");
  });
});
