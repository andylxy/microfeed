/**
 * TCM inline-annotation marker layer for the public reader page (`/i/[slug]`).
 *
 * `renderTcmMarkers` (shared) turns `$f{方剂}` / `$u{药名}` markers into
 * clickable `<a data-tcm-kind>` anchors when a name resolves in the current
 * book. This module supplies that resolver and the popover runtime (a
 * `<dialog>` + JSON data + click handler) so a click shows composition / herb
 * detail instead of navigating away (no-JS falls back to the real link).
 *
 * Resolution scope (see spec `.scratch/tcm-import/spec.md` and the
 * `fang-marker` investigation):
 *  - 方剂 (`$f`): resolved **within the current 典籍 book** via
 *    `data._microfeed.sourceBookId`. A 条文 in 金匮要略 may only link to a
 *    方剂 that actually belongs to 金匮要略 (同名跨书不串).
 *  - 中药 (`$u`): herbs live in one shared 本草 container (`tcmyao00001`), so
 *    they cannot be "within" a 典籍 book — resolved **globally** by pure name
 *    via the `items_yao_pure_name` expression index (migration 0104). This is
 *    the only interpretation that lets herb links work at all.
 *
 * Query shape is constrained to stay index-backed (no SCAN of all 9506 items):
 *  - `status` is written `IN (1, 4)`, never `= 1` (equality has zero
 *    selectivity here and forces a full-table scan — see migration 0104).
 *  - `tcm_kind` is an equality single value, never `IN (...)`.
 */

import {renderTcmMarkers, type TcmMarkerStyle} from "@/shared/TcmMarkers";
import {getAppStyleConfig, type AppStyleItem} from "./reads";

/**
 * The two marker codes that carry a reverse index (`ext_marker_citations`).
 * `$a{}` 之类纯样式标记不进表，`$g{}` 也不（`linkType=3` 不生成链接）。
 */
type MarkerCode = "f" | "u";

/** Container channel ids — a TCM item viewed directly (fang/yao/term page). */
const CONTAINER_CHANNEL_IDS = new Set(["tcmfang0001", "tcmyao00001", "tcmterm0001"]);

export interface TcmPopoverEntry {
  kind: "fang" | "yao";
  id: string;
  name: string;
  /** Short subtitle: 方剂 → "N味 · 煎服M次"; 中药 → "别名 …". */
  meta: string;
  /** Formula composition rows (only for kind === "fang"). */
  yao?: Array<{name: string; amount: string; suffix: string; extra: string}>;
  /** 条文/篇章里引用了本条目（方剂或中药）的链接。 */
  references?: Array<{id: string; title: string}>;
  /** Rendered body HTML (markers inside are themselves clickable). */
  body: string;
  url: string;
}

export interface TcmMarkerLayer {
  /** Rendered title HTML (markers resolved); null when the layer is inactive. */
  titleHtml: string | null;
  /** Rendered body HTML (markers resolved); equals `content_html` when inactive. */
  bodyHtml: string;
  /** Popover `<style>` + `<dialog>` + JSON + handler; null when no entity markers. */
  runtimeHtml: string | null;
}

function parseData(data: unknown): Record<string, any> {
  if (typeof data === "string") {
    try {
      return JSON.parse(data) as Record<string, any>;
    } catch {
      return {};
    }
  }
  return (data ?? {}) as Record<string, any>;
}

/** Strip the `N、` serial prefix that 中药 titles carry (e.g. `63、吴茱萸`). */
function stripYaoNo(title: string): string {
  return String(title).replace(/^\d+\s*[、.．]\s*/, "");
}

/** Strip a trailing parenthesised note some herb markers carry (`吴茱萸(炮)`). */
function normalizeYaoName(name: string): string {
  return name.replace(/[（(][^）)]*[）)]\s*$/, "").trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** App 下发的样式目录 → 渲染器消费的样式形状。导出供路由侧直接渲染
 *  （卷名 / 条名等标题级文本）——字段名不同（marker→code、
 *  isSmallFont→smallFont），路由侧直接拿 getAppStyleConfig 的返回值喂
 *  renderTcmMarkers 会把每个标记降级成 unknown 灰色文本（外壳丢、内容留），
 *  故转换点只此一处。 */
