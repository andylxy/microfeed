import {describe, expect, it} from "vitest";
import {DatabaseSync} from "node:sqlite";

import {buildTcmMarkerLayer, type TcmPopoverEntry} from "@/server/tcm/markerPopover";

// Marker styles backing the renderer. `code` selects the marker type;
// `link_type` 2 = 方剂 (resolved in-book), 1 = 中药 (resolved globally by pure
// name), 0 = small-font annotation only. These mirror the ext_annotation_markers
// rows seeded into the real DB below.
const STYLES = [
  {code: "u", color: "#2a7", small_font: 0, link_type: 1},
  {code: "f", color: "#a23", small_font: 0, link_type: 2},
  {code: "w", color: "#888", small_font: 1, link_type: 0},
];

interface FangRow { id: string; data: any; }
interface YaoRow { id: string; data: any; }
interface SectionRow { id: string; book_id: string; data: any; }

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
  return {prepare(sql: string) { return statement(sql, []); }} as unknown as D1Database;
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
      link_type INTEGER,
      sort_order INTEGER
    );
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
    ins.run(r.id, JSON.stringify(r.data), "section", 1, r.book_id);
  }
  const mins = database.prepare(
    "INSERT INTO ext_annotation_markers (code, title, color, small_font, link_type, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
  );
  STYLES.forEach((s, i) => mins.run(s.code, "", s.color, s.small_font, s.link_type, i));

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
    const raw = (layer.runtimeHtml ?? "").split('id="mf-tcm-data">')[1] ?? "{}";
    const data = JSON.parse(raw.split("</script>")[0] ?? "{}") as Record<string, TcmPopoverEntry>;
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
    const data = JSON.parse(
      (((layer.runtimeHtml ?? "").split('id="mf-tcm-data">')[1] ?? "{}").split("</script>")[0] ?? "{}"),
    ) as Record<string, TcmPopoverEntry>;
    const refs = data.F1!.references ?? [];
    expect(refs.map((r) => r.id).sort()).toEqual(["S1", "S2"]);
    expect(refs.some((r) => r.id === "S3")).toBe(false);
    expect(layer.runtimeHtml).toContain("引用此方剂的条文");
  });
});
