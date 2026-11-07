/**
 * 前台正文标注层（ADR-0066 决策 6/15）。
 *
 * `renderTcmMarkers` 把 `$X{…}` 变成带 `data-tcm-*` 的 span；本模块提供
 * name → 新条目页 URL 的解析器与浮层 runtime。引用目标全部来自
 * `@/server/catalog/refs`，本文件不再写内容查询 SQL。
 *
 * 方剂按当前书解析（refs 里的 SQL 带 source_book_legacy_id），中药全局按名查。
 * 浮层不再提供「引用此方剂 / 中药的条文」分组：那张旧索引连同它的重算入口
 * 已在前台下线，只剩文件末尾一段后台专用导出供后台反向引用视图复用。
 */

import {
  MARKER_CODE_BODY,
  renderTcmMarkers,
  type TcmMarkerStyle,
} from "@/shared/TcmMarkers";
import {getAppStyleConfig, type AppStyleItem} from "./reads";
import {
  findYaoRefByName,
  getFangPopoverData,
  getYaoPopoverData,
  loadFangRefsForBook,
  type FangPopoverData,
  type MarkerRef,
  type YaoPopoverData,
} from "@/server/catalog/refs";

/**
 * 跨文件返回 union 上的 `in` 收窄会得到 unknown；用显式谓词区分
 * 方剂详情（含 bodies）与中药详情，保住类型。
 */
function isFangDetail(
  detail: FangPopoverData | YaoPopoverData | null,
): detail is FangPopoverData {
  return detail !== null && "bodies" in detail;
}

export interface TcmPopoverEntry {
  kind: "fang" | "yao";
  id: string;
  name: string;
  /** 短副标题：方剂 → "N味 · 煎服M次"；中药 → "别名 …"。 */
  meta: string;
  /** 方剂组成行（仅 kind === "fang"）。 */
  yao?: Array<{name: string; amount: string; suffix: string; extra: string}>;
  /** 已渲染的正文 HTML（内部标记同样可点）。 */
  body: string;
  url: string;
}

export interface TcmMarkerLayer {
  titleHtml: string | null;
  bodyHtml: string;
  /** 浮层 `<style>` + `<dialog>` + JSON + handler；无实体标记时为 null。 */
  runtimeHtml: string | null;
}

/** 去掉中药标题的 `N、` 序号前缀（`63、吴茱萸`）。 */
function stripYaoNo(title: string): string {
  return String(title).replace(/^\d+\s*[、.．]\s*/u, "");
}

/** 去掉尾部括号注（`吴茱萸(炮)` → `吴茱萸`）。 */
function normalizeYaoName(name: string): string {
  return String(name ?? "")
    .replace(/[（(][^）)]*[）)]\s*$/u, "")
    .trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

/** App 下发的样式目录 → 渲染器消费的形状。供路由侧直接渲染标题级文本。 */
export function mapStyles(list: AppStyleItem[]): TcmMarkerStyle[] {
  return list.map((style) => ({
    code: style.marker,
    color: style.color,
    smallFont: style.isSmallFont,
    smallFontScale: style.smallFontScale,
    linkType: style.linkType,
  }));
}

/** 可链接码按 link_type 推导，不写死常量：后台新增 link_type 1/2 的码自动生效。 */
function linkableCodes(styles: TcmMarkerStyle[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const style of styles) {
    if (style.linkType === 1 || style.linkType === 2) {
      map.set(style.code, style.linkType);
    }
  }
  return map;
}

const ENTITY_MARKER_ANY = new RegExp(
  `\\$(${MARKER_CODE_BODY})\\{([^}]*)\\}`,
  "gu",
);

/** 一次遍历收集正文 / 标题里的实体名，按 link_type 分桶。 */
function extractMarkerNames(
  source: string,
  linkable: Map<string, number>,
): {fang: Set<string>; yao: Set<string>} {
  const fang = new Set<string>();
  const yao = new Set<string>();
  ENTITY_MARKER_ANY.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ENTITY_MARKER_ANY.exec(source)) !== null) {
    const linkType = linkable.get(match[1] ?? "");
    if (linkType === undefined) continue;
    const name = (match[2] ?? "").trim();
    if (!name) continue;
    if (linkType === 2) fang.add(name);
    else if (linkType === 1) yao.add(normalizeYaoName(stripYaoNo(name)));
  }
  return {fang, yao};
}