export function mapStyles(list: AppStyleItem[]): TcmMarkerStyle[] {
  return list.map((s) => ({
    code: s.marker,
    color: s.color,
    smallFont: s.isSmallFont,
    smallFontScale: s.smallFontScale,
    linkType: s.linkType,
  }));
}

/** Collect `$f{…}` / `$u{…}` names from raw marker text (not rendered HTML). */
function extractMarkerNames(source: string): {fang: Set<string>; yao: Set<string>} {
  const fang = new Set<string>();
  const yao = new Set<string>();
  const re = /\$([fu])\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const name = (m[2] ?? "").trim();
    if (!name) continue;
    if (m[1] === "f") fang.add(name);
    else yao.add(normalizeYaoName(stripYaoNo(name)));
  }
  return {fang, yao};
}

/**
 * Collect names from a 条文's structured `_microfeed.fangList` — the second
 * citation source, parallel to the `$f{…}` markers in the body. Both feed the
 * same `f` rows: the popover reads them, and the 方剂 editor's reverse-reference
 * view (`ajax/tcm/fang-references`) points at this index instead of scanning
 * the book. Names are trimmed so a space-padded source entry still matches the
 * editor's trimmed lookup.
 */
function extractFangListNames(data: Record<string, any>): string[] {
  const pocket = data._microfeed;
  const list =
    pocket && typeof pocket === "object"
      ? (pocket as Record<string, any>).fangList
      : undefined;
  if (!Array.isArray(list)) return [];
  const names: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    if (name) names.push(name);
  }
  return names;
}

/**
 * All 方剂 in one 典籍 book, keyed by name (first occurrence = `no` min wins
 * so same-name duplicates resolve to the fuller entry). Returns empty when the
 * current book is not a 典籍 book (e.g. the fang container itself).
 */
async function loadFangBySourceBook(
  db: D1Database,
  sourceBookId: string,
): Promise<Map<string, {id: string; data: Record<string, any>}>> {
  const map = new Map<string, {id: string; data: Record<string, any>}>();
  if (CONTAINER_CHANNEL_IDS.has(sourceBookId)) return map;
  const {results} = await db
    .prepare(
      "SELECT id, data FROM items " +
        "WHERE tcm_kind = 'fang' AND status IN (1, 4) " +
        "AND json_extract(data, '$._microfeed.sourceBookId') = ? " +
        "ORDER BY json_extract(data, '$._microfeed.no'), id",
    )
    .bind(sourceBookId)
    .all();
  for (const row of results ?? []) {
    const data = parseData(row.data);
    const name = String(data.title ?? "").trim();
    if (name && !map.has(name)) {
      map.set(name, {id: String(row.id), data});
    }
  }
  return map;
}

/**
 * One 中药 by pure name, using the `items_yao_pure_name` expression index
 * (migration 0104). `tcm_kind = 'yao'` is an equality and the substring
 * expression is written verbatim so the planner seeks instead of scanning.
 */
async function queryYaoByPureName(
  db: D1Database,
  pureName: string,
): Promise<{id: string; data: Record<string, any>} | null> {
  if (!pureName) return null;
  const {results} = await db
    .prepare(
      "SELECT id, data FROM items " +
        "WHERE tcm_kind = 'yao' AND status IN (1, 4) " +
        "AND substr(json_extract(data, '$.title'), instr(json_extract(data, '$.title'), '、') + 1) = ? " +
        "LIMIT 1",
    )
    .bind(pureName)
    .all();
  const row = (results ?? [])[0];
  if (!row) return null;
  return {id: String(row.id), data: parseData(row.data)};
}

function buildFangEntry(
  data: Record<string, any>,
  id: string,
  styles: TcmMarkerStyle[],
  resolveHref: (linkType: number, name: string) => string | null,
): TcmPopoverEntry {
  const pocket = (data._microfeed ?? {}) as Record<string, any>;
  const fangYaoList = Array.isArray(pocket.fangYaoList) ? pocket.fangYaoList : [];
  const yao = fangYaoList.map((entry: any) => ({
    name: String(entry?.showName ?? ""),
    amount: String(entry?.amount ?? ""),
    suffix: String(entry?.suffix ?? ""),
    extra: String(entry?.extraProcess ?? ""),
  }));
  const metaParts: string[] = [];
  if (pocket.yaoCount) metaParts.push(`${String(pocket.yaoCount)}味`);
  if (pocket.drinkNum) metaParts.push(`煎服${String(pocket.drinkNum)}次`);
  return {
    kind: "fang",
    id,
    name: String(data.title ?? ""),
    meta: metaParts.join(" · "),
    yao,
    body: renderTcmMarkers(String(data.description ?? ""), styles, {resolveHref}),
    url: `/i/${id}/`,
  };
}

