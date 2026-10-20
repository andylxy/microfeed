import {env} from "cloudflare:workers";
import {afterEach, describe, expect, it} from "vitest";

import {
  exportPermissionTreeEndpoint,
  listPermissionTreeEndpoint,
  savePermissionTreeEndpoint,
} from "@/server/admin/permission-tree-handlers";
import type {RbacLocals} from "@/server/rbac/guard";
import {PERMISSION_CODES} from "@/shared/Constants";
import {PERMISSION_ROW_SEED_ID_PREFIX} from "@/shared/PermissionTreeOps";
import type {PermissionNodeRow, PermissionTreeOp} from "@/shared/PermissionTreeOps";

/**
 * 权限树管理端点（票据 04）。`ext_permission_nodes` 由迁移 0127 的种子行构成
 * （7 分组 + 29 页 + 51 码），0129 把 6 个 App 码收拢到 `group_app` 下并删掉两个
 * 移空的兜底行，0130 补上 `system:app-capability:manage` 的叶子——两端合计 90 行，
 * PC 端 78 行、App 端 12 行。写路径只用自建分组（`pm_` 前缀行）与自恢复的 code
 * 行改父来验证；种子结构在用例内还原，等价回归测试不受影响。
 */

interface ResponseRow extends PermissionNodeRow {
  deletable: boolean;
  editable: boolean;
}

function locals(permissions: Set<string>): RbacLocals {
  return {authUser: {id: "u_test"}, rbacPermissions: permissions};
}

function request(
  method: string,
  options: {audience?: string; body?: unknown; path?: string} = {},
): Request {
  const path = options.path ?? "/ajax/rbac/permission-tree";
  const query = options.audience === undefined ? "" : `?audience=${options.audience}`;
  return new Request(`https://example.test${path}${query}`, {
    ...(options.body === undefined
      ? {}
      : {body: JSON.stringify(options.body), headers: {"content-type": "application/json"}}),
    method,
  });
}

const MANAGE = new Set<string>([PERMISSION_CODES.SYSTEM_ROLE_MANAGE]);
const APP_MANAGE = new Set<string>([PERMISSION_CODES.SYSTEM_APP_CAPABILITY_MANAGE]);

async function rowsFrom(response: Response): Promise<ResponseRow[]> {
  const data = (await response.json()) as {rows: ResponseRow[]};
  return data.rows;
}

function groupOp(code: string, parentCode: string | null = null): PermissionTreeOp {
  return {code, icon: "layers", nameEn: code, nameZh: code, op: "create-group", parentCode};
}

afterEach(async () => {
  // 只清自建行：迁移种子的行必须原样留在表里（等价回归测试的前提）。
  await env.FEED_DB
    .prepare(`DELETE FROM ext_permission_nodes WHERE id LIKE 'pm_%'`)
    .run();
  // code 行改父用例若中途失败，这里把种子映射还原回 0127 的初始父级。
  await env.FEED_DB
    .prepare(
      "UPDATE ext_permission_nodes SET parent_code = 'page_volumes' WHERE code = ?",
    )
    .bind("content:volume:read")
    .run();
});

