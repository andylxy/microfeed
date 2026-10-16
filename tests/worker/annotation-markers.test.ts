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

// The catalogue migrations 0071 / 0115 seed (source app defaults, spec §4.2):
// 0071 the thirteen core markers, 0115 the two site-local ones (`s` / `l`).
const SEED_CODES = [
  "f", "a", "u", "x", "w", "q", "m", "n", "g", "r", "v", "y", "h", "s", "l",
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
  it("lists the fifteen seed markers for a reader", async () => {
    const response = await listAnnotationMarkersEndpoint({
      locals: locals(new Set([PERMISSION_CODES.CONTENT_ANNOTATION_MARKERS_READ])),
      request: new Request("https://example.test/ajax/annotation-markers/list"),
    } as any);
    expect(response.status).toBe(200);
    const data = (await response.json()) as {markers: {code: string; title: string}[]};
    expect(data.markers.map((m) => m.code).sort()).toEqual(SEED_CODES_SORTED);
  });

  it("seeds the source app styles: colours, small fonts and link types", async () => {
    // linkType: 1 = 中药 ($u), 2 = 方剂 ($f), 3 = 名词 ($g); everything else 0.
    const {results} = await env.FEED_DB
      .prepare(
        "SELECT code, title, color, small_font, small_font_scale, link_type " +
        "FROM ext_annotation_markers ORDER BY sort_order",
      )
      .all<{
        code: string;
        title: string;
        color: string;
        small_font: number;
        small_font_scale: number;
        link_type: number;
      }>();

    const byCode = new Map(results.map((row) => [row.code, row]));
    expect(byCode.get("u")?.link_type).toBe(1);
    expect(byCode.get("f")?.link_type).toBe(2);
    expect(byCode.get("g")?.link_type).toBe(3);

    // Small-font markers: $r / $a / $w per the source app, plus $s / $l which
    // 0115 seeded as the two site-local ones.
    const smallFontCodes = ["r", "a", "w", "s", "l"];
    for (const code of smallFontCodes) {
      expect(byCode.get(code)?.small_font).toBe(1);
    }
    for (const code of SEED_CODES.filter((c) => !smallFontCodes.includes(c))) {
      expect(byCode.get(code)?.small_font).toBe(0);
    }

    // 0068 seeded three titles against the source semantics; 0071 fixed the
    // names, and 0117 stripped the `$x ` prefix so `title` is a plain label
    // (the `code` column carries the grammar).
    expect(byCode.get("a")?.title).toBe("按语");
    expect(byCode.get("u")?.title).toBe("中药");
    expect(byCode.get("x")?.title).toBe("橙字");
    // 0115 added the two site-local codes; 0117 stripped their prefixes too.
    expect(byCode.get("s")?.title).toBe("总起");
    expect(byCode.get("l")?.title).toBe("异文");
    // 0110 aligned these two colours with the source app's own definitions:
    // $w was a softer green than Color.GREEN, and $y had no colour at all.
    expect(byCode.get("w")?.color).toBe("#00FF00");
    expect(byCode.get("y")?.color).toBe("#9A764F");
    // 0071 kept the source's `argb(230, 0, 128, 255)` as this rgba value.
    expect(byCode.get("g")?.color).toBe("rgba(0, 128, 255, 0.90)");
    // 0109 turned the renderer's hard-coded 0.7 into data; the column default
    // keeps every seed row rendering exactly as it did before.
    for (const code of SEED_CODES) {
      expect(byCode.get(code)?.small_font_scale).toBe(0.7);
    }
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
      request: post({code: "z", title: "针灸"}),
    } as any);
    expect(created.status).toBe(200);
    expect(await listCodes()).toEqual([...SEED_CODES_SORTED, "z"]);

    const dup = await createAnnotationMarkerEndpoint({
      locals: locals(new Set([PERMISSION_CODES.CONTENT_ANNOTATION_MARKERS_MANAGE])),
      request: post({code: "z", title: "针灸"}),
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

  it("updates the title and deletes a marker", async () => {
    await createAnnotationMarkerEndpoint({
      locals: locals(new Set([PERMISSION_CODES.CONTENT_ANNOTATION_MARKERS_MANAGE])),
      request: post({code: "z", title: "针灸"}),
    } as any);

    const updated = await updateAnnotationMarkerEndpoint({
      locals: locals(new Set([PERMISSION_CODES.CONTENT_ANNOTATION_MARKERS_MANAGE])),
      request: post({code: "z", title: "针灸科"}),
    } as any);
    expect(updated.status).toBe(200);
    const data = (await updated.json()) as {markers: {code: string; title: string}[]};
    const z = data.markers.find((m) => m.code === "z");
    expect(z?.title).toBe("针灸科");

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

  it("writes the style fields, and a partial payload leaves them alone", async () => {
    await createAnnotationMarkerEndpoint({
      locals: locals(new Set([PERMISSION_CODES.CONTENT_ANNOTATION_MARKERS_MANAGE])),
      request: post({code: "z", title: "针灸"}),
    } as any);

    const styled = await updateAnnotationMarkerEndpoint({
      locals: locals(new Set([PERMISSION_CODES.CONTENT_ANNOTATION_MARKERS_MANAGE])),
      request: post({
        code: "z",
        title: "针灸",
        color: "#123456",
        smallFont: true,
        smallFontScale: 0.55,
        linkType: 1,
      }),
    } as any);
    expect(styled.status).toBe(200);
    const data = (await styled.json()) as {
      markers: {
        code: string;
        title: string;
        color: string;
        smallFont: boolean;
        smallFontScale: number;
        linkType: number;
      }[];
    };
    const z = data.markers.find((m) => m.code === "z");
    expect(z?.color).toBe("#123456");
    expect(z?.smallFont).toBe(true);
    expect(z?.smallFontScale).toBe(0.55);
    expect(z?.linkType).toBe(1);

    // The update endpoint is a patch: a payload that carries no style fields
    // must not blank out the ones it never mentioned.
    const renamed = await updateAnnotationMarkerEndpoint({
      locals: locals(new Set([PERMISSION_CODES.CONTENT_ANNOTATION_MARKERS_MANAGE])),
      request: post({code: "z", title: "针灸科"}),
    } as any);
    expect(renamed.status).toBe(200);
    const after = ((await renamed.json()) as {markers: (typeof data)["markers"]}).markers.find(
      (m) => m.code === "z",
    );
    expect(after?.title).toBe("针灸科");
    expect(after?.color).toBe("#123456");
    expect(after?.smallFontScale).toBe(0.55);
  });

  it("rejects an invalid colour, scale or link type", async () => {
    await createAnnotationMarkerEndpoint({
      locals: locals(new Set([PERMISSION_CODES.CONTENT_ANNOTATION_MARKERS_MANAGE])),
      request: post({code: "z", title: "针灸"}),
    } as any);

    const badBodies = [
      {color: "red"},
      {color: "#12345"},
      {color: "rgb(300, 0, 0)"},
      {smallFontScale: 0.1},
      {smallFontScale: 2},
      {smallFontScale: "wide"},
      {linkType: 9},
      {smallFont: "yes"},
    ];
    for (const bad of badBodies) {
      const response = await updateAnnotationMarkerEndpoint({
        locals: locals(new Set([PERMISSION_CODES.CONTENT_ANNOTATION_MARKERS_MANAGE])),
        request: post({code: "z", title: "针灸", ...bad}),
      } as any);
      expect(response.status, JSON.stringify(bad)).toBe(400);
    }

    // The seeded rgba() value is the reason the alpha form must be accepted.
    const accepted = await updateAnnotationMarkerEndpoint({
      locals: locals(new Set([PERMISSION_CODES.CONTENT_ANNOTATION_MARKERS_MANAGE])),
      request: post({code: "z", title: "针灸", color: "rgba(0, 128, 255, 0.90)"}),
    } as any);
    expect(accepted.status).toBe(200);
  });

  it("refuses mutations to an account without the manage permission", async () => {
    const response = await createAnnotationMarkerEndpoint({
      locals: locals(new Set([PERMISSION_CODES.CONTENT_ANNOTATION_MARKERS_READ])),
      request: post({code: "z", title: "针灸"}),
    } as any);
    expect(response.status).toBe(403);
  });
});