function buildRuntimeHtml(data: Record<string, TcmPopoverEntry>): string {
  const payload = JSON.stringify(data).replace(/</gu, "\\u003c");
  return `
<style>
.mf-mk[data-tcm-kind] {
  cursor: pointer;
  text-decoration: underline dotted currentColor;
  text-underline-offset: 2px;
}
/* 布局只写在 [open] 上：裸 dialog 的 display 得留给 UA 的
   dialog:not([open]){display:none}，否则关闭态也会被 author 的 display:flex
   顶开，在页面加载时渲染成一块 70vh 白盒（上半页白屏的根因）。 */
.mf-tcm-dialog {
  width: 70vw;
  height: 70vh;
  max-width: none;
  border: 1px solid #e2e2e2;
  border-radius: 12px;
  background: #fff;
  color: #1a1a1a;
  padding: 0;
}
.mf-tcm-dialog[open] {
  display: flex;
  flex-direction: column;
}
/* 点药材：从方剂浮层进入药材详情，弹窗收到父窗口 65%。 */
.mf-tcm-dialog.mf-tcm-yao {
  width: 65vw;
  height: 65vh;
}
.mf-tcm-dialog::backdrop { background: rgb(0 0 0 / 45%); }
.mf-tcm-head { display: flex; align-items: baseline; gap: .5em; padding: 1rem 1.25rem .5rem; flex: 0 0 auto; }
.mf-tcm-head h2 { margin: 0; font-size: 1.1em; }
.mf-tcm-meta { color: #6b6b6b; font-size: .8em; }
/* 右上角关闭键复用项目的圆形图标按钮（同 PublicSearch 的关闭键）：
   内联 SVG 画 X，不用原生 × 字符。 */
.mf-tcm-close {
  margin-left: auto; display: inline-flex; align-items: center; justify-content: center;
  width: 2.25rem; height: 2.25rem; padding: 0; border: 0; border-radius: 999px;
  background: var(--mf-surface, #f6f8fa); color: var(--mf-muted, #57606a);
  cursor: pointer; line-height: 1;
  transition: background 120ms ease, color 120ms ease, transform 120ms ease;
}
.mf-tcm-close:hover { background: var(--mf-border, #d0d7de); color: var(--mf-text, #1a1a1a); }
.mf-tcm-close:active { transform: scale(0.94); }
/* 正文里的换行是数据的一部分（同前台阅读层 .mf-reader-body）：pre-wrap
   让字面 \n 与段首缩进原样呈现，不被 normal 折叠成一片。 */
.mf-tcm-body { padding: 0 1.25rem; flex: 1 1 auto; overflow-y: auto; line-height: 1.7; white-space: pre-wrap; }
.mf-tcm-table { width: 100%; border-collapse: collapse; font-size: .92em; margin-top: .25em; }
.mf-tcm-table th, .mf-tcm-table td { text-align: left; padding: .35em .5em; border-bottom: 1px solid #eee; }
.mf-tcm-table th { color: #6b6b6b; font-weight: 500; }
/* 返回键贴弹窗底边、水平居中；按钮本身复用项目胶囊按钮 .mf-detail-btn。 */
.mf-tcm-foot {
  flex: 0 0 auto; display: flex; justify-content: center;
  padding: .75rem 1.25rem 1.25rem; border-top: 1px solid #eee;
}
</style>
<dialog class="mf-tcm-dialog" id="mf-tcm-dialog" aria-labelledby="mf-tcm-title">
  <div class="mf-tcm-head">
    <h2 id="mf-tcm-title"></h2>
    <span class="mf-tcm-meta" id="mf-tcm-meta"></span>
    <button type="button" class="mf-tcm-close" id="mf-tcm-close" aria-label="关闭">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
    </button>
  </div>
  <div class="mf-tcm-body" id="mf-tcm-body"></div>
  <div class="mf-tcm-foot">
    <button type="button" class="mf-detail-btn" id="mf-tcm-back" data-back="1">返回</button>
  </div>
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
  var stack = [];
  var ENTRY_LINK = 'a[href^="/fang-yao/"], a[href^="/zhongyao/"]';
  function render(f) {
    titleEl.textContent = f.name;
    metaEl.textContent = f.meta || '';
    // 方剂浮层占父窗口 70%，点药材进入的详情收到 65%（药方 70% / 药材 65%）。
    dlg.classList.toggle('mf-tcm-yao', f.kind === 'yao');
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
    if (stack.length) render(DATA[stack[stack.length - 1]]);
    else close();
  }
  // 真模态：只有「关闭 / 返回」这两条主动路径能关掉浮层。close() 先放开
  // allowClose 再调 dialog.close()；除此之外的任何关闭请求（点 backdrop、
  // ESC 触发的 cancel）一律拦下，避免点空白处就把浮层关掉。
  var allowClose = false;
  function close() {
    allowClose = true;
    dlg.close();
    allowClose = false;
  }
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.closest) {
      var backBtn = t.closest('[data-back]');
      if (backBtn) { e.preventDefault(); back(); return; }
    }
    var a = t && t.closest ? t.closest(ENTRY_LINK) : null;
    if (!a || !a.querySelector('[data-tcm-kind]')) return;
    var id = a.getAttribute('href').split('/').filter(Boolean).pop();
    if (open(id)) e.preventDefault();
  });
  document.getElementById('mf-tcm-close').addEventListener('click', function (e) {
    e.preventDefault();
    stack.length = 0;
    close();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dlg.open) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
  dlg.addEventListener('cancel', function (e) {
    // ESC / 其它 dismiss 请求：非主动关闭一律阻止默认的关闭行为。
    if (!allowClose) e.preventDefault();
  });
  dlg.addEventListener('click', function (e) {
    // 点在 dialog 自身（= backdrop 空白处）不关闭；只有内部控件能关。
    if (e.target === dlg) e.preventDefault();
  });
})();
</script>`;
}

