import {describe, expect, it} from "vitest";

import {iterInsertRows, mysqlUnescape, rowText, type DumpRow} from "../../scripts/import-ctwh/parse";
import {
  buildTargets,
  htmlToPlain,
  textToHtml,
  tcmId,
  toIso,
  type SourceTables,
} from "../../scripts/import-ctwh/build";

function makeRow(table: string, columns: string[], values: Array<string | number | null>): DumpRow {
  return {table, columns, values, line: 1};
}

describe("ctwh dump parser", () => {
  it("decodes MySQL escapes to real characters", () => {
    expect(mysqlUnescape("第一行\\r\\n第二行")).toBe("第一行\r\n第二行");
    expect(mysqlUnescape("\\'quoted\\'")).toBe("'quoted'");
    expect(mysqlUnescape("a\\\\b")).toBe("a\\b");
    expect(mysqlUnescape("unknown \\x escape")).toBe("unknown x escape");
    expect(mysqlUnescape("LIKE 100\\%")).toBe("LIKE 100\\%");
  });

  it("parses a realistic INSERT line with embedded ; , and NULL", () => {
    const line =
      "INSERT INTO `Book` (`BookInfoId`, `BookId`, `BookName`, `ChapterHeader`, `Enable`, `CreateDate`) " +
      "VALUES (1, 10001, '伤寒论・(宋版)', '辨太阳病；脉浮', 1, '2024-09-17 08:57:25');";
    const rows = [...iterInsertRows(line)];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.table).toBe("Book");
    expect(rowText(rows[0]!, "BookName")).toBe("伤寒论・(宋版)");
    expect(rowText(rows[0]!, "ChapterHeader")).toBe("辨太阳病；脉浮");
    expect(rows[0]!.values[0]).toBe(1);
    expect(rowText(rows[0]!, "Enable")).toBe("");
  });

  it("keeps quoted numerals as strings and bare numbers as numbers", () => {
    const line =
      "INSERT INTO `T` (`a`, `b`) VALUES ('12', 12);";
    const rows = [...iterInsertRows(line)];
    expect(rows[0]!.values[0]).toBe("12");
    expect(rows[0]!.values[1]).toBe(12);
  });

  it("throws when value count mismatches the column list", () => {
    const line = "INSERT INTO `T` (`a`, `b`) VALUES (1);";
    expect(() => [...iterInsertRows(line)]).toThrow(/1 values for 2 columns/);
  });
});

describe("ctwh id derivation", () => {
  it("is deterministic, 11 chars, and kind-scoped", () => {
    const first = tcmId("section", "5134");
    expect(first).toBe(tcmId("section", "5134"));
    expect(first).toHaveLength(11);
    expect(tcmId("chapter", "5134")).not.toBe(first);
  });
});

describe("ctwh text helpers", () => {
  it("textToHtml is lossless: keeps line content, empty lines and original separators", () => {
    expect(textToHtml("$u{桂枝}$w{三两}\r\n$u{芍药}")).toBe(
      "<p>$u{桂枝}$w{三两}</p>\r\n<p>$u{芍药}</p>",
    );
    // 裸 \r 分隔符（伤寒条文源文本）与行首空格、空行都原样保留
    expect(textToHtml("a\r\r  b")).toBe("<p>a</p>\r<p></p>\r<p>  b</p>");
    expect(textToHtml("   ")).toBe("");
  });

  it("toIso reads the CST dump timestamps", () => {
    expect(toIso("2024-09-17 08:57:25")).toBe("2024-09-17T00:57:25.000Z");
    expect(toIso("")).toBeNull();
  });

  it("htmlToPlain strips tags", () => {
    expect(htmlToPlain("<p>$u{桂枝}</p><p>$w{三两}</p>")).toBe("$u{桂枝} $w{三两}");
  });
});

