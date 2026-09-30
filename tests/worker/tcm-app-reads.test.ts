import {afterEach, describe, expect, it} from "vitest";
import {env} from "cloudflare:workers";

import {
  getAppAllTerms,
  getAppAllYao,
  getAppBookChapters,
  getAppBookFang,
  getAppChapterContent,
  getAppNav,
  getAppStyleConfig,
  getAppYaoAliases,
} from "@/server/tcm/reads";

const db = env.FEED_DB;

const CHANNEL_ID = "tcmtestbook";
const INSERTED: string[] = [];

afterEach(async () => {
  if (INSERTED.length === 0) return;
  const itemIds = INSERTED.filter((id) => id !== "__category__1runoCsI7dr")
    .map((id) => `'${id}'`)
    .join(",");
  if (itemIds) await db.exec(`DELETE FROM items WHERE id IN (${itemIds});`);
  await db.exec(`DELETE FROM channels WHERE id = '${CHANNEL_ID}';`);
  await db.exec("DELETE FROM ext_category WHERE id = '1runoCsI7dr' AND name = '伤寒';");
  INSERTED.length = 0;
});

async function insertItem(
  id: string,
  kind: string,
  parentId: string | null,
  bookId: string | null,
  status: number,
  data: Record<string, unknown>,
): Promise<void> {
  INSERTED.push(id);
  await db
    .prepare(
      "INSERT OR REPLACE INTO items (id, status, data, pub_date, created_at, updated_at, " +
        "content_text, content_text_updated_at, content_text_revision, review_status, book_id, " +
        "tcm_kind, tcm_parent_id) VALUES (?, ?, ?, '2024-09-17T00:57:25.000Z', " +
        "'2024-09-17T00:57:25.000Z', '2024-09-17T00:57:25.000Z', '', " +
        "'2024-09-17T00:57:25.000Z', 1, NULL, ?, ?, ?)",
    )
    .bind(id, status, JSON.stringify(data), bookId, kind, parentId)
    .run();
}

async function seed(): Promise<{chapterId: string; fangId: string}> {
  // 测试库没有「伤寒」分类（0072 只种针灸/人纪），补一条并在 afterEach 清理
  await db
    .prepare(
      "INSERT OR IGNORE INTO ext_category (id, name, slug, parent_id, sort, visible) VALUES ('1runoCsI7dr', '伤寒', '伤寒', NULL, 30, 1)",
    )
    .run();
  INSERTED.push("__category__1runoCsI7dr");
  INSERTED.push(CHANNEL_ID);
  await db
    .prepare(
      "INSERT OR REPLACE INTO channels (id, status, is_primary, data, genre) VALUES (?, 1, NULL, ?, '1runoCsI7dr')",
    )
    .bind(
      CHANNEL_ID,
      JSON.stringify({
        title: "伤寒金匮・(宋版)",
        description: "宋版原文",
        _microfeed: {author: "张仲景", chengShu: "汉", sourceImagePath: "Upload/a.jpg", case: "5"},
      }),
    )
    .run();

  const chapterId = "tcmtestchapter";
  await insertItem(chapterId, "chapter", null, CHANNEL_ID, 1, {
    title: "辨太阳病脉证并治",
    description: "<p>$u{桂枝}$w{三两。去皮}</p>\n<p>$u{芍药}$w{三两}</p>",
    content_format: "html",
    _microfeed: {bookId: CHANNEL_ID, section: 1},
  });

  await insertItem("tcmtestsec1", "section", chapterId, CHANNEL_ID, 4, {
    title: "第1条・辨太阳病脉证并治",
    description: "<p>$u{桂枝}$w{三两。去皮}</p>",
    content_format: "html",
    _microfeed: {bookId: CHANNEL_ID, receiptNo: 1, note: "注", videoMemo: "", fangList: ["桂枝汤"], bieMing: "牡桂,桂木"},
  });
  await insertItem("tcmtestsec2", "section", chapterId, CHANNEL_ID, 4, {
    title: "第2条・辨太阳病脉证并治",
    description: "<p>$u{芍药}$w{三两}</p>",
    content_format: "html",
    _microfeed: {bookId: CHANNEL_ID, receiptNo: 2, note: "", videoMemo: "", fangList: []},
  });

  const fangId = "tcmtestfang";
  await insertItem(fangId, "fang", null, "tcmfang0001", 1, {
    title: "桂枝汤",
    description: "<p>$f{桂枝汤} 5味</p>\n<p>$u{桂枝}$w{三两。去皮}</p>",
    content_format: "html",
    _microfeed: {
      bookId: "tcmfang0001",
      sourceBookId: CHANNEL_ID,
      yaoCount: 5,
      drinkNum: 3,
      yaoList: ["桂枝", "芍药"],
      fangList: [],
      fangYaoList: [
        {yaoId: "tcmtestyao", amount: "三两", weight: 300, suffix: "", showName: "桂枝", extraProcess: "去皮"},
      ],
    },
  });

  await insertItem("tcmtestyao", "yao", null, "tcmyao00001", 1, {
    title: "桂枝",
    description: "<p>$u{桂枝} 味辛。温。</p>",
    content_format: "html",
    _microfeed: {bookId: "tcmyao00001", bieMing: "牡桂", yaoNames: "肉桂。煨桂", aliases: [{bieming: "桂", name: "桂枝"}]},
  });

  await insertItem("tcmtestterm", "term", null, "tcmterm0001", 1, {
    title: "八纲辨症",
    description: "<p>阴阳表里寒热虚实。</p>",
    content_format: "html",
    _microfeed: {bookId: "tcmterm0001", beiMing: "", type: "医理", mingCiList: "八纲,六经", sourceImagePath: "Upload/x.png"},
  });

  return {chapterId, fangId};
}