/**
 * 建一页的标注层。`bodyHtml` 应传「已转义、标记仍为字面」的 HTML
 * （`catalog/chapters.renderBodySource` 或条目的 `textSource`），
 * `currentBookId` 为 null 时只渲染标记颜色，不解析方剂 / 不建浮层链接。
 */
export async function buildTcmMarkerLayer(
  db: D1Database,
  opts: {bodyHtml: string; title: string; currentBookId: string | null},
): Promise<TcmMarkerLayer> {
  const styles = mapStyles(await getAppStyleConfig(db));
  const linkable = linkableCodes(styles);
  const bodyHtmlIn = String(opts.bodyHtml ?? "");
  const titleIn = String(opts.title ?? "");
  if (styles.length === 0) {
    return {titleHtml: null, bodyHtml: bodyHtmlIn, runtimeHtml: null};
  }

  const fangByName = opts.currentBookId
    ? await loadFangRefsForBook(db, opts.currentBookId)
    : new Map<string, MarkerRef>();
  const yaoCache = new Map<string, MarkerRef | null>();
  const loadYao = async (pureName: string): Promise<MarkerRef | null> => {
    const key = normalizeYaoName(stripYaoNo(pureName));
    if (!yaoCache.has(key)) {
      yaoCache.set(key, await findYaoRefByName(db, key));
    }
    return yaoCache.get(key) ?? null;
  };

  const resolveHref = (linkType: number, name: string): string | null => {
    if (linkType === 2) return fangByName.get(name)?.url ?? null;
    if (linkType === 1) {
      return yaoCache.get(normalizeYaoName(stripYaoNo(name)))?.url ?? null;
    }
    return null;
  };

  // 先把本页正文 / 标题里的中药名解析好，让 renderTcmMarkers 的同步回调能命中。
  const initial = extractMarkerNames(`${bodyHtmlIn}\n${titleIn}`, linkable);
  for (const name of initial.yao) await loadYao(name);

  const renderedBody = renderTcmMarkers(bodyHtmlIn, styles, {resolveHref});
  const titleHtml = renderTcmMarkers(escapeHtml(titleIn), styles, {resolveHref});

  // 门一：没有任何样式标记就原样返回，不半吊子渲染。
  const hasStyledMarker =
    renderedBody.includes('class="mf-mk') || titleHtml.includes('class="mf-mk');
  if (!hasStyledMarker) {
    return {titleHtml: null, bodyHtml: bodyHtmlIn, runtimeHtml: null};
  }
  // 门二：只有可链接实体才值得建浮层数据。
  const hasEntityMarker =
    renderedBody.includes("data-tcm-kind") || titleHtml.includes("data-tcm-kind");
  if (!hasEntityMarker) {
    return {titleHtml, bodyHtml: renderedBody, runtimeHtml: null};
  }

  const data: Record<string, TcmPopoverEntry> = {};
  const visited = new Set<string>();
  const worklist: Array<{kind: "fang" | "yao"; id: string}> = [];
  const seed = (kind: "fang" | "yao", id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    worklist.push({kind, id});
  };

  for (const name of initial.fang) {
    const ref = fangByName.get(name);
    if (ref) seed("fang", ref.id);
  }
  for (const name of initial.yao) {
    const ref = yaoCache.get(name);
    if (ref) seed("yao", ref.id);
  }

  while (worklist.length > 0) {
    const item = worklist.shift()!;
    const detail = item.kind === "fang"
      ? await getFangPopoverData(db, item.id)
      : await getYaoPopoverData(db, item.id);
    if (!detail) continue;
    // 嵌套标记先解析，浮层内部链接才同样可点。
    const childNames = extractMarkerNames(detail.bodySource, linkable);
    for (const name of childNames.yao) await loadYao(name);
    const body = renderTcmMarkers(detail.bodySource, styles, {resolveHref});
    data[item.id] = {
      kind: item.kind,
      id: item.id,
      name: detail.name,
      meta: detail.meta,
      ...(isFangDetail(detail)
        ? {
            yao: detail.bodies.map((entry) => ({
              name: entry.showName,
              amount: entry.amount,
              suffix: "",
              extra: entry.extra,
            })),
          }
        : {}),
      body,
      url: detail.url,
    };
    for (const name of childNames.fang) {
      const ref = fangByName.get(name);
      if (ref) seed("fang", ref.id);
    }
    for (const name of childNames.yao) {
      const ref = yaoCache.get(normalizeYaoName(stripYaoNo(name)));
      if (ref) seed("yao", ref.id);
    }
  }

  return {titleHtml, bodyHtml: renderedBody, runtimeHtml: buildRuntimeHtml(data)};
}