function buildYaoEntry(
  data: Record<string, any>,
  id: string,
  styles: TcmMarkerStyle[],
  resolveHref: (linkType: number, name: string) => string | null,
): TcmPopoverEntry {
  const pocket = (data._microfeed ?? {}) as Record<string, any>;
  const aliases = Array.isArray(pocket.aliases)
    ? (pocket.aliases as Array<any>)
        .map((a) => String(a?.bieming ?? ""))
        .filter(Boolean)
    : [];
  const metaParts: string[] = [];
  if (aliases.length) metaParts.push(`别名 ${aliases.join("／")}`);
  return {
    kind: "yao",
    id,
    name: stripYaoNo(String(data.title ?? "")),
    meta: metaParts.join(" · "),
    body: renderTcmMarkers(String(data.description ?? ""), styles, {resolveHref}),
    url: `/i/${id}/`,
  };
}

function buildRuntimeHtml(data: Record<string, TcmPopoverEntry>): string {
  const payload = JSON.stringify(data).replace(/</g, "\\u003c");
  return `
<style>
.mf-mk[data-tcm-kind] {
  cursor: pointer;
  text-decoration: underline dotted currentColor;
  text-underline-offset: 2px;
}
.mf-tcm-dialog {
  max-width: 36rem;
  width: calc(100vw - 2rem);
  border: 1px solid #e2e2e2;
  border-radius: 12px;
  background: #fff;
  color: #1a1a1a;
  padding: 0;
}
.mf-tcm-dialog::backdrop { background: rgb(0 0 0 / 45%); }
.mf-tcm-head { display: flex; align-items: baseline; gap: .5em; padding: 1rem 1.25rem .5rem; }
.mf-tcm-head h2 { margin: 0; font-size: 1.1em; }
.mf-tcm-meta { color: #6b6b6b; font-size: .8em; }
.mf-tcm-close {
  margin-left: auto; border: 0; background: transparent; color: #6b6b6b;
  font-size: 1.2em; cursor: pointer; line-height: 1; padding: .1em .3em;
}
.mf-tcm-body { padding: 0 1.25rem 1.25rem; max-height: 62vh; overflow-y: auto; line-height: 1.7; }
.mf-tcm-table { width: 100%; border-collapse: collapse; font-size: .92em; margin-top: .25em; }
.mf-tcm-table th, .mf-tcm-table td { text-align: left; padding: .35em .5em; border-bottom: 1px solid #eee; }
.mf-tcm-table th { color: #6b6b6b; font-weight: 500; }
.mf-tcm-link { display: inline-block; margin-top: 1em; font-size: .85em; color: #2563eb; }
.mf-tcm-back {
  display: inline-block; margin-top: 1em; font-size: .85em; color: #2563eb;
  background: none; border: 0; padding: 0; cursor: pointer; font-family: inherit;
}
.mf-tcm-back:hover { text-decoration: underline; }
.mf-tcm-refs { margin-top: 1em; border-top: 1px solid #eee; padding-top: .6em; }
.mf-tcm-refs-h { font-size: .8em; color: #6b6b6b; margin-bottom: .3em; }
.mf-tcm-refs ul { margin: 0; padding-left: 1.1em; }
.mf-tcm-refs li { margin: .15em 0; font-size: .9em; }
.mf-tcm-refs .mf-tcm-link { margin-top: 0; font-size: .9em; }
</style>
<dialog class="mf-tcm-dialog" id="mf-tcm-dialog" aria-labelledby="mf-tcm-title">
  <div class="mf-tcm-head">
    <h2 id="mf-tcm-title"></h2>
    <span class="mf-tcm-meta" id="mf-tcm-meta"></span>
    <button type="button" class="mf-tcm-close" id="mf-tcm-close" aria-label="关闭">×</button>
  </div>
  <div class="mf-tcm-body" id="mf-tcm-body"></div>
</dialog>
<script type="application/json" id="mf-tcm-data">${payload}</script>
<script>
(function () {
  var DATA = JSON.parse(document.getElementById('mf-tcm-data').textContent || '{}');
  var dlg = document.getElementById('mf-tcm-dialog');
  var titleEl = document.getElementById('mf-tcm-title');
  var metaEl = document.getElementById('mf-tcm-meta');
  var bodyEl = document.getElementById('mf-tcm-body');
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c];
    });
  }
  // Stack of opened entry ids. Opening a nested marker pushes; 返回/×/ESC
  // pop one level and re-render the new top. Backdrop click wipes the whole
  // stack (that's the "cancel everything" escape hatch). DATA is pre-baked
  // with every nested entry at page load, so the stack only needs ids — no
  // body HTML snapshot per level.
  var stack = [];
  function render(f) {
    titleEl.textContent = f.name;
    metaEl.textContent = f.meta || '';
    var inner = '';
    if (f.kind === 'fang' && f.yao && f.yao.length) {
      var rows = f.yao.map(function (y) {
        return '<tr><td>' + esc(y.name) + '</td><td>' + esc(y.amount) +
          '</td><td>' + esc(y.suffix || y.extra || '') + '</td></tr>';
      }).join('');
      inner += '<table class="mf-tcm-table"><thead><tr><th>药味</th><th>剂量</th><th>炮制</th></thead><tbody>' +
        rows + '</tbody></table>';
    }
    if (f.body) inner += '<div>' + f.body + '</div>';
    if (f.references && f.references.length) {
      var refItems = f.references.map(function (r) {
        return '<li><a class="mf-tcm-link" href="' + esc('/i/' + r.id + '/') + '">' +
          esc(r.title) + '</a></li>';
      }).join('');
      var refHead = f.kind === 'yao' ? '引用此中药的条文' : '引用此方剂的条文';
      inner += '<div class="mf-tcm-refs"><div class="mf-tcm-refs-h">' + refHead + '</div><ul>' +
        refItems + '</ul></div>';
    }
    // 返回 button. Semantics: one level up, not "close everything" — matches
    // ×/ESC. At the stack bottom it degenerates to closing the dialog.
    inner += '<button type="button" class="mf-tcm-back" data-back="1">返回</button>';
    bodyEl.innerHTML = inner;
  }
  function open(id) {
    var f = DATA[id];
    if (!f) return false;
    stack.push(id);
    render(f);
    if (!dlg.open) {
      if (typeof dlg.showModal === 'function') dlg.showModal();
      else dlg.setAttribute('open', '');
    }
    return true;
  }
  function back() {
    if (!stack.length) return;
    stack.pop();
    if (stack.length) {
      render(DATA[stack[stack.length - 1]]);
    } else {
      dlg.close();
    }
  }
  // Marker anchors carry a [data-tcm-kind] descendant. The dialog's own
  // 返回 button closes one level via [data-back]; the refs links inside
  // the dialog have no marker so they navigate normally.
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.closest) {
      var backBtn = t.closest('[data-back]');
      if (backBtn) { e.preventDefault(); back(); return; }
    }
    var a = t && t.closest ? t.closest('a[href^="/i/"]') : null;
    if (!a || !a.querySelector('[data-tcm-kind]')) return;
    var id = a.getAttribute('href').split('/').filter(Boolean).pop();
    if (open(id)) e.preventDefault();
  });
  // × walks the stack one level (matching 返回).
  document.getElementById('mf-tcm-close').addEventListener('click', function (e) {
    e.preventDefault();
    back();
  });
  // ESC also walks the stack one level. We intercept keydown at the document
  // capture phase so the dialog never sees the key — its native cancel event
  // is not reliably cancelable (Chrome flips cancelable to false on the 2nd
  // ESC in a sequence, closing the dialog before our handler runs).
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dlg.open) {
      e.preventDefault();
      e.stopPropagation();
      back();
    }
  }, true);
  // Backdrop click (outside the dialog chrome) is the "cancel everything"
  // path — clear the stack and close.
  dlg.addEventListener('click', function (e) {
    if (e.target === dlg) {
      stack.length = 0;
      dlg.close();
    }
  });
})();
</script>`;
}

