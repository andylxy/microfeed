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
 * 菜单管理端点（票 03/04）。`ext_menu` 由迁移种子（0041..0126 连续重放），
 * 所以行集里必须能看到 0126 播种的 menu_management 行；写路径用自建组
 * （`mm_` 前缀行）测试，种子的行保持原样不被改动。
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

function groupOp(code: string, parentCode: string | null = null): MenuAdminOp {
  return {code, icon: "layers", nameEn: code, nameZh: code, op: "create-group", parentCode};
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
  async function save(ops: MenuAdminOp[]): Promise<{response: Response; rows: ResponseRow[]}> {
    const response = await saveMenuAdminEndpoint({
      locals: locals(MANAGE),
      request: request("POST", {ops}),
    } as never);
    return {response, rows: response.ok ? await rowsFrom(response) : []};
  }

  it("creates a custom group, renames and hides it, then deletes it", async () => {
    let {response, rows} = await save([
      {
        code: "zz_test_group",
        icon: "layers",
        nameEn: "Test",
        nameZh: "测试组",
        op: "create-group",
        parentCode: null,
      },
    ]);
    expect(response.status).toBe(200);
    let created = rows.find((row) => row.code === "zz_test_group");
    expect(created?.id).toBe("mm_zz_test_group");
    expect(created?.deletable).toBe(true);
    expect(created?.path).toBe("");
    expect(created?.permissionCode).toBeNull();

    ({response, rows} = await save([
      {code: "zz_test_group", op: "update", patch: {isVisible: false, nameZh: "改名后"}},
    ]));
    expect(response.status).toBe(200);
    created = rows.find((row) => row.code === "zz_test_group");
    expect(created?.nameZh).toBe("改名后");
    expect(created?.visible).toBe(false);
    // 管理视图必须看得到隐藏行（这正是「含不可见行」与渲染路径的差别）。
    const listRows = await rowsFrom(
      await listMenuAdminEndpoint({locals: locals(MANAGE), request: request("GET")} as never),
    );
    expect(listRows.find((row) => row.code === "zz_test_group")?.visible).toBe(false);

    ({response} = await save([{code: "zz_test_group", op: "delete"}]));
    expect(response.status).toBe(200);
  });

  it("protects seeded rows and enforces the edit boundaries", async () => {
    // 种子行不可删（拍板：删除仅限管理页自建行）。
    let {response} = await save([{code: "books", op: "delete"}]);
    expect(response.status).toBe(409);

    // 不存在的 code → 404。
    ({response} = await save([
      {code: "zz_does_not_exist", op: "update", patch: {nameZh: "x"}},
    ]));
    expect(response.status).toBe(404);

    // 图标不在白名单 → 400。
    ({response} = await save([
      {code: "books", op: "update", patch: {icon: "definitely-not-an-icon"}},
    ]));
    expect(response.status).toBe(400);

    // 页面行清空图标 → 400（NULL 图标只属于分组行）。
    ({response} = await save([
      {code: "books", op: "update", patch: {icon: null}},
    ]));
    expect(response.status).toBe(400);

    // path / permission_code 不在可改字段里：只带它们的 patch 等于空补丁 → 400。
    ({response} = await save([
      {code: "books", op: "update", patch: {path: "evil"} as never},
    ]));
    expect(response.status).toBe(400);
  });

  it("moves rows within their sibling run and refuses moves at the edge", async () => {
    const group = (code: string): MenuAdminOp => ({
      code,
      icon: "layers",
      nameEn: code,
      nameZh: code,
      op: "create-group",
      parentCode: null,
    });
    const {rows} = await save([group("zz_move_a"), group("zz_move_b")]);
    const sortA = rows.find((row) => row.code === "zz_move_a")?.sort ?? 0;
    const sortB = rows.find((row) => row.code === "zz_move_b")?.sort ?? 0;
    expect(sortB).toBeGreaterThan(sortA);

    const moved = await save([{code: "zz_move_a", direction: "down", op: "move"}]);
    expect(moved.response.status).toBe(200);
    expect(moved.rows.find((row) => row.code === "zz_move_a")?.sort).toBe(sortB);
    expect(moved.rows.find((row) => row.code === "zz_move_b")?.sort).toBe(sortA);

    // 交换后 zz_move_a 拿到较大的 sortB，成为同层末位，再往下移没有相邻兄弟 → 400。
    const edge = await save([{code: "zz_move_a", direction: "down", op: "move"}]);
    expect(edge.response.status).toBe(400);
  });

  it("rejects the whole batch when one op fails, leaving the table untouched", async () => {
    const {response} = await save([
      {
        code: "zz_batch_ok",
        icon: "layers",
        nameEn: "ok",
        nameZh: "ok",
        op: "create-group",
        parentCode: null,
      },
      {code: "books", op: "delete"},
    ]);
    expect(response.status).toBe(409);
    const created = await env.FEED_DB
      .prepare("SELECT id FROM ext_menu WHERE code = ?")
      .bind("zz_batch_ok")
      .first();
    expect(created).toBeNull();
    const seed = await env.FEED_DB
      .prepare("SELECT id FROM ext_menu WHERE code = ?")
      .bind("books")
      .first();
    expect(seed).not.toBeNull();
  });

  it("rewrites the sibling run in the order of ids", async () => {
    await save([groupOp("zz_ro_a"), groupOp("zz_ro_b"), groupOp("zz_ro_c")]);
    const before = await rowsFrom(
      await listMenuAdminEndpoint({locals: locals(MANAGE), request: request("GET")} as never),
    );
    expect(before.filter((row) => row.code.startsWith("zz_ro_")).length).toBe(3);

    const {response, rows} = await save([
      {code: "zz_ro_c", ids: ["zz_ro_c", "zz_ro_a", "zz_ro_b"], op: "reorder"},
    ]);
    expect(response.status).toBe(200);
    expect(rows.find((row) => row.code === "zz_ro_c")?.sort).toBe(1);
    expect(rows.find((row) => row.code === "zz_ro_a")?.sort).toBe(2);
    expect(rows.find((row) => row.code === "zz_ro_b")?.sort).toBe(3);
  });

  it("reparents the dragged row into the target group", async () => {
    await save([
      groupOp("zz_rp_old"),
      groupOp("zz_rp_new"),
      groupOp("zz_rp_seed", "zz_rp_new"),
      groupOp("zz_rp_kid", "zz_rp_old"),
    ]);
    const {response, rows} = await save([
      {code: "zz_rp_kid", ids: ["zz_rp_seed", "zz_rp_kid"], op: "reorder", parentCode: "zz_rp_new"},
    ]);
    expect(response.status).toBe(200);
    const kid = rows.find((row) => row.code === "zz_rp_kid");
    expect(kid?.parentCode).toBe("zz_rp_new");
    expect(kid?.sort).toBe(2);
    expect(rows.filter((row) => row.parentCode === "zz_rp_old").length).toBe(0);
    expect(rows.filter((row) => row.parentCode === "zz_rp_new").length).toBe(2);
  });

  it("refuses to reparent a group under its own child, keeping the rows intact", async () => {
    await save([groupOp("zz_cy_root"), groupOp("zz_cy_kid", "zz_cy_root")]);
    const {response} = await save([
      {code: "zz_cy_root", ids: ["zz_cy_kid"], op: "reorder", parentCode: "zz_cy_kid"},
    ]);
    expect(response.status).toBe(400);

    const rows = await rowsFrom(
      await listMenuAdminEndpoint({locals: locals(MANAGE), request: request("GET")} as never),
    );
    expect(rows.find((row) => row.code === "zz_cy_root")?.parentCode).toBeNull();
    expect(rows.find((row) => row.code === "zz_cy_kid")?.parentCode).toBe("zz_cy_root");
  });

  it("rejects an unknown code and an ids list without the dragged row", async () => {
    const {response} = await save([
      {code: "zz_missing", ids: ["zz_missing"], op: "reorder"},
    ]);
    expect(response.status).toBe(404);

    await save([groupOp("zz_bad_ids")]);
    const bad = await save([
      {code: "zz_bad_ids", ids: ["zz_someone_else"], op: "reorder"},
    ]);
    expect(bad.response.status).toBe(400);
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