// front-decoupling:ignore-start
// 以下区段只服务后台反向引用视图（ajax/tcm/fang-references 仍导入
// ensureMarkerCitations）。它读写旧索引表，属于后台写路径，不进入前台取数链；
// 静态解耦检查按区段标记跳过。前台 buildTcmMarkerLayer 不调用这里的任何函数。
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

/** D1 caps a batch; one book's citations (752 rows here) would blow one call. */
const CITATION_BATCH_SIZE = 100;

/**
 * Make sure `ext_marker_citations` holds this book's reverse index.
 * Only the admin reverse-reference view calls this now; the public reader
 * stopped consuming the index (ADR-0066 决策 15).
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

  const linkable = linkableCodes(mapStyles(await getAppStyleConfig(db)));
  const {results} = await db
    .prepare(
      "SELECT id, rowid AS seq, data FROM items " +
        "WHERE book_id = ? AND tcm_kind IN ('section', 'chapter') AND status IN (1, 4)",
    )
    .bind(bookId)
    .all<{id: string; seq: number; data: unknown}>();

  const rows: D1PreparedStatement[] = [];
  for (const row of results ?? []) {
    const data = parseData(row.data);
    const names = extractMarkerNames(String(data.description ?? ""), linkable);
    const fangNames = new Set([...names.fang, ...extractFangListNames(data)]);
    const sectionId = String(row.id);
    const sectionTitle = String(data.title ?? "");
    const seq = Number(row.seq) || 0;
    for (const name of fangNames) {
      rows.push(
        db
          .prepare(
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
            "INSERT OR REPLACE INTO ext_marker_citations " +
              "(book_id, marker_code, marker_name, section_id, section_title, section_seq) " +
              "VALUES (?, ?, ?, ?, ?, ?)",
          )
          .bind(bookId, "u", name, sectionId, sectionTitle, seq),
      );
    }
  }

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
// front-decoupling:ignore-end
