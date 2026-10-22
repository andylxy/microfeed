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
/** 容器频道（方剂 型）：只用来锚定真实典籍的条目，自身不是作品。 */
const CONTAINER_ID = "tcmtestcont";
/** 会员书（状态 10）与隐藏书（状态 2），验证 GetNav 的收录范围。 */
const MEMBER_CHANNEL_ID = "tcmtestmember";
const HIDDEN_CHANNEL_ID = "tcmtesthidden";
const INSERTED: string[] = [];

afterEach(async () => {
  if (INSERTED.length === 0) return;
  const itemIds = INSERTED.filter((id) => id !== "__category__1runoCsI7dr")
    .map((id) => `'${id}'`)
    .join(",");
  if (itemIds) await db.exec(`DELETE FROM items WHERE id IN (${itemIds});`);
  await db.exec(
    `DELETE FROM channels WHERE id IN ('${CHANNEL_ID}', '${CONTAINER_ID}', '${MEMBER_CHANNEL_ID}', '${HIDDEN_CHANNEL_ID}');`,
  );
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
        // `_microfeed.genre` 必须给：迁移 0113 的 `AFTER INSERT` 触发器会用
        // `json_extract(NEW.data, '$._microfeed.genre')` 覆写 `genre` 列（JSON 是 SSOT、
        // 列是镜像）。只写列不写 JSON ⇒ 列被覆盖成 NULL ⇒ `getAppNav` 的
        // `ch.genre = c.id` JOIN 匹配不上，分类凭空消失（本测试曾因此失败）。
        _microfeed: {
          author: "张仲景",
          chengShu: "汉",
          sourceImagePath: "Upload/a.jpg",
          case: "5",
          genre: "1runoCsI7dr",
        },
      }),
    )
    .run();

  // 容器频道与真实书同分类：它必须被导航过滤掉，否则 App 点开是一个没有章节的空壳。
  await db
    .prepare(
      "INSERT OR REPLACE INTO channels (id, status, is_primary, data, genre) VALUES (?, 1, NULL, ?, '1runoCsI7dr')",
    )
    .bind(
      CONTAINER_ID,
      JSON.stringify({
        title: "方剂",
        description: "中医方剂库",
        // 同上：容器频道也要给 `_microfeed.genre`，否则 0113 的触发器把列刷成 NULL。
        // 它仍会被 `getAppNav` 的 `tcmContainer IS NULL` 过滤掉 —— 这正是本用例要验的。
        _microfeed: {tcmContainer: "fang", genre: "1runoCsI7dr"},
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
    _microfeed: {bookId: CHANNEL_ID, receiptNo: 1, note: "注", videoMemo: "v1", fangList: ["桂枝汤"], bieMing: "牡桂,桂木"},
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
    // 注释与视频讲解照发原始值，不随档位或书状态变化。
    expect(content[0]!.data[0]!.note).toBe("注");
    expect(content[0]!.data[0]!.sectionvideo).toBe("v1");
    expect(content[0]!.data[1]!.text).toBe("$u{芍药}$w{三两}");
    // 未知篇章 → 空数组而非 404
    expect(await getAppChapterContent(db, "nope")).toEqual([]);
  });

  it("GetChapterContent 显示书：不论档位，note 与 sectionvideo 照发原始值", async () => {
    const {chapterId} = await seed();
    // 注释与视频讲解的下发不随档位或书状态变化：公开档与会员档都照发。
    for (const tier of ["public", "member"] as const) {
      const content = await getAppChapterContent(db, chapterId, tier);
      expect(content[0]!.data[0]!.note).toBe("注");
      expect(content[0]!.data[0]!.sectionvideo).toBe("v1");
      // 第二条本就没有注释 / 视频：仍是 null，不会因档位变成空串。
      expect(content[0]!.data[1]!.note).toBeNull();
      expect(content[0]!.data[1]!.sectionvideo).toBeNull();
    }
  });

  it("GetChapterContent 非 TCM 章节（无 book_id）：note 与 sectionvideo 照发原始值", async () => {
    // 没有 book_id 的章节（非 TCM 来源）bookStatus 为 null，不触发会员书门，
    // 注释与视频照发——与有 book_id 的章节同一口径。
    const chapterId = "tcmtestnonbook";
    await insertItem(chapterId, "chapter", null, null, 1, {
      title: "非 TCM 篇章",
      description: "<p>无关正文</p>",
      content_format: "html",
      _microfeed: {section: 1},
    });
    await insertItem("tcmtestnonsec", "section", chapterId, null, 4, {
      title: "非 TCM 条文",
      description: "<p>条文正文</p>",
      content_format: "html",
      _microfeed: {receiptNo: 1, note: "注", videoMemo: "v1", fangList: []},
    });
    for (const tier of ["public", "member"] as const) {
      const content = await getAppChapterContent(db, chapterId, tier);
      expect(content[0]!.data[0]!.note).toBe("注");
      expect(content[0]!.data[0]!.sectionvideo).toBe("v1");
    }
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

  it("GetNav drops container channels so the app never opens an empty book", async () => {
    await seed();
    const nav = await getAppNav(db);
    const shanghan = nav.find((c) => c.caseId === "1runoCsI7dr");
    expect(shanghan).toBeDefined();
    expect(shanghan!.navList.map((b) => b.bookNo)).toEqual([CHANNEL_ID]);
  });

  /** 同分类下再放一本会员书（10）与一本隐藏书（2）。`_microfeed.genre` 必须给，
   *  否则 0113 的触发器把 genre 列刷成 NULL，JOIN 匹配不上。 */
  async function seedMemberAndHidden(): Promise<void> {
    for (const [id, status, title] of [
      [MEMBER_CHANNEL_ID, 10, "会员书"],
      [HIDDEN_CHANNEL_ID, 2, "隐藏书"],
    ] as const) {
      await db
        .prepare(
          "INSERT OR REPLACE INTO channels (id, status, is_primary, data, genre) VALUES (?, ?, NULL, ?, '1runoCsI7dr')",
        )
        .bind(id, status, JSON.stringify({title, _microfeed: {genre: "1runoCsI7dr"}}))
        .run();
    }
  }

  it("GetNav 非会员只收录显示书，会员书与隐藏书都不给", async () => {
    await seed();
    await seedMemberAndHidden();
    const nav = await getAppNav(db);
    const ids = nav.find((c) => c.caseId === "1runoCsI7dr")!.navList.map((b) => b.bookNo);
    expect(ids).toContain(CHANNEL_ID);            // 显示 → 收录
    expect(ids).not.toContain(MEMBER_CHANNEL_ID); // 会员 → 非会员看不到
    expect(ids).not.toContain(HIDDEN_CHANNEL_ID); // 隐藏 → 不收录
  });

  it("GetNav 会员额外收录会员书，隐藏书仍不给", async () => {
    await seed();
    await seedMemberAndHidden();
    const nav = await getAppNav(db, "member");
    const ids = nav.find((c) => c.caseId === "1runoCsI7dr")!.navList.map((b) => b.bookNo);
    expect(ids).toContain(CHANNEL_ID);            // 显示 → 收录
    expect(ids).toContain(MEMBER_CHANNEL_ID);     // 会员 → 会员可见
    expect(ids).not.toContain(HIDDEN_CHANNEL_ID); // 隐藏 → 不收录
  });

  it("会员书：公开档读不到章节 / 正文 / 方剂，会员档能读到", async () => {
    const {chapterId} = await seed();
    await db
      .prepare("UPDATE channels SET status = 10 WHERE id = ?")
      .bind(CHANNEL_ID)
      .run();

    expect(await getAppBookChapters(db, CHANNEL_ID)).toEqual([]);
    expect(await getAppChapterContent(db, chapterId)).toEqual([]);
    expect(await getAppBookFang(db, CHANNEL_ID)).toEqual([]);

    expect((await getAppBookChapters(db, CHANNEL_ID, "member")).length)
      .toBeGreaterThan(0);
    const memberContent = await getAppChapterContent(db, chapterId, "member");
    expect(memberContent).toHaveLength(1);
    // 会员档下注释与视频讲解照发原始值。
    expect(memberContent[0]!.data[0]!.note).toBe("注");
    expect(memberContent[0]!.data[0]!.sectionvideo).toBe("v1");
    // 第二条本就没有注释 / 视频：空串归一成 null。
    expect(memberContent[0]!.data[1]!.note).toBeNull();
    expect(memberContent[0]!.data[1]!.sectionvideo).toBeNull();
    expect((await getAppBookFang(db, CHANNEL_ID, "member")).length)
      .toBeGreaterThan(0);
  });

  it("GetBookIdFang returns formulas of one source book with composition detail", async () => {
    await seed();
    const fangs = await getAppBookFang(db, CHANNEL_ID);
    expect(fangs).toHaveLength(1);
    expect(fangs[0]!.name).toBe("桂枝汤");
    // Fang.ID 发「本方在本书内的 0-based 序号」而非 11 位 tcmId：App Gson 的
    // IntegerTypeAdapter 只接受数值/数值字符串，下发 tcmId 会让 App 直接崩。
    // 2026-10-03 拍板 A，依据 .scratch/tcm-import/golden/compare.mts:36-39——源 int64
    // 按 spec §16 不落库，故值不可逐字节复现，golden 归类 known-id-numeric。
    // 本断言在 d1023b4 写成 11 位 id，21eb535 改实现（numericIdString → String(index)）
    // 时漏改，现补齐。
    expect(fangs[0]!.ID).toBe("0");
    expect(fangs[0]!.yaoCount).toBe("5");
    expect(fangs[0]!.drinkNum).toBe("3");
    expect(fangs[0]!.height).toBe("0");
    expect(fangs[0]!.text).toBe("$f{桂枝汤} 5味\n$u{桂枝}$w{三两。去皮}");
    // 同一拍板：yaoID 发「在本方组成内的序号」，不发中药 tcmId。
    // 注：实现用 1-based（reads.ts 的 String(yIndex + 1)），netcore 是 0-based 的全局
    // Yao 序号（甘草=0、杏仁=17）；compare.mts:39 接受的正是「组成顺序号」同形数值。
    expect(fangs[0]!.standardYaoList[0]!.yaoID).toBe("1");
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
    // 0110 aligned $w with the source app's Color.GREEN (was the softer #1CB55C).
    expect(byCode.get("w")?.color).toBe("#00FF00");
    // 0109 turned the renderer's hard-coded 0.7 into data; every seed row carries
    // the column default, so nothing renders differently until it is edited.
    expect(byCode.get("w")?.smallFontScale).toBe(0.7);
    expect(byCode.get("f")?.smallFontScale).toBe(0.7);
  });
});
