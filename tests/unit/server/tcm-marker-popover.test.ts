/**
 * 前台标注层契约（ADR-0066 决策 6 / 15，规范 §4.3 / §4.4 / §8）。
 *
 * 切源前的这份测试用 `items` + `ext_marker_citations` 夹具验证「反向引用重算」；
 * 前台改成独立模块引擎之后那套表、那套索引、那组 `/i/` 链接都不再进入取数链，
 * 所以夹具整体换成新表：book_info / fang_yao / fang_yao_body / zhong_yao /
 * ext_annotation_markers。断言相应换成三条新口径：
 *   ① 方剂按书解析（带 source_book_legacy_id），跨书同名方不命中；
 *   ② 中药全局按名解析，链接指向 /zhongyao/<id>/ 与 /fang-yao/<id>/；
 *   ③ 浮层不再有 references 分组，也不再触发反向引用重算。
 *
 * 后台反向引用视图仍复用文件末尾的 ensureMarkerCitations，那段实现保留在
 * `front-decoupling:ignore-*` 区段里，由后台自己的链路覆盖，不在本文件验证。
 * 测试只写不跑（AGENTS.md 最高指令）。
 */
import {readFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {makeD1} from "./helpers/d1";
import {
  buildTcmMarkerLayer,
  mapStyles,
  type TcmMarkerLayer,
  type TcmPopoverEntry,
} from "@/server/tcm/markerPopover";
import {renderTcmMarkers} from "@/shared/TcmMarkers";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * `link_type` 决定可链接码：2 = 方剂（按书解析）、1 = 中药（全局按名）、
 * 0 = 只上色。$z 是「后台新增一个 link_type=1 的码」的探针，验证可链接集合
 * 来自标记字典，不在测试里写死 `[fu]` 扫描。
 */
const STYLES = [
  {code: "u", color: "#2a7", small_font: 0, small_font_scale: 0.7, link_type: 1},
  {code: "f", color: "#a23", small_font: 0, small_font_scale: 0.7, link_type: 2},
  {code: "w", color: "#888", small_font: 1, small_font_scale: 0.55, link_type: 0},
  {code: "a", color: "#808080", small_font: 1, small_font_scale: 0.7, link_type: 0},
  {code: "z", color: "#2a7", small_font: 0, small_font_scale: 0.7, link_type: 1},
];

interface BookRow {id: string; bookNo: string; name: string; deletedAt?: string}
interface FangRow {
  id: string;
  no: number;
  name: string;
  bookNo: string;
  text?: string;
  drinkNum?: string;
  deletedAt?: string;
}
interface FangBodyRow {
  fangId: string;
  position: number;
  showName: string;
  amount: string;
  extra?: string;
  deletedAt?: string;
}
interface YaoRow {
  id: string;
  no: number;
  name: string;
  alias?: string;
  text?: string;
  listRaw?: string;
  deletedAt?: string;
}

/**
 * 真实 SQLite 内存库：列名取生产迁移里模块实际读到的那几列，`deleted_at`
 * 用 NULL / 时间戳字符串表达软删语义。D1 适配层在 helpers/d1.ts，生产 SQL
 * 原样跑（AGENTS.md 禁止 mock 引擎行为）。
 */
function makeRealDb(options: {
  books?: BookRow[];
  fangs?: FangRow[];
  bodies?: FangBodyRow[];
  yaos?: YaoRow[];
}): D1Database {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE ext_annotation_markers (
      code TEXT, title TEXT, color TEXT, small_font INTEGER,
      small_font_scale REAL NOT NULL DEFAULT 0.7, link_type INTEGER, sort_order INTEGER
    );
    CREATE TABLE book_info (
      id TEXT PRIMARY KEY, book_no TEXT, book_name TEXT, deleted_at TEXT
    );
    CREATE TABLE fang_yao (
      id TEXT PRIMARY KEY, fang_no INTEGER, fang_name TEXT, fang_text TEXT,
      fang_drink_num TEXT, source_book_legacy_id TEXT, deleted_at TEXT
    );
    CREATE TABLE fang_yao_body (
      fang_yao_id TEXT, position INTEGER, show_name TEXT,
      amount TEXT, extra_process TEXT, deleted_at TEXT
    );
    CREATE TABLE zhong_yao (
      id TEXT PRIMARY KEY, zhong_yao_no INTEGER, zhong_yao_name TEXT,
      zhong_yao_bei_ming TEXT, zhong_yao_text TEXT, zhong_yao_list TEXT, deleted_at TEXT
    );
  `);

  const markerInsert = database.prepare(
    "INSERT INTO ext_annotation_markers (code, color, small_font, small_font_scale, link_type, sort_order) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
  );
  STYLES.forEach((style, index) =>
    markerInsert.run(
      style.code, style.color, style.small_font,
      style.small_font_scale, style.link_type, index,
    ),
  );

  const bookInsert = database.prepare(
    "INSERT INTO book_info (id, book_no, book_name, deleted_at) VALUES (?, ?, ?, ?)",
  );
  for (const book of options.books ?? []) {
    bookInsert.run(book.id, book.bookNo, book.name, book.deletedAt ?? null);
  }

  const fangInsert = database.prepare(
    "INSERT INTO fang_yao (id, fang_no, fang_name, fang_text, fang_drink_num, " +
      "source_book_legacy_id, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const fang of options.fangs ?? []) {
    fangInsert.run(
      fang.id, fang.no, fang.name, fang.text ?? "", fang.drinkNum ?? "",
      fang.bookNo, fang.deletedAt ?? null,
    );
  }

  const bodyInsert = database.prepare(
    "INSERT INTO fang_yao_body (fang_yao_id, position, show_name, amount, " +
      "extra_process, deleted_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const body of options.bodies ?? []) {
    bodyInsert.run(
      body.fangId, body.position, body.showName, body.amount,
      body.extra ?? "", body.deletedAt ?? null,
    );
  }

  const yaoInsert = database.prepare(
    "INSERT INTO zhong_yao (id, zhong_yao_no, zhong_yao_name, zhong_yao_bei_ming, " +
      "zhong_yao_text, zhong_yao_list, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const yao of options.yaos ?? []) {
    yaoInsert.run(
      yao.id, yao.no, yao.name, yao.alias ?? "", yao.text ?? "",
      yao.listRaw ?? "", yao.deletedAt ?? null,
    );
  }

  return makeD1(database);
}

const DEFAULT_FIXTURE = (): {
  books: BookRow[];
  fangs: FangRow[];
  bodies: FangBodyRow[];
  yaos: YaoRow[];
} => ({
  books: [
    {id: "BOOK1", bookNo: "1", name: "金匮要略・人纪"},
    {id: "BOOK2", bookNo: "2", name: "宋版伤寒论"},
  ],
  fangs: [
    // 同书同名两首：fang_no 小的 F1 胜出
    {id: "F1", no: 1, name: "吴茱萸汤", bookNo: "1", text: "组成：$u{人参}$w{三两}。", drinkNum: "3"},
    {id: "F2", no: 9, name: "吴茱萸汤", bookNo: "1", text: "组成：$u{人参}。"},
    // 只在另一本书登记的同名方：正文中出现也不该被 BOOK1 解析
    {id: "F3", no: 1, name: "桂枝汤", bookNo: "2", text: "组成：$u{桂枝}。"},
  ],
  bodies: [
    {fangId: "F1", position: 1, showName: "吴茱萸", amount: "一升"},
    {fangId: "F1", position: 2, showName: "人参", amount: "三两"},
  ],
  yaos: [
    {id: "Y1", no: 1, name: "吴茱萸", alias: "吴萸", text: "吴茱萸正文。"},
    {id: "Y2", no: 2, name: "人参", text: "人参正文。"},
    {id: "Y3", no: 3, name: "桂枝", text: "桂枝正文。"},
  ],
});

/** 浮层 payload 在 `<script type="application/json" id="mf-tcm-data">` 里。 */
function popoverData(layer: TcmMarkerLayer): Record<string, TcmPopoverEntry> {
  const raw = (layer.runtimeHtml ?? "").split('id="mf-tcm-data">')[1] ?? "{}";
  return JSON.parse(raw.split("</script>")[0] ?? "{}") as Record<string, TcmPopoverEntry>;
}

describe("buildTcmMarkerLayer — 新模块引用解析", () => {
  it("按书解析方剂、全局解析中药，并递归收集浮层里的嵌套标记", async () => {
    const db = makeRealDb(DEFAULT_FIXTURE());
    const layer = await buildTcmMarkerLayer(db, {
      bodyHtml: "<p>用 $f{吴茱萸汤} 与 $u{吴茱萸} 治之。</p>",
      title: "第九条",
      currentBookId: "BOOK1",
    });

    expect(layer.bodyHtml).toContain('<a href="/fang-yao/F1/">');
    expect(layer.bodyHtml).toContain('<a href="/zhongyao/Y1/">');
    // 同书同名两首只取 fang_no 小的那首
    expect(layer.bodyHtml).not.toContain('/fang-yao/F2/');

    const data = popoverData(layer);
    expect(Object.keys(data).sort()).toEqual(["F1", "Y1", "Y2"]);
    expect(data.F1!.kind).toBe("fang");
    expect(data.F1!.yao?.map((row) => row.name)).toEqual(["吴茱萸", "人参"]);
    // F1 正文里的 $u{人参} 是嵌套标记，浮层内部同样可点
    expect(data.F1!.body).toContain('<a href="/zhongyao/Y2/">');
    expect(data.Y1!.meta).toBe("别名 吴萸");
    expect(layer.titleHtml).toBe("第九条");
    expect(layer.runtimeHtml).toContain('id="mf-tcm-dialog"');
  });

  it("只登记在别书的方名降级成纯文本（D5-A，不跨书回落）", async () => {
    const db = makeRealDb(DEFAULT_FIXTURE());
    const layer = await buildTcmMarkerLayer(db, {
      bodyHtml: "<p>此书无 $f{桂枝汤}。</p>",
      title: "第十条",
      currentBookId: "BOOK1",
    });

    expect(layer.bodyHtml).toContain('data-tcm-name="桂枝汤"');
    expect(layer.bodyHtml).not.toContain('/fang-yao/F3/');
    expect(layer.bodyHtml).not.toContain('<a href="/fang-yao/');
    // 没有解析到任何实体，浮层不应凭空建出来
    expect(Object.keys(popoverData(layer))).toEqual([]);
  });

  it("软删的方剂与中药都不参与解析（可见性只认 deleted_at IS NULL）", async () => {
    const fixture = DEFAULT_FIXTURE();
    // 同书同名两首一起软删，避免 F2 顶上让「不解析」看起来仍能命中
    fixture.fangs[0]!.deletedAt = "2026-11-07 00:00:00";
    fixture.fangs[1]!.deletedAt = "2026-11-07 00:00:00";
    fixture.yaos[0]!.deletedAt = "2026-11-07 00:00:00";
    const db = makeRealDb(fixture);
    const layer = await buildTcmMarkerLayer(db, {
      bodyHtml: "<p>用 $f{吴茱萸汤} 与 $u{吴茱萸} 治之。</p>",
      title: "第九条",
      currentBookId: "BOOK1",
    });

    expect(layer.bodyHtml).not.toContain('<a href="/fang-yao/');
    expect(layer.bodyHtml).not.toContain('<a href="/zhongyao/');
    expect(layer.bodyHtml).toContain('class="mf-mk mf-mk-f"');
    expect(layer.bodyHtml).toContain('class="mf-mk mf-mk-u"');
  });

  it("currentBookId 为 null 时不解析方剂，中药仍按名解析", async () => {
    const db = makeRealDb(DEFAULT_FIXTURE());
    const layer = await buildTcmMarkerLayer(db, {
      bodyHtml: "<p>用 $f{吴茱萸汤} 与 $u{吴茱萸} 治之。</p>",
      title: "第九条",
      currentBookId: null,
    });

    expect(layer.bodyHtml).not.toContain('<a href="/fang-yao/');
    expect(layer.bodyHtml).toContain('<a href="/zhongyao/Y1/">');
  });

  it("链接码集合来自标记字典：后台新增 link_type=1 的 $z 无需改代码", async () => {
    const db = makeRealDb(DEFAULT_FIXTURE());
    const layer = await buildTcmMarkerLayer(db, {
      bodyHtml: "<p>用 $z{桂枝} 治之。</p>",
      title: "第一条",
      currentBookId: "BOOK1",
    });

    expect(layer.bodyHtml).toContain('<a href="/zhongyao/Y3/">');
    expect(Object.keys(popoverData(layer))).toEqual(["Y3"]);
  });

  it("正文无标记时原样返回，不半吊子渲染", async () => {
    const db = makeRealDb(DEFAULT_FIXTURE());
    const bodyHtml = "<p>no markers here</p>";
    const layer = await buildTcmMarkerLayer(db, {
      bodyHtml, title: "Plain", currentBookId: null,
    });

    expect(layer.bodyHtml).toBe(bodyHtml);
    expect(layer.titleHtml).toBeNull();
    expect(layer.runtimeHtml).toBeNull();
  });

  it("只有非链接码时照常上色，但不激活浮层", async () => {
    const db = makeRealDb(DEFAULT_FIXTURE());
    const layer = await buildTcmMarkerLayer(db, {
      bodyHtml: "<p>太阳病，发热无汗，$a{（病源云恶寒。）}名曰刚痓，$w{三两}。</p>",
      title: "第二条",
      currentBookId: "BOOK1",
    });

    expect(layer.bodyHtml).toContain('class="mf-mk mf-mk-a"');
    expect(layer.bodyHtml).toContain('class="mf-mk mf-mk-w"');
    expect(layer.bodyHtml).not.toContain("$a{");
    expect(layer.bodyHtml).not.toContain("$w{");
    expect(layer.runtimeHtml).toBeNull();
    expect(layer.titleHtml).toBe("第二条");
  });

  it("中药名归一：序号前缀与尾部炮制注都解析到同一味药", async () => {
    const db = makeRealDb(DEFAULT_FIXTURE());
    const first = await buildTcmMarkerLayer(db, {
      bodyHtml: "<p>$u{1、吴茱萸(炮)}主之。</p>", title: "第九条", currentBookId: "BOOK1",
    });
    expect(first.bodyHtml).toContain('<a href="/zhongyao/Y1/">');

    const second = await buildTcmMarkerLayer(db, {
      bodyHtml: "<p>$u{吴茱萸}主之。</p>", title: "第十条", currentBookId: "BOOK1",
    });
    expect(second.bodyHtml).toContain('<a href="/zhongyao/Y1/">');
  });
});

describe("反向引用索引已从前台下线", () => {
  it("浮层不含 references 分组，也不再输出「引用此…的条文」文案", async () => {
    const db = makeRealDb(DEFAULT_FIXTURE());
    const layer = await buildTcmMarkerLayer(db, {
      bodyHtml: "<p>用 $f{吴茱萸汤} 治之。</p>",
      title: "论吴茱萸汤",
      currentBookId: "BOOK1",
    });

    expect(layer.runtimeHtml).not.toContain("引用此方剂的条文");
    expect(layer.runtimeHtml).not.toContain("引用此中药的条文");
    expect(layer.runtimeHtml).not.toContain("references");
    expect(popoverData(layer).F1!).not.toHaveProperty("references");
    // 浮层底部改为「查看条目」直达新路由，不再是旧 /i/ 链接
    expect(layer.runtimeHtml).toContain("查看条目");
    expect(layer.runtimeHtml).not.toContain('href="/i/');
  });

  it("前台入口只认新条目路由前缀，且不调用反向引用重算", async () => {
    const source = readFileSync(
      path.join(repositoryRoot, "src", "server", "tcm", "markerPopover.ts"),
      "utf8",
    );
    const frontPart = source.split("front-decoupling:ignore-start")[0] ?? "";
    expect(frontPart).not.toContain("ensureMarkerCitations");
    expect(frontPart).not.toContain("ext_marker_citations");
    expect(frontPart).toContain('a[href^="/fang-yao/"]');
    expect(frontPart).toContain('a[href^="/zhongyao/"]');
    expect(frontPart).not.toContain('href^="/i/');
  });
});

describe("mapStyles", () => {
  it("把 App 下发的样式字段改名成渲染器消费的形状", () => {
    const mapped = mapStyles([
      {marker: "f", color: "#a23", isSmallFont: false, smallFontScale: 0.7, linkType: 2},
      {marker: "a", color: "#808080", isSmallFont: true, smallFontScale: 0.55, linkType: 0},
    ]);
    expect(mapped).toEqual([
      {code: "f", color: "#a23", smallFont: false, smallFontScale: 0.7, linkType: 2},
      {code: "a", color: "#808080", smallFont: true, smallFontScale: 0.55, linkType: 0},
    ]);
    const html = renderTcmMarkers("$f{桂枝汤}", mapped, {});
    expect(html).toContain('class="mf-mk mf-mk-f"');
    expect(html).not.toContain("mf-mk-unknown");
  });
});
