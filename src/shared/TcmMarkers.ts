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
  /** Render at 0.7x size (source app: `RelativeSizeSpan(0.7f)`). */
  smallFont: boolean;
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

const MARKER_START = /\$([a-zA-Z]{1,10})\{/y;

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
  if (style.smallFont) styles.push("font-size:0.7em");
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
