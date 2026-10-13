/**
 * CRUD for the annotation markers (`ext_annotation_markers`).
 *
 * A marker is a short code (e.g. `f`), a display title (`$f 方剂`) and — since
 * 0071 — the presentation the renderer applies to `$<code>{...}`: a colour, an
 * optional reduced font size and, for the three entity markers, a link type
 * (1 = 中药, 2 = 方剂, 3 = 名词). 0109 turned the reduced size into a ratio
 * (`small_font_scale`) instead of the hard-coded 0.7.
 *
 * All of those are editable here, so the catalogue is configuration rather than
 * migration SQL. The wangEditor rich-text editor fetches the list on mount and
 * registers one toolbar button per row, so adding a marker needs no redeploy —
 * the next page load shows the new button.
 *
 * Permissions:
 *   - `content:annotation-markers:read`   — list (anyone who may edit content)
 *   - `content:annotation-markers:manage` — create / update / delete
 *
 * The `code` is the stable identity and is baked into authored content as
 * `$<code>{...}`, so it is **immutable** after creation.
 */

import {env} from "cloudflare:workers";

import type {APIRoute} from "astro";
import {jsonResponse, localizedError} from "@/server/http";
import {PERMISSION_CODES} from "@/shared/Constants";
import {DEFAULT_SMALL_FONT_SCALE} from "@/shared/TcmMarkers";
import {requireRbac} from "@/server/rbac/guard";

/** 1–8 chars: lowercase letters, digits, underscore. Mirrors the role-code rule. */
const MARKER_CODE_PATTERN = /^[a-z0-9_]{1,8}$/u;

/** One 0–255 colour channel. */
const RGB_CHANNEL = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
/**
 * `#RGB`, `#RRGGBB`, `rgb(r,g,b)` or `rgba(r,g,b,a)`.
 *
 * The alpha form is not optional: `$g` (名词解释) is seeded as
 * `rgba(0, 128, 255, 0.90)` — the source app's `argb(230, 0, 128, 255)` — so a
 * hex-only rule would reject the catalogue's own value.
 */
const MARKER_COLOR_PATTERN = new RegExp(
  "^(?:#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|" +
    `rgba?\\(\\s*${RGB_CHANNEL}\\s*,\\s*${RGB_CHANNEL}\\s*,\\s*${RGB_CHANNEL}\\s*` +
    "(?:,\\s*(?:0(?:\\.\\d+)?|1(?:\\.0+)?)\\s*)?\\))$",
  "u",
);

/** Fallback for a row whose `color` is NULL — the same grey the renderer uses. */
const DEFAULT_MARKER_COLOR = "#808080";

/** link_type: 0 = plain, 1 = 中药, 2 = 方剂, 3 = 名词. */
const ALLOWED_LINK_TYPES = [0, 1, 2, 3];

/** The write layer owns the usable range; the column carries no CHECK. */
const MIN_SMALL_FONT_SCALE = 0.3;
const MAX_SMALL_FONT_SCALE = 1;

interface AnnotationMarkerRow {
  id: string;
  code: string;
  title: string;
  multi: number;
  sort_order: number;
  color: string | null;
  small_font: number;
  small_font_scale: number | null;
  link_type: number;
}

export interface AnnotationMarker {
  id: string;
  code: string;
  title: string;
  multi: boolean;
  sortOrder: number;
  /** CSS-ready colour: `#RRGGBB` or `rgba(...)`. */
  color: string;
  /** True when the marker renders at `smallFontScale`. */
  smallFont: boolean;
  /** Ratio applied when `smallFont` is set, e.g. `0.7` for 70%. */
  smallFontScale: number;
  linkType: number;
}

function toMarker(row: AnnotationMarkerRow): AnnotationMarker {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    multi: row.multi === 1,
    sortOrder: row.sort_order,
    color: row.color ?? DEFAULT_MARKER_COLOR,
    smallFont: row.small_font === 1,
    smallFontScale: Number(row.small_font_scale ?? DEFAULT_SMALL_FONT_SCALE),
    linkType: Number(row.link_type ?? 0),
  };
}

const MARKER_COLUMNS =
  "id, code, title, multi, sort_order, color, small_font, small_font_scale, link_type";

export async function listAnnotationMarkers(db: D1Database): Promise<AnnotationMarker[]> {
  const result = await db
    .prepare(
      `SELECT ${MARKER_COLUMNS} FROM ext_annotation_markers ` +
        "ORDER BY sort_order ASC, code ASC",
    )
    .all<AnnotationMarkerRow>();
  return (result.results ?? []).map(toMarker);
}

export const listAnnotationMarkersEndpoint: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_ANNOTATION_MARKERS_READ,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  return jsonResponse({markers: await listAnnotationMarkers(env.FEED_DB)});
};

/**
 * The presentation fields, read out of a request body.
 *
 * `undefined` means "not supplied" and leaves the stored value alone — the
 * update endpoint is a patch, so an older client that only sends
 * `title`/`multi` keeps working and never resets a colour it cannot see.
 */
interface StylePatch {
  color?: string;
  smallFont?: boolean;
  smallFontScale?: number;
  linkType?: number;
}