/** How many 条文 a popover (方剂 or 中药) lists before it caps. */
const MAX_REFERENCES = 50;

/** D1 caps a batch; one book's citations (752 rows here) would blow one call. */
const CITATION_BATCH_SIZE = 100;

/**
 * Make sure `ext_marker_citations` holds this book's reverse index.
 *
 * Dirty-flag + lazy full recompute, the same shape migration 0103 uses for
 * `ext_book_stats`: the triggers on `items` only clear `computed_at_ms`, and the
 * real work happens here, when a reader finds the index stale — once per change
 * cycle instead of once per page render.
 *
 * ⚠️ 前置不变量（ADR-0025 D6 / 用户 2026-10-13 强调）：正文在 `data.description` 里
 * **按原形保存**，`$f{桂枝汤}` 是原文的一部分；渲染成 `<span>` 只发生在显示时。
 * 这里只从原文里**提取**名字，表里不含任何 HTML。正文来源走 `extractMarkerNames`
 * —— 与渲染路径同一个函数，所以「什么算一个标记」索引与渲染器不可能产生分歧；
 * 结构化来源 `_microfeed.fangList` 与它合并去重（`extractFangListNames`）。
 * 读者：popover（`findMarkerReferences`）与方剂编辑器的反向引用视图
 * （`ajax/tcm/fang-references`）都读这张表，后者因此不再整书扫描。
 *
 * 顺序是 clear → 分片 insert → 最后盖时间戳：中途失败会留下"时间戳仍是 0"的脏行，
 * 下一位读者会把它重算一遍，于是永远不会服务半份索引。
 */
