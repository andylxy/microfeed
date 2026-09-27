/**
 * CRUD for the annotation markers (`ext_annotation_markers`).
 *
 * A marker is a short code (e.g. `f`) plus a display title (`$f 方剂`). The
 * wangEditor rich-text editor fetches the list on mount and registers one
 * toolbar button per row, so adding a marker needs no redeploy — the next page
 * load shows the new button.
 *
 * Permissions:
 *   - `content:annotation-markers:read`   — list (anyone who may edit content)
 *   - `content:annotation-markers:manage` — create / update / delete
 *
 * The `code` is the stable identity and is baked into authored content as
 * `$<code>{...}`, so it is **immutable** after creation; only `title` and
 * `multi` may change.
 */

import {env} from "cloudflare:workers";

import type {APIRoute} from "astro";
import {jsonResponse, localizedError} from "@/server/http";
import {PERMISSION_CODES} from "@/shared/Constants";
import {requireRbac} from "@/server/rbac/guard";

/** 1–8 chars: lowercase letters, digits, underscore. Mirrors the role-code rule. */
const MARKER_CODE_PATTERN = /^[a-z0-9_]{1,8}$/u;

interface AnnotationMarkerRow {
  id: string;
  code: string;
  title: string;
  multi: number;
  sort_order: number;
}

export interface AnnotationMarker {
  id: string;
  code: string;
  title: string;
  multi: boolean;
  sortOrder: number;
}

function toMarker(row: AnnotationMarkerRow): AnnotationMarker {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    multi: row.multi === 1,
    sortOrder: row.sort_order,
  };
}

export async function listAnnotationMarkers(db: D1Database): Promise<AnnotationMarker[]> {
  const result = await db
    .prepare(
      "SELECT id, code, title, multi, sort_order FROM ext_annotation_markers " +
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

export const createAnnotationMarkerEndpoint: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_ANNOTATION_MARKERS_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;

  const body = (await request.json().catch(() => null)) as
    | {code?: unknown; title?: unknown; multi?: unknown}
    | null;
  const code = typeof body?.code === "string" ? body.code.trim().toLowerCase() : "";
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const multi = body?.multi === true || body?.multi === 1;
  if (!MARKER_CODE_PATTERN.test(code) || !title) {
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
        "(id, code, title, multi, sort_order, created_at_ms, updated_at_ms) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(`am_${code}`, code, title, multi ? 1 : 0, 999, now, now)
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

  const body = (await request.json().catch(() => null)) as
    | {code?: unknown; title?: unknown; multi?: unknown}
    | null;
  const code = typeof body?.code === "string" ? body.code.trim().toLowerCase() : "";
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const multi = body?.multi === true || body?.multi === 1;
  if (!code || !title) {
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
    .prepare(
      "UPDATE ext_annotation_markers SET title = ?, multi = ?, updated_at_ms = ? " +
        "WHERE code = ?",
    )
    .bind(title, multi ? 1 : 0, Date.now(), code)
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
