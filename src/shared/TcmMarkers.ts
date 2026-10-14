/**
 * Renderer for the TCM inline annotation markers (`$X{...}`).
 *
 * The ctwh source data (5 classics, 804 formulas, 172 herbs, 17 terms) carries
 * its rich-text semantics as plain-text markers inside the body:
 * `$u{桂枝}` is a herb, `$f{桂枝汤}` a formula, `$w{三两}` a dosage, `$a{…}`
 * a small-print note — 13 markers in total, each with a colour, an optional
 * 0.7x small font, and for the three entity markers a link type
 * (1 = 中药, 2 = 方剂, 3 = 名词). The source Android renderer
 * (`TipsTextRenderer` in the old app repo) parses them with a single-pass
 * regex that cannot nest; this renderer deliberately improves on that: inner
 * markers are rendered recursively, and malformed input degrades to literal
 * text instead of dropping segments (spec `.scratch/tcm-import/spec.md` §7).
 *
 * Runtime neutral: string in, string out, no DOM, no imports — safe for both
 * the Worker and the browser.
 */

/** One marker's presentation, mirroring the source app's `StyleConfig`. */
export interface TcmMarkerStyle {
  /** Marker letter, e.g. `"u"`. */
  code: string;
  /** CSS-ready colour: `#RRGGBB` or `rgba(...)`. */
  color: string;
  /** Render at a reduced size (source app: `RelativeSizeSpan`). */
  smallFont: boolean;
  /**
   * Ratio applied when `smallFont` is set, e.g. `0.7` for 70%. Absent means
   * {@link DEFAULT_SMALL_FONT_SCALE} — that keeps every style object built
   * before this field existed rendering exactly as it did.
   */
  smallFontScale?: number;
  /** 0 = plain, 1 = 中药, 2 = 方剂, 3 = 名词. */
  linkType: number;
}

export interface TcmMarkerRenderOptions {
  /**
   * Resolves the link target for a linkable marker (linkType 1/2/3). Return
   * null/undefined to emit a bare `<span>` with `data-tcm-*` attributes
   * instead of an anchor. When omitted entirely, linkable markers render as
   * spans carrying the attributes for a later pass to upgrade.
   */
  resolveHref?: (linkType: number, name: string) => string | null | undefined;
}

/**
 * Everything a server needs to render markers in one pass: the catalogue
 * (loaded from `ext_annotation_markers`) plus an optional name→URL resolver
 * for the linkable entity markers (linkType 1 = 中药, 2 = 方剂, 3 = 名词).
 */
export interface TcmMarkerRenderContext {
  styles: TcmMarkerStyle[];
  resolveHref?: (linkType: number, name: string) => string | null | undefined;
}