describe("buildTargets relation wiring", () => {
  const tables: SourceTables = {
    work: [
      makeRow("WorkInfo", ["ChapterId", "Case", "BookName", "BookNo", "Author", "Chapter", "ImageUrl", "Comment", "CreateDate"], [6, "5", "伤寒金匮・(宋版)", 10001, null, 10, "Upload/a.jpg", "宋版原文", "2024-09-17 08:57:25"]),
    ],
    book: [
      makeRow("Book", ["BookInfoId", "BookId", "ChapterHeader", "ChapterSection", "CreateDate"], [900, 10001, "辨太阳病脉证并治", 1, "2024-09-17 08:57:25"]),
    ],
    bookBody: [
      makeRow("BookBody", ["BookBodyId", "BookInfoId", "ReceiptNo", "SectionText", "SectionNote", "SectionVideoMemo", "FangJi", "CreateDate"], [5134, 900, 1, "$u{桂枝}$w{三两。去皮}\r\n$u{芍药}$w{三两}", "注一", null, "桂枝汤,麻黄汤", "2024-09-17 08:57:25"]),
      makeRow("BookBody", ["BookBodyId", "BookInfoId", "ReceiptNo", "SectionText", "CreateDate"], [5135, 900, 2, "$m{{虚者}坏括号", "2024-09-17 08:57:25"]),
    ],
    fang: [
      makeRow("Fang", ["FangId", "FangName", "FangSourceBookId", "FangText", "YaoCount", "YaoList", "FangList", "CreateDate"], [500, "桂枝汤", 10001, "$f{桂枝汤} 5味", 5, "桂枝,芍药", "", "2024-09-17 08:59:43"]),
    ],
    fangBody: [
      // YaoID=6 是源 0-based 引用 → 导入 +1 补偿后引用 YaoId=7（桂枝）
      makeRow("FangBody", ["FangBodyId", "FangId", "YaoID", "Amount", "ShowName", "ExtraProcess"], [1, 500, 6, "三两", "桂枝", "去皮"]),
    ],
    yao: [
      makeRow("Yao", ["YaoId", "YaoName", "YaoBieMing", "YaoText", "CreateDate"], [7, "桂枝", "牡桂", "$u{桂枝} 味辛。温。", "2024-09-15 00:56:57"]),
    ],
    yaoAlias: [
      makeRow("yaoAlias", ["yaoAliasId", "YaoBieMing", "YaoName"], [4, "桂", "桂枝"]),
    ],
    mingCi: [
      makeRow("MingCi", ["MingCiId", "MingCiName", "MingCiText", "ShowImage", "MingCiType"], [1, "八纲辨症", "$g{八纲辨症} 内容", "Upload/Images/x.png", "医理"]),
    ],
  };

  const {channels, items, report} = buildTargets(tables, null);

  it("builds the work channel plus the 3 container channels, with the mapped category", () => {
    // build.ts 非单书模式随发方剂/本草/名词 3 个容器频道（fang/yao/term 条目书键的归属），
    // 工作频道在最前；容器频道 id 固定（CONTAINER_CHANNEL_IDS）。
    expect(channels).toHaveLength(4);
    const work = channels[0]!;
    expect(work.genre).toBe("1runoCsI7dr");
    expect((work.data as any).title).toBe("伤寒金匮・(宋版)");
    expect(channels.slice(1).map((c) => c.id)).toEqual([
      "tcmfang0001",
      "tcmyao00001",
      "tcmterm0001",
    ]);
  });

  it("builds one item per kind with the right status", () => {
    expect(report.itemsByKind).toEqual({chapter: 1, section: 2, fang: 1, yao: 1, term: 1});
    const byKind = (kind: string) => items.filter((item) => item.tcmKind === kind);
    expect(byKind("chapter")[0]!.status).toBe(1);
    for (const section of byKind("section")) expect(section.status).toBe(4);
    expect(byKind("fang")[0]!.status).toBe(1);
  });

  it("wires 条文→篇章 through tcm_parent_id and 频道 through _microfeed.bookId", () => {
    const chapter = items.find((item) => item.tcmKind === "chapter");
    const sections = items.filter((item) => item.tcmKind === "section");
    const channelId = channels[0]!.id;
    expect(chapter?.bookId).toBe(channelId);
    expect((chapter?.data as any)._microfeed.bookId).toBe(channelId);
    for (const section of sections) {
      expect(section.tcmParentId).toBe(chapter?.id);
      expect(section.bookId).toBe(channelId);
      expect((section.data as any)._microfeed.chapterId).toBeUndefined();
    }
    // Sections keep their source order key in the pocket.
    expect(sections.map((s) => (s.data as any)._microfeed.receiptNo)).toEqual([1, 2]);
  });

  it("assembles the chapter body from its sections in receiptNo order", () => {
    const chapter = items.find((item) => item.tcmKind === "chapter");
    expect((chapter?.data as any).description).toContain("$u{桂枝}$w{三两。去皮}");
    expect((chapter?.data as any).description).toContain("$m{{虚者}坏括号");
  });

  it("points 方剂 at the container channel and keeps the source book as a current id", () => {
    const fang = items.find((item) => item.tcmKind === "fang");
    expect(fang?.bookId).toBe("tcmfang0001");
    expect((fang?.data as any)._microfeed.sourceBookId).toBe(channels[0]!.id);
    expect((fang?.data as any)._microfeed.sourceBookId).not.toBe("10001");
  });

  it("resolves 方剂组成 yaoId to the herb item id (source YaoID is 0-based → +1 compensation)", () => {
    const yao = items.find((item) => item.tcmKind === "yao");
    const fang = items.find((item) => item.tcmKind === "fang");
    // 源 FangBody.YaoID 是 0-based 引用（比 Yao.YaoId 整体少 1），build.ts 导入时 +1：
    // 夹具 FangBody.YaoID=6 → 引用 YaoId=7（桂枝），yaoId 必须等于 yao 条目 id。
    expect((fang?.data as any)._microfeed.fangYaoList[0].yaoId).toBe(yao?.id);
    expect((yao?.data as any)._microfeed.aliases).toEqual([{bieming: "桂", name: "桂枝"}]);
  });

  it("reports marker parity and zero residual escapes", () => {
    expect(report.markerCountSource).toBe(report.markerCountOutput);
    expect(report.markerCountSource).toBeGreaterThan(0);
    expect(report.residualEscapes).toBe(0);
    expect(report.warnings).toEqual([]);
    for (const item of items) {
      expect(String(item.data.description ?? "")).not.toMatch(/\\[nrt]/);
    }
  });

  it("is idempotent: rebuilding yields identical ids", () => {
    const second = buildTargets(tables, null);
    expect(second.items.map((i) => i.id)).toEqual(items.map((i) => i.id));
    expect(second.channels.map((c) => c.id)).toEqual(channels.map((c) => c.id));
  });
});
