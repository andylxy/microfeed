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

const SEED_CODES = ["f", "a", "u", "x"];

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
  it("lists the four seed markers for a reader", async () => {
    const response = await listAnnotationMarkersEndpoint({
      locals: locals(new Set([PERMISSION_CODES.CONTENT_ANNOTATION_MARKERS_READ])),
      request: new Request("https://example.test/ajax/annotation-markers/list"),
    } as any);
    expect(response.status).toBe(200);
    const data = (await response.json()) as {markers: {code: string; title: string; multi: boolean}[]};
    expect(data.markers.map((m) => m.code).sort()).toEqual(["a", "f", "u", "x"]);
    expect(data.markers.find((m) => m.code === "x")?.multi).toBe(true);
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
    expect(await listCodes()).toEqual(["a", "f", "u", "x", "z"]);

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
    expect(await listCodes()).toEqual(["a", "f", "u", "x"]);
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
