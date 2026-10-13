import {describe, expect, it} from "vitest";
import {DatabaseSync} from "node:sqlite";

import {
  buildTcmMarkerLayer,
  type TcmMarkerLayer,
  type TcmPopoverEntry,
} from "@/server/tcm/markerPopover";

// Marker styles backing the renderer. `code` selects the marker type;
// `link_type` 2 = 方剂 (resolved in-book), 1 = 中药 (resolved globally by pure
// name), 0 = small-font annotation only. These mirror the ext_annotation_markers
// rows seeded into the real DB below.
const STYLES = [
  {code: "u", color: "#2a7", small_font: 0, small_font_scale: 0.7, link_type: 1},
  {code: "f", color: "#a23", small_font: 0, small_font_scale: 0.7, link_type: 2},
  // 不是默认 0.7 —— 覆盖 0109 起由后台配置的缩小比例
  {code: "w", color: "#888", small_font: 1, small_font_scale: 0.55, link_type: 0},
];

interface FangRow { id: string; data: any; }
interface YaoRow { id: string; data: any; }
interface SectionRow {
  id: string;
  book_id: string;
  data: any;
  /** `tcm_kind`；默认 `section`。0111 的重算扫 `section` 与 `chapter` 两类。 */
  kind?: string;
}

// D1-shaped adapter over an in-memory node:sqlite database. It runs the REAL SQL
// the production code issues (json_extract / substr / instr), so the test exercises
// the actual query contract instead of faking it. No mocks (AGENTS.md:685).
function makeD1(database: DatabaseSync): D1Database {
  function statement(sql: string, values: unknown[]) {
    return {
      bind(...v: unknown[]) { return statement(sql, v); },
      async all() {
        return {
          results: database.prepare(sql).all(...(values as any[])) as Record<string, unknown>[],
        };
      },
      async first() {
        const rows = database.prepare(sql).all(...(values as any[])) as Record<string, unknown>[];
        return rows[0] ?? null;
      },
      async run() {
        database.prepare(sql).run(...(values as any[]));
        return {success: true} as any;
      },
    };
  }
  return {
    prepare(sql: string) { return statement(sql, []); },
    // D1 的 batch 是单事务全成或全回滚。这里用显式事务复刻，好让断言能看到
    // 「中途失败 ⇒ 时间戳仍是 0」这一 `ensureMarkerCitations` 依赖的性质。
    async batch(list: any[]) {
      database.exec("BEGIN");
      try {
        const out = list.map((s) => s.run());
        database.exec("COMMIT");
        return out;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

// Build a real, in-memory D1-backed database: an `items` table (fang/yao/section)
// plus `ext_annotation_markers`. Rows are inserted as the JSON strings the
// production schema stores, so json_extract works exactly as on Cloudflare D1.
function makeRealDb(
  fangRows: FangRow[],
  yaoRows: YaoRow[],
  sectionRows: SectionRow[] = [],
): D1Database {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      tcm_kind TEXT,
      status INTEGER,
      book_id TEXT
    );
    CREATE TABLE ext_annotation_markers (
      code TEXT,
      title TEXT,
      color TEXT,
      small_font INTEGER,
      small_font_scale REAL NOT NULL DEFAULT 0.7,
      link_type INTEGER,
      sort_order INTEGER
    );
    -- 0111：标注引用物化表。列名/主键与该迁移逐字一致，否则真实 SQL 会在
    -- 这里报 no such table / no such column。
    CREATE TABLE ext_marker_citations (
      book_id TEXT NOT NULL,
      marker_code TEXT NOT NULL,
      marker_name TEXT NOT NULL,
      section_id TEXT NOT NULL,
      section_title TEXT NOT NULL DEFAULT '',
      section_seq INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (book_id, marker_code, marker_name, section_id)
    );
    CREATE INDEX ext_marker_citations_lookup
      ON ext_marker_citations (book_id, marker_code, marker_name, section_seq);
    CREATE TABLE ext_marker_citation_state (
      book_id TEXT PRIMARY KEY,
      computed_at_ms INTEGER NOT NULL DEFAULT 0
    );
    -- 0111 的三个失效触发器。逐字照抄迁移，否则「写入 → 标脏 → 懒自举重算」
    -- 这条链路在测试里根本不存在（本文件此前只建表，所以脏标路径从未被执行）。
    CREATE TRIGGER ext_marker_citations_dirty_on_insert
    AFTER INSERT ON items
    BEGIN
      UPDATE ext_marker_citation_state SET computed_at_ms = 0
       WHERE book_id = COALESCE(json_extract(NEW.data, '$._microfeed.sourceBookId'), NEW.book_id);
    END;
    CREATE TRIGGER ext_marker_citations_dirty_on_update
    AFTER UPDATE ON items
    BEGIN
      UPDATE ext_marker_citation_state SET computed_at_ms = 0
       WHERE book_id IN (
         COALESCE(json_extract(OLD.data, '$._microfeed.sourceBookId'), OLD.book_id),
         COALESCE(json_extract(NEW.data, '$._microfeed.sourceBookId'), NEW.book_id)
       );
    END;
    CREATE TRIGGER ext_marker_citations_dirty_on_delete
    AFTER DELETE ON items
    BEGIN
      UPDATE ext_marker_citation_state SET computed_at_ms = 0
       WHERE book_id = COALESCE(json_extract(OLD.data, '$._microfeed.sourceBookId'), OLD.book_id);
    END;
  `);
  const ins = database.prepare(
    "INSERT INTO items (id, data, tcm_kind, status, book_id) VALUES (?, ?, ?, ?, ?)",
  );
  for (const r of fangRows) {
    ins.run(r.id, JSON.stringify(r.data), "fang", 1, String(r.data._microfeed?.sourceBookId ?? ""));
  }
  for (const r of yaoRows) {
    ins.run(r.id, JSON.stringify(r.data), "yao", 1, null);
  }
  for (const r of sectionRows) {
    ins.run(r.id, JSON.stringify(r.data), r.kind ?? "section", 1, r.book_id);
  }
  const mins = database.prepare(
    "INSERT INTO ext_annotation_markers (code, title, color, small_font, small_font_scale, link_type, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  STYLES.forEach((s, i) =>
    mins.run(s.code, "", s.color, s.small_font, s.small_font_scale, s.link_type, i),
  );

  return makeD1(database);
}

const FANG = (
  id: string,
  name: string,
  no: number,
  sourceBookId: string,
  description: string,
  yaoCount: number,
  fangYaoList: unknown[],
): FangRow => ({
  id,
  data: {title: name, description, _microfeed: {sourceBookId, no, yaoCount, fangYaoList}},
});
const YAO = (id: string, title: string, description: string, aliases: unknown[]): YaoRow => ({
  id, data: {title, description, _microfeed: {aliases}},
});
const SECTION = (id: string, title: string, description: string, bookId: string): SectionRow => ({
  id, book_id: bookId, data: {title, description},
});
/** 篇章行：重算扫 `tcm_kind IN ('section','chapter')`，两类都要有覆盖。 */
const CHAPTER = (id: string, title: string, description: string, bookId: string): SectionRow => ({
  id, book_id: bookId, kind: "chapter", data: {title, description},
});

/** The popover payload the runtime ships in `<script type="application/json" id="mf-tcm-data">`. */
function popoverData(layer: TcmMarkerLayer): Record<string, TcmPopoverEntry> {
  const raw = (layer.runtimeHtml ?? "").split('id="mf-tcm-data">')[1] ?? "{}";
  return JSON.parse(raw.split("</script>")[0] ?? "{}") as Record<string, TcmPopoverEntry>;
}

/**
 * 参照实现：**被替换掉的那个算法**（ADR-0025 D6）—— 读整本书的条文、把 `$f{方名}`
 * 当字面量子串匹配、按 rowid 顺序、按条文去重、上限 50 条。
 *
 * 特意留在这里：生产实现改成从 `ext_marker_citations` 取数之后，仓库里再没有别的地方
 * 能判断两者是否还一致 —— 这个测试就是那道守卫。
 */
function legacyReferences(
  sectionRows: SectionRow[],
  bookId: string,
  markerCode: string,
  name: string,
): Array<{id: string; title: string}> {
  const needle = `$${markerCode}{${name}}`;
  const out: Array<{id: string; title: string}> = [];
  const seen = new Set<string>();
  for (const row of sectionRows) {
    if (row.book_id !== bookId) continue;
    if (!String(row.data.description ?? "").includes(needle)) continue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push({id: row.id, title: String(row.data.title ?? "")});
    if (out.length >= 50) break;
  }
  return out;
}

describe("buildTcmMarkerLayer", () => {
  it("resolves in-book 方剂 and global 中药, and collects nested markers", async () => {
    const fangRows = [
      // 同名两首：no=1 应胜出（取更完整者）
      FANG("F1", "吴茱萸汤", 1, "BOOK1", "组成：$u{人参}$w{三两}。", 2, [
        {showName: "吴茱萸", amount: "一升", suffix: "", extraProcess: ""},
        {showName: "人参", amount: "三两", suffix: "", extraProcess: ""},
      ]),
      FANG("F2", "吴茱萸汤", 9, "BOOK1", "组成：$u{人参}。", 1, [
        {showName: "人参", amount: "二两", suffix: "", extraProcess: ""},
      ]),
      // 另一本书的同名方：不应被当前书解析到
      FANG("F3", "桂枝汤", 1, "OTHERBOOK", "组成：$u{桂枝}。", 1, []),
    ];
    const yaoRows = [
      YAO("Y1", "1、吴茱萸", "吴茱萸正文。", [{bieming: "吴萸", name: "吴茱萸"}]),
      YAO("Y2", "2、人参", "人参正文。", []),
      YAO("Y3", "3、桂枝", "桂枝正文。", []),
    ];
    const db = makeRealDb(fangRows, yaoRows);

    const bodyHtml =
      "<p>用 $f{吴茱萸汤} 与 $u{吴茱萸} 治之。</p>";
    const layer = await buildTcmMarkerLayer(db, {
      bodyHtml,
      title: "第九条",
      currentBookId: "BOOK1",
    });

    // Body: both in-scope markers become anchors.
    expect(layer.bodyHtml).toContain('<a href="/i/F1/"');
    expect(layer.bodyHtml).toContain('<a href="/i/Y1/"');
    // Out-of-book 方剂 degrades to a plain span (no href).
    expect(layer.bodyHtml).not.toContain('<a href="/i/F3/"');

    // Popover data: F1 (not F2) wins the same-name; Y1 immediate; Y2 reached
    // through F1's body marker.
    const data = popoverData(layer);
    expect(Object.keys(data).sort()).toEqual(["F1", "Y1", "Y2"]);
    expect(data.F1!.kind).toBe("fang");
    expect(data.F1!.yao?.map((y) => y.name)).toContain("人参");
    // F1's rendered body should carry a clickable 人参 link (nested collection).
    expect(data.F1!.body).toContain('<a href="/i/Y2/"');
    expect(data.Y1!.meta).toBe("别名 吴萸");

    // Runtime HTML carries the dialog + handler.
    expect(layer.runtimeHtml).toContain('id="mf-tcm-dialog"');
    expect(layer.titleHtml).toBe("第九条");
  });

  it("falls back to plain content_html for non-TCM items", async () => {
    const db = makeRealDb([], []);
    const bodyHtml = "<p>no markers here</p>";
    const layer = await buildTcmMarkerLayer(db, {
      bodyHtml,
      title: "Plain",
      currentBookId: null,
    });
    expect(layer.bodyHtml).toBe(bodyHtml);
    expect(layer.titleHtml).toBeNull();
    expect(layer.runtimeHtml).toBeNull();
  });

  it("emits no runtime when the body has no entity markers", async () => {
    const db = makeRealDb([], []);
    const bodyHtml = "<p>只有 $w{三两} 没有实体标记</p>";
    const layer = await buildTcmMarkerLayer(db, {
      bodyHtml,
      title: "X",
      currentBookId: "BOOK1",
    });
    expect(layer.runtimeHtml).toBeNull();
  });

  it("lists 条文 citing a 方剂 in the same book (cross-reference)", async () => {
    const fangRows = [
      FANG("F1", "吴茱萸汤", 1, "BOOK1", "组成：$u{人参}。", 1, []),
      FANG("F2", "桂枝汤", 1, "OTHERBOOK", "组成：$u{桂枝}。", 1, []),
    ];
    const yaoRows: YaoRow[] = [];
    const sectionRows = [
      SECTION("S1", "第九条", "干呕吐涎沫，$f{吴茱萸汤}主之。", "BOOK1"),
      SECTION("S2", "第十条", "少阴病，$f{吴茱萸汤}主之。", "BOOK1"),
      SECTION("S3", "别书", "$f{吴茱萸汤}在别书。", "OTHERBOOK"), // 跨书排除
      SECTION("S4", "无引用", "太阳病，发汗。", "BOOK1"),
    ];
    const db = makeRealDb(fangRows, yaoRows, sectionRows);
    const layer = await buildTcmMarkerLayer(db, {
      bodyHtml: "<p>用 $f{吴茱萸汤} 治之。</p>",
      title: "论吴茱萸汤",
      currentBookId: "BOOK1",
    });
    const data = popoverData(layer);
    const refs = data.F1!.references ?? [];
    expect(refs.map((r) => r.id).sort()).toEqual(["S1", "S2"]);
    expect(refs.some((r) => r.id === "S3")).toBe(false);
    expect(layer.runtimeHtml).toContain("引用此方剂的条文");
  });

  it("agrees with the substring scan it replaced, including the 50-row cap", async () => {
    const fangRows = [FANG("F1", "吴茱萸汤", 1, "BOOK1", "组成：$u{人参}。", 1, [])];
    // 篇章行放最前：重算扫 section + chapter 两类，放在 50 条之内才能被观测到。
    const sectionRows: SectionRow[] = [
      CHAPTER("C1", "辨太阳病脉证并治（上）第五", "此篇亦用 $f{吴茱萸汤}。", "BOOK1"),
    ];
    for (let i = 0; i < 60; i += 1) {
      sectionRows.push(SECTION(`S${String(i).padStart(2, "0")}`, `第${i}条`, "服 $f{吴茱萸汤}。", "BOOK1"));
    }
    sectionRows.push(SECTION("DUP", "重复提及", "$f{吴茱萸汤}……又 $f{吴茱萸汤}。", "BOOK1"));
    sectionRows.push(SECTION("OTHER", "别书", "$f{吴茱萸汤}。", "OTHERBOOK"));
    sectionRows.push(SECTION("NONE", "无关", "太阳病，发汗。", "BOOK1"));

    const db = makeRealDb(fangRows, [], sectionRows);
    const layer = await buildTcmMarkerLayer(db, {
      bodyHtml: "<p>用 $f{吴茱萸汤} 治之。</p>",
      title: "论吴茱萸汤",
      currentBookId: "BOOK1",
    });

    const got = (popoverData(layer).F1!.references ?? []).map((r) => ({id: r.id, title: r.title}));
    const want = legacyReferences(sectionRows, "BOOK1", "f", "吴茱萸汤");

    // 逐条比对：顺序、id、title 都要一样（上限 50 条也要一样）
    expect(want).toHaveLength(50);
    expect(got).toEqual(want);
    // 篇章行也在索引里（`tcm_kind='chapter'` 这一支不能漏）
    expect(want[0]!.id).toBe("C1");
  });

  it("rebuilds the index after a write, via the dirty flag (trigger + lazy recompute)", async () => {
    const fangRows = [FANG("F1", "吴茱萸汤", 1, "BOOK1", "", 1, [])];
    const sectionRows = [SECTION("S1", "第九条", "干呕吐沫，$f{吴茱萸汤}主之。", "BOOK1")];
    const db = makeRealDb(fangRows, [], sectionRows);
    const page = {
      bodyHtml: "<p>用 $f{吴茱萸汤} 治之。</p>",
      title: "论吴茱萸汤",
      currentBookId: "BOOK1",
    };
    const state = async () =>
      ((await db
        .prepare("SELECT computed_at_ms FROM ext_marker_citation_state WHERE book_id = ?")
        .bind("BOOK1")
        .first()) as {computed_at_ms: number} | null)?.computed_at_ms ?? null;

    // ① 首次渲染：建索引并盖时间戳
    expect(popoverData(await buildTcmMarkerLayer(db, page)).F1!.references?.map((r) => r.id))
      .toEqual(["S1"]);
    expect(await state()).toBeGreaterThan(0);

    // ② 模拟一次正文写入（生产走 putContent，这里直接写表）：触发器应把书标脏
    await db
      .prepare("INSERT INTO items (id, data, tcm_kind, status, book_id) VALUES (?, ?, ?, ?, ?)")
      .bind("S2", JSON.stringify({title: "第十条", description: "少阴病，$f{吴茱萸汤}主之。"}), "section", 1, "BOOK1")
      .run();
    expect(await state()).toBe(0);

    // ③ 下次渲染：懒自举重算，新条文进索引，时间戳复归
    expect(popoverData(await buildTcmMarkerLayer(db, page)).F1!.references?.map((r) => r.id))
      .toEqual(["S1", "S2"]);
    expect(await state()).toBeGreaterThan(0);
  });

  it("lists 条文 citing a 中药, matching the recompute's name normalisation", async () => {
    const fangRows: FangRow[] = [];
    const yaoRows = [YAO("Y1", "1、吴茱萸", "吴茱萸正文。", [])];
    const sectionRows = [
      // 标记里带炮制注（`(炮)`），重算时会被 normalizeYaoName 归一成「吴茱萸」
      SECTION("S1", "第九条", "干呕吐涎沫，$u{吴茱萸(炮)}主之。", "BOOK1"),
      // 不带注的同名引用，应落到同一批
      SECTION("S2", "第十条", "少阴病，$u{吴茱萸}主之。", "BOOK1"),
      SECTION("S3", "别书", "$u{吴茱萸}在别书。", "OTHERBOOK"),
      SECTION("S4", "无引用", "太阳病，发汗。", "BOOK1"),
    ];
    const db = makeRealDb(fangRows, yaoRows, sectionRows);
    const layer = await buildTcmMarkerLayer(db, {
      bodyHtml: "<p>用 $u{吴茱萸} 治之。</p>",
      title: "论吴茱萸",
      currentBookId: "BOOK1",
    });

    const data = popoverData(layer);
    const refs = data.Y1!.references ?? [];
    // 两种写法归一后指向同一味药，跨书那条被排除
    expect(refs.map((r) => r.id)).toEqual(["S1", "S2"]);
    expect(refs.some((r) => r.id === "S3")).toBe(false);
    // 标题在**客户端**按 kind 选，服务端只能把两支都发出去（它们都是 JS 源码里的字面量）。
    // 所以这是一条**源码文本断言**（本仓已有先例，如 admin-collection-shells.test.ts），
    // 只防「有人把 yao 也硬编码成『方剂』」；它**不验证实际渲染** —— 本仓 vitest 没有
    // DOM 环境（未装 jsdom/happy-dom），渲染断言做不了。
    expect(layer.runtimeHtml).toContain(
      "f.kind === 'yao' ? '引用此中药的条文' : '引用此方剂的条文'",
    );
  });
});
