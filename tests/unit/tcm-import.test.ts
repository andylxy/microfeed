import {describe, expect, it} from "vitest";

import {iterInsertRows, mysqlUnescape, rowText, type DumpRow} from "../../scripts/import-ctwh/parse";
import {
  buildTargets,
  htmlToPlain,
  parseFangTextIngredients,
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

/**
 * 源 dump 的 `FangBody` 表并不完整（金匮・人纪 49 首仅 2 首有行、桂林古本
 * 329 首仅 7 首），其余方剂的药味组成写在 `Fang.FangText` 的 `$u{}/$w{}`
 * 标记里。以下用例锁定「从正文回退补组成」的行为（2026-10-03）。
 */
describe("FangText 组成回退", () => {
  it("分离式 $u{药名}$w{剂量}（源中最常见的写法）", () => {
    expect(
      parseFangTextIngredients("$u{牡蛎}$w{四两，熬}，$u{麻黄}$w{四两，去节}"),
    ).toEqual([
      {showName: "牡蛎", amount: "四两，熬"},
      {showName: "麻黄", amount: "四两，去节"},
    ]);
  });

  it("嵌套式 $u{药名$w{剂量}} —— 外层 } 缺失也不能漏（单层正则会漏）", () => {
    expect(
      parseFangTextIngredients("$u{知母$w{六两}、$u{石膏$w{一斤}、$u{甘草$w{二两(炙)}"),
    ).toEqual([
      {showName: "知母", amount: "六两"},
      {showName: "石膏", amount: "一斤"},
      {showName: "甘草", amount: "二两(炙)"},
    ]);
  });

  it("脏括号 $w{四两| 不应吞掉后续药味", () => {
    expect(
      parseFangTextIngredients("$u{禹余粮}$w{四两|  $u{人参}$w{三两}    $u{附子}$w{二枚}"),
    ).toEqual([
      {showName: "禹余粮", amount: "四两|"},
      {showName: "人参", amount: "三两"},
      {showName: "附子", amount: "二枚"},
    ]);
  });

  it("共享剂量的写法：前味无剂量、末味带剂量", () => {
    expect(parseFangTextIngredients("$u{括蒌根}、$u{牡蛎 (熬) }$w{各等分}。")).toEqual([
      {showName: "括蒌根", amount: null},
      {showName: "牡蛎 (熬)", amount: "各等分"},
    ]);
  });

  it("只取组成段：「上X味」之后的加减法不得计入", () => {
    // 源 FangText 的结构是 组成 →「上X味，以水…」煎服法 → 加减法，后两段的
    // $u{} 不是本方组成（全段扫描会让小青龙汤虚增到 18 味）。
    expect(
      parseFangTextIngredients(
        "$u{麻黄}$w{三两}、$u{芍药}$w{三两}、$u{桂枝}$w{三两}\n\n" +
          "上八味，以水一斗…若渴者，去半夏，加$u{栝蒌根}$w{三两}",
      ),
    ).toEqual([
      {showName: "麻黄", amount: "三两"},
      {showName: "芍药", amount: "三两"},
      {showName: "桂枝", amount: "三两"},
    ]);
  });

  it("无 $u{} 标记 → 空数组（源标注『(佚)』『方未见。』的方剂）", () => {
    expect(parseFangTextIngredients("39、$f{禹余粮丸} (佚)")).toEqual([]);
    expect(parseFangTextIngredients("125、$f{杏子汤} 方未见。")).toEqual([]);
  });

  // ---- 接线：buildTargets 是否按书号白名单启用回退 ----------------------
  const fangTables = (bookNo: number, fangText: string): SourceTables => ({
    work: [
      makeRow(
        "WorkInfo",
        ["ChapterId", "Case", "BookName", "BookNo", "Author", "Chapter", "ImageUrl", "Comment", "CreateDate"],
        [6, "5", "测试书", bookNo, null, 10, null, null, "2024-09-17 08:57:25"],
      ),
    ],
    book: [],
    bookBody: [],
    fang: [
      makeRow(
        "Fang",
        ["FangId", "FangName", "FangSourceBookId", "FangText", "YaoCount", "YaoList", "FangList", "CreateDate"],
        [501, "四逆加人参汤", bookNo, fangText, 2, "", "", "2024-09-17 08:59:43"],
      ),
    ],
    fangBody: [], // 关键：无 FangBody 行，必须走正文回退
    yao: [
      makeRow("Yao", ["YaoId", "YaoName", "YaoBieMing", "YaoText", "CreateDate"], [7, "桂枝", null, "$u{桂枝}", "2024-09-15 00:56:57"]),
      makeRow("Yao", ["YaoId", "YaoName", "YaoBieMing", "YaoText", "CreateDate"], [5, "芍药", null, "$u{芍药}", "2024-09-15 00:56:57"]),
    ],
    yaoAlias: [],
    mingCi: [],
  });

  it("白名单书号（9050000）无 FangBody → 从正文补组成，yaoId 按名命中", () => {
    const {items} = buildTargets(fangTables(9050000, "$u{桂枝}$w{三两}、$u{芍药}$w{二两}"), null);
    const fang = items.find((item) => item.tcmKind === "fang");
    const list = (fang?.data as any)._microfeed.fangYaoList;
    expect(list).toHaveLength(2);
    expect(list[0].showName).toBe("桂枝");
    expect(list[0].amount).toBe("三两");
    // 按名解析命中真实 YaoId=7（**不做** FangBody 那套 0-based +1 补偿）
    expect(list[0].yaoId).toBe(tcmId("yao", "7"));
    expect(list[1].yaoId).toBe(tcmId("yao", "5"));
    // 源 YaoList 为空 → 回退时由组成填充
    expect((fang?.data as any)._microfeed.yaoList).toEqual(["桂枝", "芍药"]);
  });

  it("非白名单书号（10001 宋版）→ 回退不生效，组成保持为空", () => {
    const {items} = buildTargets(fangTables(10001, "$u{桂枝}$w{三两}"), null);
    const fang = items.find((item) => item.tcmKind === "fang");
    expect((fang?.data as any)._microfeed.fangYaoList).toEqual([]);
    expect((fang?.data as any)._microfeed.yaoList).toEqual([]);
  });

  it("回退命中不了的中药 → yaoId 为 null 但保留 showName", () => {
    const {items} = buildTargets(fangTables(9050000, "$u{括蒌根}$w{二两}"), null);
    const fang = items.find((item) => item.tcmKind === "fang");
    const list = (fang?.data as any)._microfeed.fangYaoList;
    expect(list).toHaveLength(1);
    expect(list[0].showName).toBe("括蒌根");
    expect(list[0].yaoId).toBeNull();
  });
});