export async function ensureMarkerCitations(
  db: D1Database,
  bookId: string,
): Promise<void> {
  const state = await db
    .prepare("SELECT computed_at_ms FROM ext_marker_citation_state WHERE book_id = ?")
    .bind(bookId)
    .first<{computed_at_ms: number}>();
  if (state && Number(state.computed_at_ms) !== 0) return;

  // Walks `items_book_kind (book_id, tcm_kind, status, pub_date)` — 实测计划为
  // `SEARCH items USING INDEX items_book_kind (book_id=? AND tcm_kind=? AND status=?)`，
  // 本书 847 rows_read / 839 行。这是「整本读取」：行数由书的大小决定，无法用索引消除，
  // 只是从「每次渲染」挪到了「每个变更周期一次」。
  const {results} = await db
    .prepare(
      "SELECT id, rowid AS seq, data FROM items " +
        "WHERE book_id = ? AND tcm_kind IN ('section', 'chapter') AND status IN (1, 4)",
    )
    .bind(bookId)
    .all<{id: string; seq: number; data: unknown}>();

  const rows: D1PreparedStatement[] = [];
  for (const row of results ?? []) {
    const d = parseData(row.data);
    const names = extractMarkerNames(String(d.description ?? ""));
    // 结构化来源（fangList）与正文来源（$f{}）合并去重后同以 'f' 写入：主键
    // (book_id, marker_code, marker_name, section_id) 对两源命中同一条文的情况
    // 本就去重，合并只为省掉一次空写的 INSERT OR REPLACE。
    const fangNames = new Set([...names.fang, ...extractFangListNames(d)]);
    const sectionId = String(row.id);
    const sectionTitle = String(d.title ?? "");
    // 重算时的 rowid，用来复刻"无 ORDER BY 的 rowid 顺序"这一既有展示顺序。
    const seq = Number(row.seq) || 0;
    for (const name of fangNames) {
      rows.push(
        db
          .prepare(
            // 按主键 (book_id, marker_code, marker_name, section_id) 定位，单行写入。
            "INSERT OR REPLACE INTO ext_marker_citations " +
              "(book_id, marker_code, marker_name, section_id, section_title, section_seq) " +
              "VALUES (?, ?, ?, ?, ?, ?)",
          )
          .bind(bookId, "f", name, sectionId, sectionTitle, seq),
      );
    }
    for (const name of names.yao) {
      rows.push(
        db
          .prepare(
            // 按主键 (book_id, marker_code, marker_name, section_id) 定位，单行写入。
            "INSERT OR REPLACE INTO ext_marker_citations " +
              "(book_id, marker_code, marker_name, section_id, section_title, section_seq) " +
              "VALUES (?, ?, ?, ?, ?, ?)",
          )
          .bind(bookId, "u", name, sectionId, sectionTitle, seq),
      );
    }
  }

  // 计划：`SEARCH ext_marker_citations USING INDEX ext_marker_citations_lookup (book_id=?)`
  // —— 只删本书的行（实测本书 752 行）。
  await db
    .prepare("DELETE FROM ext_marker_citations WHERE book_id = ?")
    .bind(bookId)
    .run();
  for (let i = 0; i < rows.length; i += CITATION_BATCH_SIZE) {
    await db.batch(rows.slice(i, i + CITATION_BATCH_SIZE));
  }
  await db.batch([
    db
      .prepare(
        "INSERT INTO ext_marker_citation_state (book_id, computed_at_ms) VALUES (?, ?) " +
          "ON CONFLICT(book_id) DO UPDATE SET computed_at_ms = excluded.computed_at_ms",
      )
      .bind(bookId, Date.now()),
  ]);
}

