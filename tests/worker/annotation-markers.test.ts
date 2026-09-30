import {env} from "cloudflare:workers";
import {afterEach, describe, expect, it} from "vitest";

import {
  createAnnotationMarkerEndpoint,
  deleteAnnotationMarkerEndpoint,
  listAnnotationMarkersEndpoint,
  updateAnnotationMarkerEndpoint,
} from "@/server/admin/annotation-marker-handlers";
import {PERMISSION_CODES} from "@/shared/Constants";
import type {RbacLocals} from "@/server/rbac/guard";

// The 13-marker catalogue migration 0071 seeds (source app defaults, spec §4.2).
const SEED_CODES = [
  "f", "a", "u", "x", "w", "q", "m", "n", "g", "r", "v", "y", "h",
];

const SEED_CODES_SORTED = [...SEED_CODES].sort();

function locals(permissions: Set<string>): RbacLocals {
  return {authUser: {id: "u_test"}, rbacPermissions: permissions};
}

function post(body: unknown): Request {
  return new Request("https://example.test/ajax/annotation-markers/create", {
    body: JSON.stringify(body),
    headers: {"content-type": "application/json"},
    method: "POST",
  });
}

async function listCodes(): Promise<string[]> {
  const response = await listAnnotationMarkersEndpoint({
    locals: locals(new Set(["*"])),
    request: new Request("https://example.test/ajax/annotation-markers/list"),
  } as any);
  const data = (await response.json()) as {markers: {code: string}[]};
  return data.markers.map((m) => m.code).sort();
}

afterEach(async () => {
  // Leave the migration seed intact; only remove markers this test created.
  await env.FEED_DB
    .prepare(`DELETE FROM ext_annotation_markers WHERE code NOT IN (${SEED_CODES.map(() => "?").join(",")})`)
    .bind(...SEED_CODES)
    .run();
});

