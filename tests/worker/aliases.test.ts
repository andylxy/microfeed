import {env} from "cloudflare:workers";
import {afterEach, describe, expect, it} from "vitest";

import {
  createAliasEndpoint,
  deleteAliasEndpoint,
  listAliasesEndpoint,
  updateAliasEndpoint,
} from "@/server/admin/alias-handlers";
import {PERMISSION_CODES} from "@/shared/Constants";
import type {RbacLocals} from "@/server/rbac/guard";

interface Row {
  id: string | null;
  bieming: string;
  name: string;
  source: "manual" | "derived" | "hidden";
}

function locals(permissions: Set<string>): RbacLocals {
  return {authUser: {id: "u_test"}, rbacPermissions: permissions};
}

function request(method: string, body?: unknown): Request {
  return new Request("https://example.test/ajax/aliases", {
    ...(body === undefined
      ? {}
      : {body: JSON.stringify(body), headers: {"content-type": "application/json"}}),
    method,
  });
}

const READ = new Set([PERMISSION_CODES.CONTENT_ALIAS_READ]);
const MANAGE = new Set([PERMISSION_CODES.CONTENT_ALIAS_MANAGE]);

async function rows(response: Response): Promise<Row[]> {
  const data = (await response.json()) as {aliases: Row[]};
  return data.aliases;
}

async function extRow(bieming: string): Promise<{
  id: string;
  name: string;
  deleted: number;
} | null> {
  return env.FEED_DB
    .prepare("SELECT id, name, deleted FROM ext_tcm_aliases WHERE bieming = ?")
    .bind(bieming)
    .first<{id: string; name: string; deleted: number}>();
}

afterEach(async () => {
  await env.FEED_DB.prepare("DELETE FROM ext_tcm_aliases").run();
});

describe("alias handlers", () => {
  it("lists the alias dictionary for a reader", async () => {
    const response = await listAliasesEndpoint({
      locals: locals(READ),
      request: request("GET"),
    } as any);
    expect(response.status).toBe(200);
    // A fresh database has no imported herb items, so the list is empty — but it
    // must still be an array of {bieming, name, source} rows.
    expect(Array.isArray(await rows(response))).toBe(true);
  });

  it("refuses the list to an account without the read permission", async () => {
    const response = await listAliasesEndpoint({
      locals: locals(new Set()),
      request: request("GET"),
    } as any);
    expect(response.status).toBe(403);
  });

  it("creates, edits and deletes a manual override alias", async () => {
    let response = await createAliasEndpoint({
      locals: locals(MANAGE),
      request: request("POST", {bieming: "测试别名", name: "测试正名"}),
    } as any);
    expect(response.status).toBe(200);
    const created = (await rows(response)).find(
      (row) => row.bieming === "测试别名",
    );
    expect(created?.source).toBe("manual");
    expect(created?.id).toBeTruthy();
    const id = created!.id!;

    response = await updateAliasEndpoint({
      locals: locals(MANAGE),
      request: request("PUT", {id, bieming: "测试别名2", name: "测试正名2"}),
    } as any);
    expect(response.status).toBe(200);
    const edited = (await rows(response)).find((row) => row.id === id);
    expect(edited?.bieming).toBe("测试别名2");
    expect(edited?.name).toBe("测试正名2");

    response = await deleteAliasEndpoint({
      locals: locals(MANAGE),
      request: request("DELETE", {id}),
    } as any);
    expect(response.status).toBe(200);
    expect((await rows(response)).find((row) => row.id === id)).toBeUndefined();
  });

  it("upserts a manual override on a repeated create (no 409)", async () => {
    await createAliasEndpoint({
      locals: locals(MANAGE),
      request: request("POST", {bieming: "a1", name: "n1"}),
    } as any);
    const response = await createAliasEndpoint({
      locals: locals(MANAGE),
      request: request("POST", {bieming: "a1", name: "n1-updated"}),
    } as any);
    expect(response.status).toBe(200);
    const row = (await rows(response)).find((row) => row.bieming === "a1");
    expect(row?.name).toBe("n1-updated");
    expect(row?.source).toBe("manual");
  });

  it("rejects empty input, and a clashing rename on PUT", async () => {
    let response = await createAliasEndpoint({
      locals: locals(MANAGE),
      request: request("POST", {bieming: "  ", name: ""}),
    } as any);
    expect(response.status).toBe(400);

    await createAliasEndpoint({
      locals: locals(MANAGE),
      request: request("POST", {bieming: "a1", name: "n1"}),
    } as any);
    const second = await createAliasEndpoint({
      locals: locals(MANAGE),
      request: request("POST", {bieming: "a2", name: "n2"}),
    } as any);
    const id2 = (await rows(second)).find((row) => row.bieming === "a2")?.id;
    response = await updateAliasEndpoint({
      locals: locals(MANAGE),
      request: request("PUT", {id: id2, bieming: "a1", name: "n2"}),
    } as any);
    expect(response.status).toBe(409);
  });

  it("refuses writes to an account without the manage permission", async () => {
    const response = await createAliasEndpoint({
      locals: locals(READ),
      request: request("POST", {bieming: "x", name: "y"}),
    } as any);
    expect(response.status).toBe(403);
  });

  it("writes a hide directive for a derived alias and restores it by id", async () => {
    // Hide a derived alias (no ext row yet) → directive with deleted=1.
    let response = await deleteAliasEndpoint({
      locals: locals(MANAGE),
      request: request("DELETE", {bieming: "某导入别名", hide: true}),
    } as any);
    expect(response.status).toBe(200);
    let directive = await extRow("某导入别名");
    expect(directive?.deleted).toBe(1);
    // A hidden bieming with no derived counterpart is not surfaced as a row.
    expect(
      (await rows(response)).find((row) => row.bieming === "某导入别名"),
    ).toBeUndefined();

    // Restore → directive removed by id.
    response = await deleteAliasEndpoint({
      locals: locals(MANAGE),
      request: request("DELETE", {id: directive!.id}),
    } as any);
    expect(response.status).toBe(200);
    expect(await extRow("某导入别名")).toBeNull();
  });

  it("returns 404 when deleting a non-existent id and 400 on a bare DELETE", async () => {
    let response = await deleteAliasEndpoint({
      locals: locals(MANAGE),
      request: request("DELETE", {id: "does-not-exist"}),
    } as any);
    expect(response.status).toBe(404);

    response = await deleteAliasEndpoint({
      locals: locals(MANAGE),
      request: request("DELETE", {}),
    } as any);
    expect(response.status).toBe(400);
  });
});