/**
 * The 条文 citing one entry (`f` = 方剂, `u` = 中药), in source order.
 *
 * `marker_code` is **required** for the
 * `(book_id, marker_code, marker_name, section_seq)` index to be used — without it
 * the planner walks every citation row the book has. Measured on a 方剂 sample:
 * 709 rows_read without the code column, 60 with it.
 *
 * 计划：`SEARCH ext_marker_citations USING INDEX ext_marker_citations_lookup
 * (book_id=? AND marker_code=? AND marker_name=?)`。
 */
async function findMarkerReferences(
  db: D1Database,
  bookId: string,
  markerCode: MarkerCode,
  markerName: string,
): Promise<Array<{id: string; title: string}>> {
  const {results} = await db
    .prepare(
      "SELECT section_id, section_title FROM ext_marker_citations " +
        "WHERE book_id = ? AND marker_code = ? AND marker_name = ? " +
        "ORDER BY section_seq LIMIT ?",
    )
    .bind(bookId, markerCode, markerName, MAX_REFERENCES)
    .all<{section_id: string; section_title: string}>();
  return (results ?? []).map((row) => ({
    id: String(row.section_id),
    title: String(row.section_title),
  }));
}

/**
 * Build the marker layer for one item page. Returns `bodyHtml` always (it falls
 * back to the input when no styles/markers apply) and `titleHtml` / `runtimeHtml`
 * only when the TCM marker system is active and there are entity markers.
 *
 * `currentBookId` is the item's `_microfeed.bookId`; for a 条文 it is the 典籍
 * channel, which is what scopes 方剂 resolution.
 */