describe("annotation marker handlers", () => {
  it("lists the thirteen seed markers for a reader", async () => {
    const response = await listAnnotationMarkersEndpoint({
      locals: locals(new Set([PERMISSION_CODES.CONTENT_ANNOTATION_MARKERS_READ])),
      request: new Request("https://example.test/ajax/annotation-markers/list"),
    } as any);
    expect(response.status).toBe(200);
    const data = (await response.json()) as {markers: {code: string; title: string; multi: boolean}[]};
    expect(data.markers.map((m) => m.code).sort()).toEqual(SEED_CODES_SORTED);
    expect(data.markers.find((m) => m.code === "x")?.multi).toBe(true);
  });

  it("seeds the source app styles: colours, small fonts and link types", async () => {
    // linkType: 1 = 中药 ($u), 2 = 方剂 ($f), 3 = 名词 ($g); everything else 0.
    const {results} = await env.FEED_DB
      .prepare(
        "SELECT code, title, color, small_font, link_type FROM ext_annotation_markers " +
        "ORDER BY sort_order",
      )
      .all<{code: string; title: string; color: string; small_font: number; link_type: number}>();

    const byCode = new Map(results.map((row) => [row.code, row]));
    expect(byCode.get("u")?.link_type).toBe(1);
    expect(byCode.get("f")?.link_type).toBe(2);
    expect(byCode.get("g")?.link_type).toBe(3);

    // Small-font markers per the source app: $r / $a / $w render at 0.7x.
    for (const code of ["r", "a", "w"]) {
      expect(byCode.get(code)?.small_font).toBe(1);
    }
    for (const code of SEED_CODES.filter((c) => !["r", "a", "w"].includes(c))) {
      expect(byCode.get(code)?.small_font).toBe(0);
    }

    // 0068 seeded three titles against the source semantics; 0071 fixed them.
    expect(byCode.get("a")?.title).toBe("$a 按语");
    expect(byCode.get("u")?.title).toBe("$u 中药");
    expect(byCode.get("x")?.title).toBe("$x 橙字");
    expect(byCode.get("w")?.color).toBe("#1CB55C");
    expect(results).toHaveLength(SEED_CODES.length);
  });

  it("refuses the list to an account without the read permission", async () => {
    const response = await listAnnotationMarkersEndpoint({
      locals: locals(new Set()),
      request: new Request("https://example.test/ajax/annotation-markers/list"),
    } as any);
    expect(response.status).toBe(403);
  });

  it("creates a marker and rejects duplicates and bad codes", async () => {
    const created = await createAnnotationMarkerEndpoint({
      locals: locals(new Set([PERMISSION_CODES.CONTENT_ANNOTATION_MARKERS_MANAGE])),
      request: post({code: "z", title: "$z 针灸", multi: false}),
    } as any);
    expect(created.status).toBe(200);
    expect(await listCodes()).toEqual([...SEED_CODES_SORTED, "z"]);

    const dup = await createAnnotationMarkerEndpoint({
      locals: locals(new Set([PERMISSION_CODES.CONTENT_ANNOTATION_MARKERS_MANAGE])),
      request: post({code: "z", title: "$z 针灸"}),
    } as any);
    expect(dup.status).toBe(409);

    const bad = await createAnnotationMarkerEndpoint({
      locals: locals(new Set([PERMISSION_CODES.CONTENT_ANNOTATION_MARKERS_MANAGE])),
      request: post({code: "TOOLONGCODE", title: "x"}),
    } as any);
    expect(bad.status).toBe(400);

    const noTitle = await createAnnotationMarkerEndpoint({
      locals: locals(new Set([PERMISSION_CODES.CONTENT_ANNOTATION_MARKERS_MANAGE])),
      request: post({code: "q"}),
    } as any);
    expect(noTitle.status).toBe(400);
  });

  it("updates title and multi, and deletes a marker", async () => {
    await createAnnotationMarkerEndpoint({
      locals: locals(new Set([PERMISSION_CODES.CONTENT_ANNOTATION_MARKERS_MANAGE])),
      request: post({code: "z", title: "$z 针灸"}),
    } as any);

    const updated = await updateAnnotationMarkerEndpoint({
      locals: locals(new Set([PERMISSION_CODES.CONTENT_ANNOTATION_MARKERS_MANAGE])),
      request: post({code: "z", title: "$z 针灸科", multi: true}),
    } as any);
    expect(updated.status).toBe(200);
    const data = (await updated.json()) as {markers: {code: string; title: string; multi: boolean}[]};
    const z = data.markers.find((m) => m.code === "z");
    expect(z?.title).toBe("$z 针灸科");
    expect(z?.multi).toBe(true);

    const deleted = await deleteAnnotationMarkerEndpoint({
      locals: locals(new Set([PERMISSION_CODES.CONTENT_ANNOTATION_MARKERS_MANAGE])),
      request: post({code: "z"}),
    } as any);
    expect(deleted.status).toBe(200);
    expect(await listCodes()).toEqual(SEED_CODES_SORTED);
  });

  it("returns 404 when updating or deleting a missing marker", async () => {
    const missing = await updateAnnotationMarkerEndpoint({
      locals: locals(new Set([PERMISSION_CODES.CONTENT_ANNOTATION_MARKERS_MANAGE])),
      request: post({code: "nope", title: "x"}),
    } as any);
    expect(missing.status).toBe(404);

    const missingDelete = await deleteAnnotationMarkerEndpoint({
      locals: locals(new Set([PERMISSION_CODES.CONTENT_ANNOTATION_MARKERS_MANAGE])),
      request: post({code: "nope"}),
    } as any);
    expect(missingDelete.status).toBe(404);
  });

  it("refuses mutations to an account without the manage permission", async () => {
    const response = await createAnnotationMarkerEndpoint({
      locals: locals(new Set([PERMISSION_CODES.CONTENT_ANNOTATION_MARKERS_READ])),
      request: post({code: "z", title: "$z 针灸"}),
    } as any);
    expect(response.status).toBe(403);
  });
});