describe("TCM app read functions", () => {
  it("GetBookChapter lists chapters of one book only, current ids", async () => {
    const {chapterId} = await seed();
    const chapters = await getAppBookChapters(db, CHANNEL_ID);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]!.bookId).toBe(CHANNEL_ID);
    expect(chapters[0]!.chapterHeader).toBe("辨太阳病脉证并治");
    expect(chapters[0]!.signatureId).toBe(chapterId);
    expect(chapters[0]!.chapterSection).toBe(1);
  });

  it("GetChapterContent returns sections raw-markered, ordered by receiptNo", async () => {
    const {chapterId} = await seed();
    const content = await getAppChapterContent(db, chapterId);
    expect(content).toHaveLength(1);
    expect(content[0]!.header).toBe("辨太阳病脉证并治");
    expect(content[0]!.signatureId).toBe(chapterId);
    expect(content[0]!.data).toHaveLength(2);
    expect(content[0]!.data[0]!.id).toBe("tcmtestsec1");
    expect(content[0]!.data[0]!.text).toBe("$u{桂枝}$w{三两。去皮}");
    expect(content[0]!.data[0]!.fangList).toEqual(["桂枝汤"]);
    expect(content[0]!.data[0]!.note).toBe("注");
    expect(content[0]!.data[1]!.text).toBe("$u{芍药}$w{三两}");
    // 未知篇章 → 空数组而非 404
    expect(await getAppChapterContent(db, "nope")).toEqual([]);
  });

  it("GetNav groups books by category with pocket metadata", async () => {
    await seed();
    const nav = await getAppNav(db);
    const shanghan = nav.find((c) => c.caseId === "1runoCsI7dr");
    expect(shanghan).toBeDefined();
    expect(shanghan!.name).toBe("伤寒");
    const book = shanghan!.navList.find((b) => b.bookNo === CHANNEL_ID);
    expect(book?.bookName).toBe("伤寒金匮・(宋版)");
    expect(book?.author).toBe("张仲景");
    expect(book?.chengShu).toBe("汉");
    expect(book?.caseTag).toBe(5);
    expect(book?.desc).toBeNull();
    expect(book?.chapterCount).toBe(0);
  });

  it("GetBookIdFang returns formulas of one source book with composition detail", async () => {
    const {fangId} = await seed();
    const fangs = await getAppBookFang(db, CHANNEL_ID);
    expect(fangs).toHaveLength(1);
    expect(fangs[0]!.name).toBe("桂枝汤");
    expect(fangs[0]!.ID).toBe(fangId);
    expect(fangs[0]!.yaoCount).toBe("5");
    expect(fangs[0]!.drinkNum).toBe("3");
    expect(fangs[0]!.height).toBe("0");
    expect(fangs[0]!.text).toBe("$f{桂枝汤} 5味\n$u{桂枝}$w{三两。去皮}");
    expect(fangs[0]!.standardYaoList[0]!.yaoID).toBe("tcmtestyao");
    expect(fangs[0]!.standardYaoList[0]!.amount).toBe("三两");
    expect(fangs[0]!.standardYaoList[0]!.weight).toBe("300");
  });

  it("GetAllZhongYao / GetAliaZhongYao / GetAllMingCi expose raw marker text", async () => {
    await seed();
    const yao = await getAppAllYao(db);
    const guiZhi = yao.find((y) => y.name === "桂枝");
    expect(guiZhi?.text).toBe("$u{桂枝} 味辛。温。");

    const aliases = await getAppYaoAliases(db);
    // 三源：① yaoAlias 表 ② 源 Yao.YaoList 切分 ③ 条文 BookBody.BieMing 切分（result[0]=正名）
    expect(aliases).toContainEqual({bieming: "桂", name: "桂枝"});
    expect(aliases).toContainEqual({bieming: "肉桂", name: "桂枝"});
    expect(aliases).toContainEqual({bieming: "煨桂", name: "桂枝"});
    expect(aliases).toContainEqual({bieming: "桂木", name: "牡桂"});

    const terms = await getAppAllTerms(db);
    const term = terms.find((t) => t.name === "八纲辨症");
    expect(term?.text).toBe("阴阳表里寒热虚实。");
    expect(term?.imageUrl).toBe("Upload/x.png");
    expect(term?.mingCiList).toEqual(["八纲", "六经"]);
  });

  it("GetTipsStyleConfig style list carries colours and link types", async () => {
    const styles = await getAppStyleConfig(db);
    expect(styles.length).toBeGreaterThanOrEqual(13);
    const byCode = new Map(styles.map((s) => [s.marker, s]));
    expect(byCode.get("u")?.linkType).toBe(1);
    expect(byCode.get("f")?.linkType).toBe(2);
    expect(byCode.get("g")?.linkType).toBe(3);
    expect(byCode.get("w")?.isSmallFont).toBe(true);
    expect(byCode.get("w")?.color).toBe("#1CB55C");
  });
});
