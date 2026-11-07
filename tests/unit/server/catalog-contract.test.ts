/**
 * 前台内容引擎取数契约（ADR-0066，规范 §8「验证策略」、§9 第 21 步）。
 *
 * 覆盖七个 catalog 模块的取数形状、§2.2 正文分流口径、D5-A 方剂按书解析、
 * D1 裁决 A 旧地址退场、站点外壳缺行回落，以及 §8 解耦断言四条。
 * 夹具是内存 SQLite 上的新表列名，不连真库、不跑 dev server；引用解析基线
 * 用固定语料复算口径，全量数字由 .scratch/catalog-audit/ 的只读探针取证，
 * 测试里不读文档文本，也不把数字复制成第二份真源。
 *
 * 测试只写不跑（AGENTS.md 最高指令：门禁只在用户手动触发时跑）。
 */
import {existsSync, readFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";

import {makeD1, makeSqlite} from "./helpers/d1";
import {
  getVolumeWithSections,
  listVolumesByBook,
  renderBodyHtml,
  renderBodySource,
  sectionText,
  type CatalogSectionRow,
} from "@/server/catalog/chapters";
import {getGroupByKey, listGroups} from "@/server/catalog/groups";
import {
  getBookInfoById,
  getBookNoById,
  listAllBooks,
  listBooksByGroup,
} from "@/server/catalog/books";
import {
  getFangEntry,
  getTermEntry,
  getYaoEntry,
  listFangByBook,
} from "@/server/catalog/entries";
import {
  findYaoRefByName,
  loadFangRefsForBook,
  normalizeYaoName,
} from "@/server/catalog/refs";
import {loadFrontSite, shouldHideFrontSite} from "@/server/catalog/site";
import {buildSitemapXml, listSitemapEntries} from "@/server/catalog/sitemap";
import type {TcmMarkerStyle} from "@/shared/TcmMarkers";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const read = (relative: string): string =>
  readFileSync(path.join(repositoryRoot, relative), "utf8");
const present = (relative: string): boolean =>
  existsSync(path.join(repositoryRoot, relative));

/** 只认重定向语义里的 301；尺寸、数值字面量不参与判定。 */
const REDIRECT_301 =
  /(?:\bredirect\b|\bstatus\b)[^\n]{0,80}\b301\b|\b301\b[^\n]{0,80}(?:\bredirect\b|\bstatus\b)/iu;

const STYLES: TcmMarkerStyle[] = [
  {code: "f", color: "#a23", smallFont: false, smallFontScale: 0.7, linkType: 2},
  {code: "u", color: "#2a7", smallFont: false, smallFontScale: 0.7, linkType: 1},
];

/** 只建模块实际读到的列；deleted_at 用 NULL / 时间戳表达软删。 */
function emptyDatabase(): D1Database {
  const database = makeSqlite(`
    CREATE TABLE settings (category TEXT PRIMARY KEY, data TEXT);
    CREATE TABLE ext_annotation_markers (
      code TEXT, color TEXT, small_font INTEGER,
      small_font_scale REAL NOT NULL DEFAULT 0.7, link_type INTEGER, sort_order INTEGER
    );
    CREATE TABLE book_info (
      id TEXT PRIMARY KEY, book_name TEXT, image_url TEXT, author TEXT,
      comment TEXT, case_division TEXT, book_no TEXT, hot_book INTEGER,
      updated_at TEXT, deleted_at TEXT
    );
    CREATE TABLE book_chapter (
      id TEXT PRIMARY KEY, source_book_id TEXT, chapter_header TEXT,
      chapter_no INTEGER, updated_at TEXT, deleted_at TEXT
    );
    CREATE TABLE book_chapter_body (
      id TEXT PRIMARY KEY, book_chapter_id TEXT, section_text TEXT,
      section_note TEXT, bencao_yao_name TEXT, receipt_no INTEGER, deleted_at TEXT
    );
    CREATE TABLE fang_yao (
      id TEXT PRIMARY KEY, fang_no INTEGER, fang_name TEXT, fang_text TEXT,
      fang_drink_num TEXT, source_book_legacy_id TEXT,
      updated_at TEXT, deleted_at TEXT
    );
    CREATE TABLE fang_yao_body (
      fang_yao_id TEXT, position INTEGER, show_name TEXT,
      amount TEXT, extra_process TEXT, deleted_at TEXT
    );
    CREATE TABLE zhong_yao (
      id TEXT PRIMARY KEY, zhong_yao_no INTEGER, zhong_yao_name TEXT,
      zhong_yao_bei_ming TEXT, zhong_yao_text TEXT, zhong_yao_list TEXT,
      updated_at TEXT, deleted_at TEXT
    );
    CREATE TABLE ming_ci (
      id TEXT PRIMARY KEY, ming_ci_no INTEGER, ming_ci_name TEXT,
      ming_ci_bei_ming TEXT, ming_ci_text TEXT, ming_ci_list TEXT,
      source_book_id TEXT, show_image TEXT, updated_at TEXT, deleted_at TEXT
    );
  `);
  database.exec(`
    INSERT INTO settings (category, data) VALUES
      ('book_groups', '{"groups":[{"key":"shanghan","label":"伤寒金匮","sort":0},{"key":"bencao","label":"本草","sort":1}]}');
    INSERT INTO ext_annotation_markers
      (code, color, small_font, small_font_scale, link_type, sort_order) VALUES
      ('u', '#2a7', 0, 0.7, 1, 0), ('f', '#a23', 0, 0.7, 2, 1);
    INSERT INTO book_info
      (id, book_name, image_url, author, comment, case_division, book_no, hot_book, updated_at, deleted_at) VALUES
      ('BOOK1', '伤寒论', '/cover-1.png', '张仲景', '按语。', 'shanghan', '1', 0, '2026-11-06 13:00:04', NULL),
      ('BOOK2', '金匮要略', '/cover-2.png', '张仲景', '按语二。', 'bencao', '2', 1, NULL, NULL),
      ('BOOK3', '已软删的书', '', '', '', 'shanghan', '3', 0, NULL, '2026-11-07 00:00:00');
    INSERT INTO book_chapter
      (id, source_book_id, chapter_header, chapter_no, updated_at, deleted_at) VALUES
      ('C2', 'BOOK1', '辨太阳病脉证并治（下）', 2, '2026-11-06 13:00:04', NULL),
      ('C1', 'BOOK1', '辨太阳病脉证并治（上）', 1, NULL, NULL),
      ('C3', 'BOOK3', '孤儿卷', 1, NULL, NULL);
    INSERT INTO book_chapter_body
      (id, book_chapter_id, section_text, section_note, bencao_yao_name, receipt_no, deleted_at) VALUES
      ('S2', 'C1', '  第二条。  $u{桂枝}', ' 别书注 $f{桂枝汤}', NULL, 2, NULL),
      ('S1', 'C1', '第一条。\n', '【本草注】$u{人参}', '人参', 1, NULL),
      ('S3', 'C1', '第三条。', '', NULL, 3, '2026-11-07 00:00:00');
    INSERT INTO fang_yao
      (id, fang_no, fang_name, fang_text, fang_drink_num, source_book_legacy_id, updated_at, deleted_at) VALUES
      ('F2', 2, '桂枝汤', '$u{桂枝}三两。', '3', '1', NULL, NULL),
      ('F1', 1, '吴茱萸汤', '$u{吴茱萸}一升。', '', '1', '2026-11-06 13:00:04', NULL),
      ('F3', 1, '宋版独有名方', '', '', '2', NULL, NULL),
      ('F4', 9, '已软删方', '', '', '1', NULL, '2026-11-07 00:00:00');
    INSERT INTO fang_yao_body
      (fang_yao_id, position, show_name, amount, extra_process, deleted_at) VALUES
      ('F1', 2, '人参', '三两', '', NULL),
      ('F1', 1, '吴茱萸', '一升', '炮', NULL);
    INSERT INTO zhong_yao
      (id, zhong_yao_no, zhong_yao_name, zhong_yao_bei_ming, zhong_yao_text, zhong_yao_list, updated_at, deleted_at) VALUES
      ('Y1', 1, '吴茱萸', '吴萸', '吴茱萸正文。', '["别名"]', '2026-11-06 13:00:04', NULL),
      ('Y2', 2, '已软删药', '', '', '', NULL, '2026-11-07 00:00:00');
    INSERT INTO ming_ci
      (id, ming_ci_no, ming_ci_name, ming_ci_bei_ming, ming_ci_text, ming_ci_list,
       source_book_id, show_image, updated_at, deleted_at) VALUES
      ('M1', 1, '太阳病', '太阳', '$m{按}merged。', '["x"]', 'BOOK1', '/m1.png', NULL, NULL),
      ('M2', 2, '别书名词', '', '', '', 'BOOK2', '', NULL, NULL);
  `);
  return makeD1(database);
}

describe("§2.2 正文分流与转义", () => {
  it("bencao_yao_name 非空才拼 section_note", () => {
    expect(sectionText({
      section_text: "第一条。\n",
      section_note: "【本草注】$u{人参}",
      bencao_yao_name: "人参",
    })).toBe("第一条。\n【本草注】$u{人参}");
    expect(sectionText({
      section_text: "  第二条。  $u{桂枝}",
      section_note: " 别书注 $f{桂枝汤}",
      bencao_yao_name: null,
    })).toBe("  第二条。  $u{桂枝}");
  });

  it("不 trim、不归一换行、不折叠空白（ADR-0062 D7 格式保真）", () => {
    const text = sectionText({
      section_text: "  行一。\n  行二。 ",
      section_note: "",
      bencao_yao_name: null,
    });
    expect(text).toBe("  行一。\n  行二。 ");
    expect(renderBodySource(text)).toBe("<p>  行一。\n  行二。 </p>");
  });

  it("bodySource 保留标记字面，bodyHtml 先转义再渲染", () => {
    const source = renderBodySource("用 $f{桂枝汤} 与 <b>标签</b>。");
    expect(source).toContain("$f{桂枝汤}");
    expect(source).toContain("&lt;b&gt;");

    const html = renderBodyHtml("用 $f{桂枝汤} 与 <b>标签</b>。", STYLES);
    expect(html).toContain('class="mf-mk mf-mk-f"');
    expect(html).not.toContain("$f{");
    expect(html).toContain("&lt;b&gt;");
    // 样式目录为空时不半吊子渲染
    expect(renderBodyHtml("用 $f{桂枝汤}。", [])).toBe("<p>用 $f{桂枝汤}。</p>");
  });
});

describe("分类与书本取数形状", () => {
  it("分类键来自 settings.book_groups，书本数按 book_info.case_division 聚合（只算公开书）", async () => {
    const db = emptyDatabase();
    expect(await listGroups(db)).toEqual([
      {key: "shanghan", label: "伤寒金匮", bookCount: 1},
      {key: "bencao", label: "本草", bookCount: 0},
    ]);
    expect(await getGroupByKey(db, "bencao")).toEqual({
      key: "bencao", label: "本草", bookCount: 0,
    });
  });

  it("未知 slug 返回 null，调用方直接 404，不回查旧分类表", async () => {
    const db = emptyDatabase();
    expect(await getGroupByKey(db, "feed-zh")).toBeNull();
  });

  it("书列表只认 deleted_at IS NULL 且 hot_book = 0（公开），url 指向 /book/<id>/", async () => {
    const db = emptyDatabase();
    const books = await listAllBooks(db);
    expect(books.map((book) => book.id)).toEqual(["BOOK1"]);
    expect(books[0]).toMatchObject({
      id: "BOOK1", title: "伤寒论", image: "/cover-1.png",
      author: "张仲景", description: "按语。", caseDivision: "shanghan",
      url: "/book/BOOK1/",
    });
    expect((await listBooksByGroup(db, "shanghan")).map((book) => book.id))
      .toEqual(["BOOK1"]);
    expect(await getBookInfoById(db, "BOOK2")).toBeNull();
    expect(await getBookInfoById(db, "BOOK3")).toBeNull();
    expect(await getBookNoById(db, "BOOK1")).toBe("1");
    expect(await getBookNoById(db, "BOOK3")).toBeNull();
  });
});

describe("卷章与条文", () => {
  it("卷按 chapter_no、条文按 receipt_no 排序，软删行不出现", async () => {
    const db = emptyDatabase();
    expect((await listVolumesByBook(db, "BOOK1")).map((volume) => volume.id))
      .toEqual(["C1", "C2"]);

    const volume = await getVolumeWithSections(db, "C1");
    expect(volume?.name).toBe("辨太阳病脉证并治（上）");
    expect(volume?.sections.map((row: CatalogSectionRow) => row.id))
      .toEqual(["S1", "S2"]);
  });

  it("同一条原文派生 bodyHtml 与 bodySource，本草行才带 note", async () => {
    const db = emptyDatabase();
    const volume = await getVolumeWithSections(db, "C1");
    const [first, second] = volume?.sections ?? [];
    expect(first?.bodySource).toContain("【本草注】$u{人参}");
    expect(first?.bodyHtml).not.toContain("$u{");
    expect(second?.bodySource).not.toContain("别书注");
    expect(second?.bodyHtml).not.toContain("别书注");
    expect(await getVolumeWithSections(db, "NOPE")).toBeNull();
  });
});

describe("三条条目路由与书页附录", () => {
  it("中药 / 方剂 / 名词各自单表点查，软删不命中", async () => {
    const db = emptyDatabase();
    const yao = await getYaoEntry(db, "Y1");
    expect(yao).toMatchObject({kind: "yao", name: "吴茱萸", alias: "吴萸"});
    expect(yao?.listRaw).toBe('["别名"]');
    expect(await getYaoEntry(db, "Y2")).toBeNull();

    const fang = await getFangEntry(db, "F1");
    expect(fang).toMatchObject({kind: "fang", name: "吴茱萸汤", drinkNum: ""});
    // 所属书按 book_no = source_book_legacy_id 反查，不读 source_book_name
    expect(fang?.bookId).toBe("BOOK1");
    expect(fang?.bookName).toBe("伤寒论");
    expect(fang?.bodies.map((body) => body.showName)).toEqual(["吴茱萸", "人参"]);
    expect(await getFangEntry(db, "F4")).toBeNull();

    const term = await getTermEntry(db, "M1");
    expect(term).toMatchObject({kind: "term", name: "太阳病", bookId: "BOOK1"});
    // $m{} 原样保留，不解析
    expect(term?.textSource).toContain("$m{按}");
  });

  it("书页「附：方剂」区块按新表取数并限定书，目录不再列名词", async () => {
    const db = emptyDatabase();
    const fang = await listFangByBook(db, "BOOK1");
    expect(fang.map((entry) => entry.id)).toEqual(["F1", "F2"]);
    expect(await listFangByBook(db, "BOOK3")).toEqual([]);
    // 组件保留方剂附录，链接指向新条目路由；名词区块已从目录删除（正文 $g 标记仍在卷页渲染）
    const detail = read("src/components/front/BookDetail.astro");
    expect(detail).toContain("附：方剂");
    expect(detail).toContain("/fang-yao/${entry.id}/");
    expect(detail).not.toContain("名词");
    expect(detail).not.toContain("/ming-ci/");
  });
});

describe("D5-A 方剂按书解析 / 中药按名解析", () => {
  it("loadFangRefsForBook 只返回当前书的方，同名书外方不进 map", async () => {
    const db = emptyDatabase();
    const refs = await loadFangRefsForBook(db, "BOOK1");
    expect([...refs.keys()]).toEqual(["吴茱萸汤", "桂枝汤"]);
    expect(refs.get("吴茱萸汤")).toEqual({
      id: "F1", name: "吴茱萸汤", url: "/fang-yao/F1/",
    });
    expect(refs.has("宋版独有名方")).toBe(false);
    expect(refs.has("已软删方")).toBe(false);
    expect((await loadFangRefsForBook(db, "BOOK3")).size).toBe(0);
  });

  it("findYaoRefByName 归一序号前缀与炮制注，全局按名查", async () => {
    const db = emptyDatabase();
    expect(normalizeYaoName("63、吴茱萸(炮)")).toBe("吴茱萸");
    expect(await findYaoRefByName(db, "63、吴茱萸(炮)")).toEqual({
      id: "Y1", name: "吴茱萸", url: "/zhongyao/Y1/",
    });
    expect(await findYaoRefByName(db, "已软删药")).toBeNull();
  });

  it("SQL 里必须带书作用域，禁止按名全表匹配", () => {
    expect(read("src/server/catalog/refs.ts"))
      .toContain("source_book_legacy_id = ?");
    expect(read("src/server/catalog/entries.ts"))
      .toContain("source_book_legacy_id = ?");
  });
});

describe("站点外壳与 sitemap", () => {
  it("4 个站壳字段来自 settings.webGlobalSettings，导航真源是 pages 服务", async () => {
    const database = makeSqlite(`
      CREATE TABLE settings (category TEXT PRIMARY KEY, data TEXT);
      CREATE TABLE pages (
        id TEXT PRIMARY KEY, slug TEXT, title TEXT, navigation_label TEXT,
        navigation_order INTEGER, status INTEGER, show_in_navigation INTEGER,
        created_at TEXT, updated_at TEXT, published_at TEXT, meta_description TEXT,
        content_html TEXT, content_text TEXT
      );
    `);
    database.exec(`
      INSERT INTO settings (category, data) VALUES
        ('webGlobalSettings', '${JSON.stringify({
          siteTitle: "中医书架",
          favicon: {url: "/assets/default/favicon.png"},
          language: "zh-CN",
          description: "<p>站点描述</p>",
          copyright: "© {{current_year}} 出版方",
          publisher: "出版方",
        })}'),
        ('access', '{"currentPolicy":"public"}');
    `);
    // 夹具建了 pages 表，navigationPages 正常返回空导航；不靠吞错伪造结果。
    const site = await loadFrontSite(
      makeD1(database),
      new Request("https://example.com/"),
    );
    expect(site.title).toBe("中医书架");
    expect(site.language).toBe("zh-CN");
    expect(site.description).toBe("站点描述");
    expect(site.publisher).toBe("出版方");
    expect(site.copyright).toContain(String(new Date().getUTCFullYear()));
    expect(site.copyright).not.toContain("{{");
    expect(site.faviconUrl).toContain("/assets/default/favicon.png");
    expect(site.navPages).toEqual([]);
    expect(site.accessPolicy).toBe("public");
    expect(shouldHideFrontSite(site)).toBe(false);
    expect(shouldHideFrontSite({...site, accessPolicy: "headless"})).toBe(true);
    expect(shouldHideFrontSite({...site, accessPolicy: "offline"})).toBe(true);

    expect(read("src/server/catalog/site.ts")).toContain("navigationPages(db, request)");
    expect(read("src/server/pages/service.ts")).toContain("FROM pages");
  });

  it("缺 settings 行时回落成默认值，不抛错", async () => {
    const database = makeSqlite(`
      CREATE TABLE settings (category TEXT PRIMARY KEY, data TEXT);
      CREATE TABLE pages (
        id TEXT PRIMARY KEY, slug TEXT, title TEXT, navigation_label TEXT,
        navigation_order INTEGER, status INTEGER, show_in_navigation INTEGER,
        created_at TEXT, updated_at TEXT, published_at TEXT, meta_description TEXT,
        content_html TEXT, content_text TEXT
      );
    `);
    const site = await loadFrontSite(
      makeD1(database),
      new Request("https://example.com/"),
    );
    expect(site.title).toBe("microfeed");
    expect(site.language).toBe("zh-CN");
    expect(site.description).toBe("");
    expect(site.faviconUrl).toBe("");
    expect(site.accessPolicy).toBe("public");
  });

  it("sitemap 只列新地址与未软删行，且输出合法 XML 外壳", async () => {
    const db = emptyDatabase();
    const entries = await listSitemapEntries(db, "https://example.com");
    const locs = entries.map((entry) => entry.loc);
    expect(locs).toContain("https://example.com/");
    expect(locs).toContain("https://example.com/category/shanghan/");
    expect(locs).toContain("https://example.com/book/BOOK1/");
    expect(locs).toContain("https://example.com/book/BOOK1/v/C1/");
    expect(locs).toContain("https://example.com/fang-yao/F1/");
    expect(locs).toContain("https://example.com/zhongyao/Y1/");
    expect(locs).toContain("https://example.com/ming-ci/M1/");
    expect(locs.some((loc) => loc.includes("/book/BOOK3/"))).toBe(false);
    expect(locs.some((loc) => loc.includes("/book/BOOK2/"))).toBe(false);
    expect(locs.some((loc) => loc.includes("/v/C3/"))).toBe(false);
    expect(locs.some((loc) => loc.includes("/i/"))).toBe(false);
    expect(entries.find((entry) => entry.loc.endsWith("/book/BOOK1/"))?.lastmod)
      .toBe("2026-11-06T13:00:04Z");

    const xml = await buildSitemapXml(db, "https://example.com");
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain("<urlset xmlns=");
    expect(xml.match(/<url>/gu)?.length).toBe(entries.length);
  });
});

const FRONT_ROUTES = [
  "src/pages/index.astro",
  "src/pages/category/[slug]/index.astro",
  "src/pages/book/[id]/index.astro",
  "src/pages/book/[id]/v/[volumeId]/index.astro",
  "src/pages/zhongyao/[id]/index.astro",
  "src/pages/fang-yao/[id]/index.astro",
  "src/pages/ming-ci/[id]/index.astro",
];

const RETIRED_ROUTES = [
  "src/pages/i/[slug]/index.astro",
  "src/pages/rss/index.ts",
  "src/pages/json/index.ts",
  "src/pages/llms.txt.ts",
  "src/pages/[...path].astro",
];

describe("D1 裁决 A：旧地址一律 404，不是 301", () => {
  it("七条前台路由都用 404 口径，源码里没有 301 与 /i/ 链接", () => {
    for (const route of FRONT_ROUTES) {
      expect(present(route)).toBe(true);
      const source = read(route);
      expect(source).toContain("Astro.response.status = 404");
      expect(source).not.toMatch(REDIRECT_301);
      expect(source).not.toMatch(/["'`]\/i\//u);
    }
  });

  it("旧出口文件已退场，且不建映射表 / 不补 legacy_item_id", () => {
    for (const route of RETIRED_ROUTES) {
      expect(present(route)).toBe(false);
    }
    const catalogSources = [
      "groups", "books", "chapters", "entries", "refs", "site", "sitemap",
    ].map((name) => read(`src/server/catalog/${name}.ts`)).join("\n");
    expect(catalogSources).not.toContain("legacy_item_id");
    expect(catalogSources).not.toContain("301");
  });

  it("catalog 的 SQL 只认 deleted_at IS NULL 加 hot_book = 0，不把 is_enable / 频道状态当发布判据", () => {
    const catalogSources = [
      "groups", "books", "chapters", "entries", "refs", "site", "sitemap",
    ].map((name) => read(`src/server/catalog/${name}.ts`).replace(/\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "")).join("\n");
    expect(catalogSources).not.toContain("is_enable");
    expect(catalogSources).toContain("hot_book");
    expect(catalogSources).toContain("deleted_at IS NULL");
  });
});

describe("§8 引用解析基线（固定语料口径复算）", () => {
  it("三种拼接口径给出三个不同结果，只有 §2.2 分流是本次渲染口径", () => {
    // 固定小语料：一行本草（note 里有 $u）、一行非本草（note 里有 $f）。
    // 真实全量语料的 1,534/1,585 与 44/57 由 .scratch/catalog-audit/ 的只读探针复算，
    // 测试不依赖该临时目录，也不把数字硬编成第二份真源。
    const rows = [
      {section_text: "$u{人参}", section_note: "$u{桂枝}", bencao_yao_name: "人参"},
      {section_text: "$f{吴茱萸汤}", section_note: "$f{桂枝汤}", bencao_yao_name: null},
    ];
    const count = (text: string, code: string): number =>
      (text.match(new RegExp(`\\$${code}\\{`, "gu")) ?? []).length;
    const stOnly = rows.map((row) => row.section_text).join("");
    const stSn = rows.map((row) => row.section_text + row.section_note).join("");
    const routed = rows.map((row) => sectionText(row)).join("");

    const results = [stOnly, stSn, routed].map(
      (text) => count(text, "f") + count(text, "u"),
    );
    expect(new Set(results).size).toBe(3);
    expect(results[0]).toBeLessThan(results[2]!);
    expect(results[2]).toBeLessThan(results[1]!);
    expect(routed).toBe("$u{人参}$u{桂枝}$f{吴茱萸汤}");
  });
});
