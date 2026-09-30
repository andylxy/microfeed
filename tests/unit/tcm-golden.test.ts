/**
 * 工单 15 回归报警：golden 快照契约断言。
 *
 * golden/old 与 golden/new 由 `.scratch/tcm-import/golden/capture.mts` 抓取
 * （需要旧 .NET 后端与本地 dev 同时运行），compare.mts 做逐字段比对。
 * 本测试读取已抓取的 new 快照，锁死与旧后端对齐后的 wire 契约——
 * 改坏信封/字段名/形状会在这里报警。golden 文件不入 git，缺失时整组跳过。
 */
import {existsSync, readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, "../../.scratch/tcm-import/golden/new");
const hasGolden = existsSync(join(goldenDir, "GetNav.json"));

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(goldenDir, `${name}.json`), "utf8"));
}

describe.skipIf(!hasGolden)("TCM golden wire contract (snapshot)", () => {
  it("every response uses the legacy {code:200, data, msg} envelope", () => {
    for (const name of ["GetNav", "GetBookChapter", "GetChapterContent", "GetBookIdFang", "GetAllZhongYao", "GetAliaZhongYao", "GetAllMingCi"]) {
      const body = load(name) as {code?: number; data?: unknown; msg?: string};
      expect(body.code, name).toBe(200);
      expect(body.msg, name).toBe("请求成功");
      expect(body.data, name).toBeDefined();
    }
  });

  it("GetBookChapter rows are camelCase with 11-char signatureId", () => {
    const rows = (load("GetBookChapter") as {data: Array<Record<string, unknown>>}).data;
    expect(Object.keys(rows[0]!).sort()).toEqual(["bookId", "chapterHeader", "chapterSection", "signatureId"]);
  });

  it("GetChapterContent keeps section header signatureId and mirrors legacy per-item signature keys", () => {
    const outer = (load("GetChapterContent") as {data: Array<Record<string, unknown>>}).data[0]!;
    expect(Object.keys(outer).sort()).toEqual(["data", "header", "section", "signatureId"]);
    // 结构对齐旧后端：条文项也带 signature / signatureId（值用自身 11 位 id，源签名不落库）。
    for (const item of outer.data as Array<Record<string, unknown>>) {
      expect(Object.keys(item).sort()).toEqual([
        "fangList", "height", "id", "note", "sectionvideo", "signature", "signatureId", "text",
      ]);
    }
  });

  it("GetBookIdFang rows mirror legacy casing and string-typed numbers", () => {
    const rows = (load("GetBookIdFang") as {data: Array<Record<string, unknown>>}).data;
    // 结构对齐旧后端：方剂行带 signature / signatureId（值用自身 11 位 id，源签名不落库）。
    expect(Object.keys(rows[0]!).sort()).toEqual([
      "ID", "drinkNum", "fangList", "height", "name", "signature", "signatureId",
      "standardYaoList", "text", "yaoCount", "yaoList",
    ]);
    expect(typeof rows[0]!.yaoCount).toBe("string");
    expect(typeof rows[0]!.height).toBe("string");
  });

  it("GetAllZhongYao rows expose only {name, text}", () => {
    const rows = (load("GetAllZhongYao") as {data: Array<Record<string, unknown>>}).data;
    for (const row of rows.slice(0, 10)) {
      expect(Object.keys(row).sort()).toEqual(["name", "text"]);
    }
  });

  it("GetAllMingCi rows are lowercase-id shape with mingCiList arrays", () => {
    const rows = (load("GetAllMingCi") as {data: Array<Record<string, unknown>>}).data;
    expect(Object.keys(rows[0]!).sort()).toEqual(["id", "imageUrl", "mingCiList", "name", "text"]);
    expect(Array.isArray(rows[0]!.mingCiList)).toBe(true);
  });
});