// Sticky: `renderSegment` / `plainSegment` 在已定位的下标上起步扫描。
const MARKER_START = /\$([a-zA-Z]{1,10})\{/y;
// 非 sticky 副本：只用来判断「整段文本里有没有标记」，与扫描用的那个同源同形。
const MARKER_ANY = /\$[a-zA-Z]{1,10}\{/;

/** Ratio used by a `smallFont` marker whose row carries no explicit ratio. */
export const DEFAULT_SMALL_FONT_SCALE = 0.7;

/** Clamp to the range the admin write layer accepts, so a hand-edited row can
 *  never render text invisible (0) or larger than the body (2). */
function smallFontScale(style: TcmMarkerStyle): number {
  const raw = Number(style.smallFontScale);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SMALL_FONT_SCALE;
  return Math.min(1, Math.max(0.3, raw));
}

/** `&` → `&amp;`, `"` → `&quot;` — enough for safe attribute values. */
function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * Index of the `}` that closes a marker opened just before `from`, counting
 * nested braces. Returns -1 when the marker never closes (the source data
 * carries a few of those, e.g. `$m{{虚者}`).
 */
function findMatchingBrace(source: string, from: number): number {
  let depth = 1;
  for (let i = from; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function styleFor(styles: TcmMarkerStyle[], code: string): TcmMarkerStyle | undefined {
  return styles.find((style) => style.code === code);
}

function wrap(
  inner: string,
  style: TcmMarkerStyle,
  name: string,
  options: TcmMarkerRenderOptions,
): string {
  const styles = [`color:${style.color}`];
  if (style.smallFont) styles.push(`font-size:${smallFontScale(style)}em`);
  const attributes = [
    `class="mf-mk mf-mk-${escapeAttr(style.code)}"`,
    `style="${escapeAttr(styles.join(";"))}"`,
  ];
  if (style.linkType > 0) {
    attributes.push(`data-tcm-kind="${escapeAttr(String(style.linkType))}"`);
    attributes.push(`data-tcm-name="${escapeAttr(name)}"`);
  }
  const span = `<span ${attributes.join(" ")}>${inner}</span>`;
  if (style.linkType === 0 || !options.resolveHref) return span;
  const href = options.resolveHref(style.linkType, name);
  if (!href) return span;
  return `<a href="${escapeAttr(href)}">${span}</a>`;
}

function renderSegment(
  source: string,
  start: number,
  end: number,
  styles: TcmMarkerStyle[],
  options: TcmMarkerRenderOptions,
): string {
  let out = "";
  let i = start;
  while (i < end) {
    const char = source[i];
    // Inside an HTML tag the marker syntax is attribute text, not content —
    // copy tags verbatim so `<a href="...">` and friends survive untouched.
    if (char === "<") {
      const close = source.indexOf(">", i);
      const tagEnd = close === -1 ? end : Math.min(close + 1, end);
      out += source.slice(i, tagEnd);
      i = tagEnd;
      continue;
    }
    MARKER_START.lastIndex = i;
    const match = MARKER_START.exec(source);
    if (!match || match.index !== i) {
      out += char;
      i += 1;
      continue;
    }
    const code = match[1] ?? "";
    const contentStart = i + match[0].length;
    let close = findMatchingBrace(source, contentStart);
    if (close === -1) {
      // Malformed marker (never closes). Degrade the way the source app did:
      // consume up to the first `}` (or the end of the segment) so no text is
      // dropped, then keep scanning after it.
      const firstClose = source.indexOf("}", contentStart);
      close = firstClose === -1 ? end : firstClose;
      const style = styleFor(styles, code);
      if (!style) {
        out += source.slice(i, close === end ? end : close + 1);
        i = close === end ? end : close + 1;
        continue;
      }
      const raw = source.slice(contentStart, close);
      out += wrap(raw, style, raw, options);
      i = close === end ? end : close + 1;
      continue;
    }
    const style = styleFor(styles, code);
    const inner = renderSegment(source, contentStart, close, styles, options);
    if (!style) {
      // Unknown marker: strip the `$x{}` shell, keep the content readable.
      out += `<span class="mf-mk mf-mk-unknown" style="color:#808080">${inner}</span>`;
    } else {
      const raw = source.slice(contentStart, close);
      out += wrap(inner, style, raw, options);
    }
    i = close + 1;
  }
  return out;
}

/**
 * Render `$X{...}` markers to styled HTML.
 *
 * With an empty style list the body is returned unchanged — callers that
 * failed to load the marker catalogue must not half-style content. Inside a
 * non-empty catalogue an unknown marker degrades to a grey span with its
 * `$x{}` shell stripped. Malformed markers never drop text.
 */
export function renderTcmMarkers(
  body: string,
  styles: TcmMarkerStyle[],
  options: TcmMarkerRenderOptions = {},
): string {
  const source = String(body ?? "");
  if (!source.trim() || styles.length === 0) return source;
  return renderSegment(source, 0, source.length, styles, options);
}

/**
 * 纯文本出口：剥掉全部 `$x{}` 外壳、保留内容。用于 `<title>` /
 * `<meta name="description">` 等不能放 HTML 的场景——外壳在浏览器标签页与
 * 搜索摘要里是噪声，内容（按语 / 剂量 / 出处……）是有意义文本。
 *
 * 与 `renderTcmMarkers` 共用同一套标记语法原语（`MARKER_START` /
 * `findMatchingBrace`），不另写一份解析；语义与未知码降级保持相同
 * （`mf-mk-unknown`）：外壳丢、内容留、嵌套递归。HTML 标签整体丢弃
 * （调用方传的应是 item.title / content_text 这类纯文本，防的是万一）。
 */
export function markersToPlainText(text: string): string {
  const source = String(text ?? "");
  if (!source.trim()) return source;
  return plainSegment(source, 0, source.length);
}

function plainSegment(source: string, start: number, end: number): string {
  let out = "";
  let i = start;
  while (i < end) {
    const char = source[i];
    if (char === "<") {
      const close = source.indexOf(">", i);
      if (close === -1) {
        // 没有配对 `>` 的裸 `<` 不是标签：按字面字符保留并继续扫描，避免吞掉
        // 其后全部文本（与 renderSegment 对未闭合 `<` 的处理保持一致）。
        out += char;
        i += 1;
        continue;
      }
      i = Math.min(close + 1, end);
      continue;
    }
    MARKER_START.lastIndex = i;
    const match = MARKER_START.exec(source);
    if (!match || match.index !== i) {
      out += char;
      i += 1;
      continue;
    }
    const contentStart = i + match[0].length;
    let close = findMatchingBrace(source, contentStart);
    if (close === -1) {
      // 未闭合：与 renderSegment 的降级一致——吃到第一个 `}`（或段尾），
      // 内容保留，后续文本不被吞。
      const firstClose = source.indexOf("}", contentStart);
      close = firstClose === -1 ? end : firstClose;
      out += plainSegment(source, contentStart, close);
      i = close === end ? end : close + 1;
      continue;
    }
    out += plainSegment(source, contentStart, close);
    i = close + 1;
  }
  return out;
}

/**
 * 文本里有没有标记语法（`$x{`）。供调用方决定要不要走纯文本出口——标记语法
 * 只在这里定义一次，不各处重抄正则。
 */
export function hasTcmMarker(text: string): boolean {
  return MARKER_ANY.test(String(text ?? ""));
}