export async function buildTcmMarkerLayer(
  db: D1Database,
  opts: {bodyHtml: string; title: string; currentBookId: string | null},
): Promise<TcmMarkerLayer> {
  const styles = mapStyles(await getAppStyleConfig(db));
  const bodyHtmlIn = String(opts.bodyHtml ?? "");
  const titleIn = String(opts.title ?? "");

  if (styles.length === 0 || opts.currentBookId == null) {
    return {titleHtml: null, bodyHtml: bodyHtmlIn, runtimeHtml: null};
  }

  const fangByName = await loadFangBySourceBook(db, opts.currentBookId);
  const yaoCache = new Map<string, {id: string; data: Record<string, any>} | null>();
  const loadYao = async (pureName: string) => {
    if (yaoCache.has(pureName)) return yaoCache.get(pureName);
    const entry = await queryYaoByPureName(db, pureName);
    yaoCache.set(pureName, entry);
    return entry;
  };

  const resolveHref = (linkType: number, name: string): string | null => {
    if (linkType === 2) {
      const f = fangByName.get(name);
      return f ? `/i/${f.id}/` : null;
    }
    if (linkType === 1) {
      const y = yaoCache.get(normalizeYaoName(stripYaoNo(name)));
      return y ? `/i/${y.id}/` : null;
    }
    return null;
  };

  // Preload every herb referenced by the page body/title so resolveHref is
  // synchronous during the render pass.
  const initial = extractMarkerNames(`${bodyHtmlIn}\n${titleIn}`);
  for (const name of initial.yao) await loadYao(name);

  const renderedBody = renderTcmMarkers(bodyHtmlIn, styles, {resolveHref});
  const titleHtml = renderTcmMarkers(escapeHtml(titleIn), styles, {resolveHref});

  // 两道门，管两件不同的事。此前只有一道门，用「有没有可链接实体」同时判
  // 「要不要渲染」和「要不要弹窗」，只含非链接码（$a 按语 / $m 强调 / $w 剂量
  // / $q 出处……）的页面整层作废，正文原样返回。修正记录见 ADR-0015「解析之后
  // 还有两道门」。
  //
  // 门一（样式渲染）：正文或标题渲染出过任何 mf-mk span → 本页有标记，返回
  // 渲染结果（含未知码的灰色降级 span）；一个样式标记都没有才回退原文。
  const hasStyledMarker =
    renderedBody.includes('class="mf-mk') || titleHtml.includes('class="mf-mk');
  if (!hasStyledMarker) {
    return {titleHtml: null, bodyHtml: bodyHtmlIn, runtimeHtml: null};
  }
  // 门二（弹层激活）：只有存在可链接实体（$f / $u / $g 才带 data-tcm-kind）才
  // 值得建弹窗数据与 runtime——纯样式码没有可弹的内容。标题里的可链接实体也算，
  // 否则标题-only 的链接会丢。
  const hasEntityMarker =
    renderedBody.includes("data-tcm-kind") || titleHtml.includes("data-tcm-kind");
  if (!hasEntityMarker) {
    return {titleHtml, bodyHtml: renderedBody, runtimeHtml: null};
  }
  // 引用表预热门：只有出现了 方剂 / 中药 标记才需要物化（initial 取自原始正文，
  // 与上面两道门的判据无关）。

  // The 条文 citing each 方剂/中药 come from `ext_marker_citations` (migration 0111).
  // Container channels carry no 条文 of their own, so they have no index to build;
  // and a page with no entity marker has nothing to look up.
  const citationsReady =
    !CONTAINER_CHANNEL_IDS.has(opts.currentBookId) &&
    (initial.fang.size > 0 || initial.yao.size > 0);
  if (citationsReady) await ensureMarkerCitations(db, opts.currentBookId);

  // Build popover data: seed from the page's markers, then follow markers that
  // appear inside resolved 方剂/中药 bodies so the dialog's own links work.
  const data: Record<string, TcmPopoverEntry> = {};
  const visited = new Set<string>();
  const worklist: Array<{kind: "fang" | "yao"; id: string; data: Record<string, any>}> = [];

  const seed = (
    kind: "fang" | "yao",
    id: string,
    entryData: Record<string, any>,
  ) => {
    if (visited.has(id)) return;
    visited.add(id);
    worklist.push({kind, id, data: entryData});
  };
  for (const name of initial.fang) {
    const f = fangByName.get(name);
    if (f) seed("fang", f.id, f.data);
  }
  for (const name of initial.yao) {
    const y = yaoCache.get(name);
    if (y) seed("yao", y.id, y.data);
  }

  while (worklist.length > 0) {
    const item = worklist.shift()!;
    const entryData = item.data;
    // Load any herbs referenced by this entry's body before rendering it, so
    // nested marker links resolve inside the dialog too.
    const childNames = extractMarkerNames(String(entryData.description ?? ""));
    for (const name of childNames.yao) await loadYao(name);
    const entry =
      item.kind === "fang"
        ? buildFangEntry(entryData, item.id, styles, resolveHref)
        : buildYaoEntry(entryData, item.id, styles, resolveHref);
    data[item.id] = entry;
    for (const name of childNames.fang) {
      const f = fangByName.get(name);
      if (f) seed("fang", f.id, f.data);
    }
    for (const name of childNames.yao) {
      const y = yaoCache.get(name);
      if (y) seed("yao", y.id, y.data);
    }
  }

  // Attach cross-references (条文 citing each entry) now that all entries are
  // resolved — including those reached through nested markers.
  //
  // 中药的名字要对齐重算时的口径：`buildYaoEntry` 已经做过 `stripYaoNo`，
  // 这里再补 `normalizeYaoName`，才等于 `ensureMarkerCitations` 存进表的键。
  for (const id of Object.keys(data)) {
    const entry = data[id];
    if (!entry) continue;
    // `kind` 只有 fang / yao 两支，所以这里是穷尽映射，不需要兜底分支。
    const code: MarkerCode = entry.kind === "fang" ? "f" : "u";
    const name = entry.kind === "fang" ? entry.name : normalizeYaoName(entry.name);
    entry.references = citationsReady
      ? await findMarkerReferences(db, opts.currentBookId, code, name)
      : [];
  }

  return {titleHtml, bodyHtml: renderedBody, runtimeHtml: buildRuntimeHtml(data)};
}
