import {env} from "cloudflare:workers";
import {afterEach, describe, expect, it} from "vitest";

import {
  exportMenuAdminEndpoint,
  listMenuAdminEndpoint,
  saveMenuAdminEndpoint,
} from "@/server/admin/menu-admin-handlers";
import type {RbacLocals} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";
import {MENU_ROW_CUSTOM_ID_PREFIX} from "@/shared/MenuAdminOps";
import type {MenuAdminOp, MenuAdminRow} from "@/shared/MenuAdminOps";

/**
 * 菜单管理端点（票 03 起只读）。`ext_menu` 由迁移种子（0041..0126 连续重放），
 * 所以行集里必须能看到 0126 播种的 menu_management 行；写路径的逐条校验在
 * `tests/unit/menu-admin-ops.test.ts` 里覆盖，端点层只断言「写入一律拒绝」。
 */

interface ResponseRow extends MenuAdminRow {
  deletable: boolean;
}

function locals(permissions: Set<string>): RbacLocals {
  return {authUser: {id: "u_test"}, rbacPermissions: permissions};
}

function request(method: string, body?: unknown): Request {
  return new Request(`https://example.test/ajax/menu${method === "POST" ? "/save" : ""}`, {
    ...(body === undefined
      ? {}
      : {body: JSON.stringify(body), headers: {"content-type": "application/json"}}),
    method,
  });
}

const MANAGE = new Set<string>([PERMISSION_CODES.SYSTEM_MENU_MANAGE]);

async function rowsFrom(response: Response): Promise<ResponseRow[]> {
  const data = (await response.json()) as {rows: ResponseRow[]};
  return data.rows;
}

afterEach(async () => {
  await env.FEED_DB
    .prepare(`DELETE FROM ext_menu WHERE id LIKE '${MENU_ROW_CUSTOM_ID_PREFIX}%'`)
    .run();
});

describe("GET /ajax/menu", () => {
  it("lists every seeded row including the menu admin page itself", async () => {
    const response = await listMenuAdminEndpoint({
      locals: locals(MANAGE),
      request: request("GET"),
    } as never);
    expect(response.status).toBe(200);
    const rows = await rowsFrom(response);
    const codes = new Set(rows.map((row) => row.code));
    expect(codes.has("menu_management")).toBe(true);
    expect(codes.has("books")).toBe(true);
    const seeded = rows.find((row) => row.code === "books");
    expect(seeded?.deletable).toBe(false);
  });

  it("refuses an account without system:menu:manage", async () => {
    const response = await listMenuAdminEndpoint({
      locals: locals(new Set()),
      request: request("GET"),
    } as never);
    expect(response.status).toBe(403);
  });
});

describe("POST /ajax/menu/save", () => {
  async function save(ops: MenuAdminOp[]): Promise<Response> {
    return saveMenuAdminEndpoint({
      locals: locals(MANAGE),
      request: request("POST", {ops}),
    } as never);
  }

  it("refuses every write with the read-only notice", async () => {
    const response = await save([
      {
        code: "zz_test_group",
        icon: "layers",
        nameEn: "Test",
        nameZh: "测试组",
        op: "create-group",
        parentCode: null,
      },
    ]);
    expect(response.status).toBe(409);
    const body = (await response.json()) as {error?: string; rows?: unknown};
    expect(typeof body.error).toBe("string");
    expect(body.error?.length ?? 0).toBeGreaterThan(0);
    // 拒绝响应不带行集回发：写入没有发生，界面不该拿到一份「已保存」的数据。
    expect(body.rows).toBeUndefined();
    const created = await env.FEED_DB
      .prepare("SELECT id FROM ext_menu WHERE code = ?")
      .bind("zz_test_group")
      .first();
    expect(created).toBeNull();
  });

  it("refuses an account without system:menu:manage", async () => {
    const response = await saveMenuAdminEndpoint({
      locals: locals(new Set()),
      request: request("POST", {ops: [{code: "books", op: "update", patch: {nameZh: "x"}}]}),
    } as never);
    expect(response.status).toBe(403);
  });
});

describe("GET /ajax/menu/export", () => {
  it("returns mutable-field SQL with the migration header", async () => {
    const response = await exportMenuAdminEndpoint({
      locals: locals(MANAGE),
      request: request("GET"),
    } as never);
    expect(response.status).toBe(200);
    const data = (await response.json()) as {sql: string};
    // 种子行只写可变字段：UPDATE，不整行覆盖。
    expect(data.sql).toContain("UPDATE ext_menu SET");
    expect(data.sql).toContain("-- rollback:");
    expect(data.sql).toContain("'m_menu_management'");
    // path 与 permission_code 是可达性前提，导出里不能出现。
    expect(data.sql).not.toMatch(/path\s*=/u);
    expect(data.sql).not.toMatch(/permission_code\s*=/u);
  });
});