function readStylePatch(body: Record<string, unknown>): StylePatch | null {
  const patch: StylePatch = {};

  if (body.color !== undefined) {
    const color = typeof body.color === "string" ? body.color.trim() : "";
    if (!MARKER_COLOR_PATTERN.test(color)) return null;
    patch.color = color;
  }

  if (body.smallFont !== undefined) {
    if (typeof body.smallFont !== "boolean") return null;
    patch.smallFont = body.smallFont;
  }

  if (body.smallFontScale !== undefined) {
    const scale = Number(body.smallFontScale);
    if (
      !Number.isFinite(scale) ||
      scale < MIN_SMALL_FONT_SCALE ||
      scale > MAX_SMALL_FONT_SCALE
    ) {
      return null;
    }
    patch.smallFontScale = scale;
  }

  if (body.linkType !== undefined) {
    const linkType = Number(body.linkType);
    if (!ALLOWED_LINK_TYPES.includes(linkType)) return null;
    patch.linkType = linkType;
  }

  return patch;
}

function readBody(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export const createAnnotationMarkerEndpoint: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_ANNOTATION_MARKERS_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;

  const body = readBody(await request.json().catch(() => null));
  const code = typeof body?.code === "string" ? body.code.trim().toLowerCase() : "";
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const multi = body?.multi === true || body?.multi === 1;
  const style = body ? readStylePatch(body) : null;
  if (!MARKER_CODE_PATTERN.test(code) || !title || !style) {
    return localizedError(request, "errors.annotationMarkers.invalidInput", 400);
  }

  const existing = await env.FEED_DB
    .prepare("SELECT id FROM ext_annotation_markers WHERE code = ?")
    .bind(code)
    .first<{id: string}>();
  if (existing) {
    return localizedError(request, "errors.annotationMarkers.duplicateCode", 409);
  }

  const now = Date.now();
  await env.FEED_DB
    .prepare(
      "INSERT INTO ext_annotation_markers " +
        "(id, code, title, multi, sort_order, color, small_font, small_font_scale, " +
        "link_type, created_at_ms, updated_at_ms) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      `am_${code}`,
      code,
      title,
      multi ? 1 : 0,
      999,
      style.color ?? DEFAULT_MARKER_COLOR,
      style.smallFont ? 1 : 0,
      style.smallFontScale ?? DEFAULT_SMALL_FONT_SCALE,
      style.linkType ?? 0,
      now,
      now,
    )
    .run();
  return jsonResponse({markers: await listAnnotationMarkers(env.FEED_DB)});
};

export const updateAnnotationMarkerEndpoint: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_ANNOTATION_MARKERS_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;

  const body = readBody(await request.json().catch(() => null));
  const code = typeof body?.code === "string" ? body.code.trim().toLowerCase() : "";
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const multi = body?.multi === true || body?.multi === 1;
  const style = body ? readStylePatch(body) : null;
  if (!code || !title || !style) {
    return localizedError(request, "errors.annotationMarkers.invalidInput", 400);
  }

  const existing = await env.FEED_DB
    .prepare("SELECT id FROM ext_annotation_markers WHERE code = ?")
    .bind(code)
    .first<{id: string}>();
  if (!existing) {
    return localizedError(request, "errors.annotationMarkers.notFound", 404);
  }

  // Only the supplied style fields are written, so a partial payload cannot
  // blank out a colour it never carried.
  const assignments = ["title = ?", "multi = ?", "updated_at_ms = ?"];
  const binds: unknown[] = [title, multi ? 1 : 0, Date.now()];
  if (style.color !== undefined) {
    assignments.push("color = ?");
    binds.push(style.color);
  }
  if (style.smallFont !== undefined) {
    assignments.push("small_font = ?");
    binds.push(style.smallFont ? 1 : 0);
  }
  if (style.smallFontScale !== undefined) {
    assignments.push("small_font_scale = ?");
    binds.push(style.smallFontScale);
  }
  if (style.linkType !== undefined) {
    assignments.push("link_type = ?");
    binds.push(style.linkType);
  }
  binds.push(code);

  await env.FEED_DB
    .prepare(`UPDATE ext_annotation_markers SET ${assignments.join(", ")} WHERE code = ?`)
    .bind(...binds)
    .run();
  return jsonResponse({markers: await listAnnotationMarkers(env.FEED_DB)});
};

export const deleteAnnotationMarkerEndpoint: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_ANNOTATION_MARKERS_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;

  const body = (await request.json().catch(() => null)) as {code?: unknown} | null;
  const code = typeof body?.code === "string" ? body.code.trim().toLowerCase() : "";
  if (!code) {
    return localizedError(request, "errors.annotationMarkers.invalidInput", 400);
  }

  const existing = await env.FEED_DB
    .prepare("SELECT id FROM ext_annotation_markers WHERE code = ?")
    .bind(code)
    .first<{id: string}>();
  if (!existing) {
    return localizedError(request, "errors.annotationMarkers.notFound", 404);
  }

  await env.FEED_DB
    .prepare("DELETE FROM ext_annotation_markers WHERE code = ?")
    .bind(code)
    .run();
  return jsonResponse({markers: await listAnnotationMarkers(env.FEED_DB)});
};