describe("GET /ajax/rbac/permission-tree", () => {
  it("lists the PC console's rows with the derived permission bits", async () => {
    const response = await listPermissionTreeEndpoint({
      locals: locals(MANAGE),
      request: request("GET", {audience: "desktop"}),
    } as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");

    const rows = await rowsFrom(response);
    const codes = new Set(rows.map((row) => row.code));
    expect(codes.has("group_content")).toBe(true);
    expect(codes.has("page_books")).toBe(true);
    expect(codes.has("content:book:read")).toBe(true);
    // 两端合计 93 行，减去 App 端的 15 行（1 分组 + 3 页 + 11 码）。
    expect(rows).toHaveLength(78);
    // App 端的行不在 PC 端的树里。
    expect(codes.has("group_app")).toBe(false);
    expect(codes.has("app:nav:read")).toBe(false);
    // 0129 删掉的两处兜底行。
    expect(codes.has("page_unmapped")).toBe(false);
    expect(codes.has("group_other")).toBe(false);

    const group = rows.find((row) => row.code === "group_content");
    expect(group?.kind).toBe("group");
    expect(group?.deletable).toBe(false); // 种子行锁定
    expect(group?.editable).toBe(true);

    const code = rows.find((row) => row.code === "content:book:read");
    expect(code?.kind).toBe("code");
    expect(code?.permissionCode).toBe("content:book:read");
    expect(code?.deletable).toBe(false);
    expect(code?.editable).toBe(false); // 窄编辑：只能换父级与显隐
    expect(code?.nameZh).toBeNull(); // 名字渲染时取 ext_permissions.name
  });

  it("lists the App console's own tree and nothing else", async () => {
    const rows = await rowsFrom(
      await listPermissionTreeEndpoint({
        locals: locals(APP_MANAGE),
        request: request("GET", {audience: "app"}),
      } as never),
    );
    expect(rows.map((row) => row.code).sort()).toEqual([
      "app:announcement:read",
      "app:chapter:read",
      "app:content:read",
      "app:fang:read",
      "app:mingci:view",
      "app:nav:read",
      "app:search:book",
      "app:search:global",
      "app:style:read",
      "app:version:read",
      "app:zhongyao:read",
      "group_app",
      "page_app_access",
      "page_app_announcement_read",
      "page_app_search",
    ]);
    // 每个 App 码都挂在 App 根下的页上（D5 归拢 + 0131 并页的结果）。
    const appPages = new Set([
      "page_app_access",
      "page_app_announcement_read",
      "page_app_search",
    ]);
    const appCodes = rows.filter((row) => row.kind === "code");
    expect(appCodes).not.toHaveLength(0);
    for (const row of appCodes) {
      expect(appPages.has(row.parentCode ?? "")).toBe(true);
      expect(row.audience).toBe("app");
    }
  });

  it("refuses anonymous callers and accounts without the console's grant", async () => {
    const anonymous = await listPermissionTreeEndpoint({
      locals: {},
      request: request("GET", {audience: "desktop"}),
    } as never);
    expect(anonymous.status).toBe(401);

    const forbidden = await listPermissionTreeEndpoint({
      locals: locals(new Set([PERMISSION_CODES.SYSTEM_MENU_MANAGE])),
      request: request("GET", {audience: "desktop"}),
    } as never);
    expect(forbidden.status).toBe(403);
  });

  it("picks the guard from the console the caller asks for", async () => {
    // 只持 App 码：App 端的树可读，PC 端的树被拒。
    const appSide = await listPermissionTreeEndpoint({
      locals: locals(APP_MANAGE),
      request: request("GET", {audience: "app"}),
    } as never);
    expect(appSide.status).toBe(200);

    const pcSideAsAppHolder = await listPermissionTreeEndpoint({
      locals: locals(APP_MANAGE),
      request: request("GET", {audience: "desktop"}),
    } as never);
    expect(pcSideAsAppHolder.status).toBe(403);

    // 只持 PC 码：反方向同样对称。
    const appSideAsPcHolder = await listPermissionTreeEndpoint({
      locals: locals(MANAGE),
      request: request("GET", {audience: "app"}),
    } as never);
    expect(appSideAsPcHolder.status).toBe(403);

    // 缺席与乱给都是 400：按端分区后，一次不声明终端的读写没有确定含义。
    const missing = await listPermissionTreeEndpoint({
      locals: locals(MANAGE),
      request: request("GET"),
    } as never);
    expect(missing.status).toBe(400);
    const bogus = await listPermissionTreeEndpoint({
      locals: locals(MANAGE),
      request: request("GET", {audience: "mobile"}),
    } as never);
    expect(bogus.status).toBe(400);
  });
});

describe("POST /ajax/rbac/permission-tree/save", () => {
  async function save(
    ops: PermissionTreeOp[],
    audience = "desktop",
    permissions = MANAGE,
  ): Promise<{response: Response; rows: ResponseRow[]}> {
    const response = await savePermissionTreeEndpoint({
      locals: locals(permissions),
      request: request("POST", {body: {audience, ops}, path: "/ajax/rbac/permission-tree/save"}),
    } as never);
    return {response, rows: response.ok ? await rowsFrom(response) : []};
  }

  it("creates a custom group, renames and hides it, then deletes it", async () => {
    let {response, rows} = await save([groupOp("zz_pt_group")]);
    expect(response.status).toBe(200);
    const created = rows.find((row) => row.code === "zz_pt_group");
    expect(created?.id).toBe("pm_zz_pt_group");
    expect(created?.deletable).toBe(true);
    expect(created?.source).toBe("custom");

    ({response, rows} = await save([
      {code: "zz_pt_group", op: "update", patch: {isVisible: false, nameZh: "改名后"}},
    ]));
    expect(response.status).toBe(200);
    const renamed = rows.find((row) => row.code === "zz_pt_group");
    expect(renamed?.nameZh).toBe("改名后");
    expect(renamed?.visible).toBe(false);
    // 管理视图含不可见行（与授权视图的组装口径不同）。
    const listRows = await rowsFrom(
      await listPermissionTreeEndpoint({
        locals: locals(MANAGE),
        request: request("GET", {audience: "desktop"}),
      } as never),
    );
    expect(listRows.find((row) => row.code === "zz_pt_group")?.visible).toBe(false);

    ({response} = await save([{code: "zz_pt_group", op: "delete"}]));
    expect(response.status).toBe(200);
  });

  it("creates the new group on the console the request names", async () => {
    const {response, rows} = await save([groupOp("zz_pt_app_group")], "app", APP_MANAGE);
    expect(response.status).toBe(200);
    const created = rows.find((row) => row.code === "zz_pt_app_group");
    expect(created?.audience).toBe("app");

    // 写库后的归属：App 端树里看得见，PC 端树里看不见。
    const desktopRows = await rowsFrom(
      await listPermissionTreeEndpoint({
        locals: locals(MANAGE),
        request: request("GET", {audience: "desktop"}),
      } as never),
    );
    expect(desktopRows.some((row) => row.code === "zz_pt_app_group")).toBe(false);
  });

  it("refuses to hang a row under the other console's node", async () => {
    // 跨端重挂：App 端业主在 PC 端的分组下建不了子分组——父级根本不在本端行集里。
    const {response} = await save(
      [groupOp("zz_pt_cross", "group_content")],
      "app",
      APP_MANAGE,
    );
    expect(response.status).toBe(404);
  });

  it("protects seeded rows and enforces the edit boundaries", async () => {
    // 种子行不可删。
    let {response} = await save([{code: "group_content", op: "delete"}]);
    expect(response.status).toBe(409);

    // 不存在的 code → 404。
    ({response} = await save([
      {code: "zz_does_not_exist", op: "update", patch: {nameZh: "x"}},
    ]));
    expect(response.status).toBe(404);

    // code 行拒改名（名字取 ext_permissions.name）。
    ({response} = await save([
      {code: "content:book:read", op: "update", patch: {nameZh: "x"}},
    ]));
    expect(response.status).toBe(400);

    // code 行不可删。
    ({response} = await save([{code: "content:book:read", op: "delete"}]));
    expect(response.status).toBe(400);

    // 空补丁 → 400。
    ({response} = await save([
      {code: "group_content", op: "update", patch: {}},
    ]));
    expect(response.status).toBe(400);
  });

  it("reparents a code row across pages and restores it afterwards", async () => {
    // 跨页改父 = 移动权限对象的位置（ADR-0038 的核心动作）。
    const {response, rows} = await save([
      {
        code: "content:volume:read",
        op: "update",
        patch: {parentCode: "page_books"},
      },
    ]);
    expect(response.status).toBe(200);
    const moved = rows.find((row) => row.code === "content:volume:read");
    expect(moved?.parentCode).toBe("page_books");

    // 自恢复：还回 0127 种子的初始父级，等价回归测试看到的结构不变。
    const back = await save([
      {
        code: "content:volume:read",
        op: "update",
        patch: {parentCode: "page_volumes"},
      },
    ]);
    expect(back.response.status).toBe(200);
    expect(back.rows.find((row) => row.code === "content:volume:read")?.parentCode)
      .toBe("page_volumes");
  });

  it("refuses to hang a code row under a group (only pages hold codes)", async () => {
    const {response} = await save([
      {code: "content:book:read", op: "update", patch: {parentCode: "group_content"}},
    ]);
    expect(response.status).toBe(400);
  });

  it("rejects the whole batch when one op fails, leaving the table untouched", async () => {
    const {response} = await save([
      groupOp("zz_pt_batch"),
      {code: "group_content", op: "delete"},
    ]);
    expect(response.status).toBe(409);
    const created = await env.FEED_DB
      .prepare("SELECT id FROM ext_permission_nodes WHERE code = ?")
      .bind("zz_pt_batch")
      .first();
    expect(created).toBeNull();
    // 种子行没有被整批拒绝波及。
    const seed = await env.FEED_DB
      .prepare("SELECT id FROM ext_permission_nodes WHERE code = ?")
      .bind("group_content")
      .first();
    expect(seed?.id).toBe(`${PERMISSION_ROW_SEED_ID_PREFIX}group_content`);
  });

  it("reorders the sibling run and reparents the dragged group", async () => {
    await save([groupOp("zz_pt_a"), groupOp("zz_pt_b"), groupOp("zz_pt_c")]);
    const {response, rows} = await save([
      {code: "zz_pt_c", ids: ["zz_pt_c", "zz_pt_a", "zz_pt_b"], op: "reorder"},
    ]);
    expect(response.status).toBe(200);
    expect(rows.find((row) => row.code === "zz_pt_c")?.sort).toBe(1);
    expect(rows.find((row) => row.code === "zz_pt_a")?.sort).toBe(2);
    expect(rows.find((row) => row.code === "zz_pt_b")?.sort).toBe(3);

    // 拖进另一个分组：换父 + 在目标层里排位。`ids` 只能是目标层的兄弟
    // （`zz_pt_a` 原本没有子行，所以只有被拖的 `zz_pt_b` 自己）。
    const nested = await save([
      {
        code: "zz_pt_b",
        ids: ["zz_pt_b"],
        op: "reorder",
        parentCode: "zz_pt_a",
      },
    ]);
    expect(nested.response.status).toBe(200);
    const moved = nested.rows.find((row) => row.code === "zz_pt_b");
    expect(moved?.parentCode).toBe("zz_pt_a");
    expect(moved?.sort).toBe(1);
  });

  it("refuses a malformed body, an oversized payload, and too many ops", async () => {
    const malformed = await savePermissionTreeEndpoint({
      locals: locals(MANAGE),
      request: new Request("https://example.test/ajax/rbac/permission-tree/save", {
        body: "not json",
        headers: {"content-type": "application/json"},
        method: "POST",
      }),
    } as never);
    expect(malformed.status).toBe(400);

    // 超过 64 KB 的请求体：op 条数另有 100 条硬顶，字节上限防误发的巨大 payload。
    const oversized = await savePermissionTreeEndpoint({
      locals: locals(MANAGE),
      request: new Request("https://example.test/ajax/rbac/permission-tree/save", {
        body: JSON.stringify({audience: "desktop", ops: [], pad: "x".repeat(70 * 1024)}),
        headers: {"content-type": "application/json"},
        method: "POST",
      }),
    } as never);
    expect(oversized.status).toBe(400);

    const tooMany = await save(
      Array.from({length: 101}, () => groupOp("zz_pt_flood")),
    );
    expect(tooMany.response.status).toBe(400);
  });
});

describe("GET /ajax/rbac/permission-tree/export", () => {
  it("returns the replayable data-migration SQL with the rollback header", async () => {
    const response = await exportPermissionTreeEndpoint({
      locals: locals(MANAGE),
      request: request("GET", {audience: "desktop", path: "/ajax/rbac/permission-tree/export"}),
    } as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");

    const data = (await response.json()) as {sql: string};
    // 种子行只写可变字段：UPDATE，绝不触碰 permission_code。
    expect(data.sql).toContain("UPDATE ext_permission_nodes SET");
    expect(data.sql).not.toContain("permission_code = '");
    expect(data.sql).toContain("-- rollback:");
    expect(data.sql).toContain("NNNN_data_permission_nodes_snapshot.sql");
    expect(data.sql).toContain("'pn_group_content'");
  });

  it("exports only the console that asked for it", async () => {
    const desktop = await exportPermissionTreeEndpoint({
      locals: locals(MANAGE),
      request: request("GET", {audience: "desktop", path: "/ajax/rbac/permission-tree/export"}),
    } as never);
    const app = await exportPermissionTreeEndpoint({
      locals: locals(APP_MANAGE),
      request: request("GET", {audience: "app", path: "/ajax/rbac/permission-tree/export"}),
    } as never);
    expect(desktop.status).toBe(200);
    expect(app.status).toBe(200);

    const pcSql = ((await desktop.json()) as {sql: string}).sql;
    const appSql = ((await app.json()) as {sql: string}).sql;
    expect(pcSql).toContain("'pn_group_content'");
    expect(pcSql).not.toContain("'pn_group_app'");
    expect(appSql).toContain("'pn_group_app'");
    expect(appSql).not.toContain("'pn_group_content'");
  });
});
