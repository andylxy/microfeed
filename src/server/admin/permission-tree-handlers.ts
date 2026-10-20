/**
 * 权限树管理页端点（票据 04）。
 *
 * 守卫按终端分派（ADR-0039 D3）：PC 端要 `system:role:manage`，App 端要
 * `system:app-capability:manage`。端由调用方给出——读走 `?audience=`，存走
 * 请求体里的 `audience`；两端各有一份自己的树，互不可见。
 *
 * 取数代价：`ext_permission_nodes` 按 `(audience, kind)` 索引读单端行集。
 * 本地库实测 87 行（迁移 0127 固化的 7 分组 + 29 页 + 51 码），单端约 78 行 /
 * 12 行，一次 `SELECT` < 20 KB；该表由迁移种子封顶增长，管理页自建行按站点计
 * 个位数，不构成全表扫描风险。
 * 管理页需要「含不可见行」的完整结构，可见性过滤在客户端做，与授权视图
 * （`readRbacBoard`）的组装口径不同，两者不共用查询。
 *
 * 写入纪律：全部语句经 `planPermissionOps`（`src/shared/PermissionTreeOps.ts`）
 * 生成、一律绑定参数，整批经 `db.batch` 原子提交；任何一条校验失败整批拒绝，
 * 零写库。迁移的单向性由导出端点补齐：运行时改动导成 data 迁移交用户提交。
 */

import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, localizedError} from "@/server/http";
import {requireAudienceGuard, requireAuthenticatedRbac} from "@/server/rbac/guard";
import {isPermissionAudience, type PermissionAudience} from "@/shared/Rbac";
import {
  buildPermissionExportSql,
  PERMISSION_NODE_COLUMNS,
  planPermissionOps,
  toPermissionNodeRow,
  type PermissionNodeRowWithMeta,
  type PermissionNodeTableRow,
  type PermissionTreeOp,
} from "@/shared/PermissionTreeOps";

const AUDIENCE_ROWS_SQL =
  `SELECT ${PERMISSION_NODE_COLUMNS} FROM ext_permission_nodes
   WHERE audience = ? ORDER BY sort, code`;

/**
 * 解析调用方声明的终端。
 *
 * 缺席与非法值都返回 `null`，由端点回 400：权限树按端分区之后，一次没有声明
 * 终端的读写没有确定的含义，猜一边就等于替调用方选了一个控制台（ADR-0039
 * 「漏传会被 400 拒绝」）。
 */
function parseAudience(value: unknown): PermissionAudience | null {
  return isPermissionAudience(value) ? value : null;
}

export async function listPermissionTree(
  db: D1Database,
  audience: PermissionAudience,
): Promise<PermissionNodeRowWithMeta[]> {
  const result = await db.prepare(AUDIENCE_ROWS_SQL).bind(audience)
    .all<PermissionNodeTableRow>();
  return (result.results ?? []).map((row): PermissionNodeRowWithMeta => {
    const node = toPermissionNodeRow(row);
    return {
      ...node,
      // 可删：仅管理页自建的分组行。迁移种子行删了会被下次重播迁移的实例重新
      // 种回来，两台机器的树从此对不上；权限码行本身不可删。
      deletable: node.source !== "seed" && node.kind !== "code",
      // 可全字段编辑：`code` 节点窄编辑（只能换父级与显隐），名字与图标不开放。
      editable: node.kind !== "code",
    };
  });
}

const NO_STORE = {"cache-control": "private, no-store"};

/** 保存请求体的字节上限：op 条数另有 100 条硬顶，这里防的是误发的巨大 payload。 */
const MAX_SAVE_BODY_BYTES = 64 * 1024;

/** `GET /ajax/rbac/permission-tree?audience=` — 单端全量行（含不可见行），供树形渲染。 */
export const listPermissionTreeEndpoint: APIRoute = async ({locals, request}) => {
  const audience = parseAudience(new URL(request.url).searchParams.get("audience"));
  if (!audience) {
    return localizedError(request, "errors.permission.invalidInput", 400);
  }
  const guard = await requireAudienceGuard(locals, audience, request, env.FEED_DB);
  if (guard) return guard;
  return jsonResponse(
    {rows: await listPermissionTree(env.FEED_DB, audience)},
    {headers: NO_STORE},
  );
};

/**
 * `POST /ajax/rbac/permission-tree/save {audience, ops: PermissionTreeOp[]}` —
 * 批量保存一次编辑的操作。校验在共享层完成，通过后整批 `db.batch` 原子写入并
 * 回发该端最新全量行；失败时前端回滚到上一次成功快照。
 *
 * plan 只在本端行集上推演：跨端的父级根本不在行集里，配合共享层的同端不变量，
 * 一条 op 也没有机会把行挂到另一端去。
 */
export const savePermissionTreeEndpoint: APIRoute = async ({locals, request}) => {
  // 防重放 + 账号门先跑：守卫码要等请求体里的 audience，但未登录、被封、
  // 待改密的调用方没有理由触发请求体解析。
  const gate = await requireAuthenticatedRbac(locals, request, env.FEED_DB);
  if (gate) return gate;
  // 请求体上限：先看声明长度（缺失时后面的文本长度兜底）。
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_SAVE_BODY_BYTES) {
    return localizedError(request, "errors.permission.invalidInput", 400);
  }
  const bodyText = await request.text().catch(() => "");
  if (bodyText.length > MAX_SAVE_BODY_BYTES) {
    return localizedError(request, "errors.permission.invalidInput", 400);
  }
  let parsed: {audience?: unknown; ops?: unknown} | null = null;
  try {
    parsed = JSON.parse(bodyText) as {audience?: unknown; ops?: unknown} | null;
  } catch {
    parsed = null;
  }
  const audience = parseAudience(parsed?.audience);
  if (!audience) {
    return localizedError(request, "errors.permission.invalidInput", 400);
  }
  const guard = await requireAudienceGuard(locals, audience, request, env.FEED_DB, {
    skipReplay: true,
  });
  if (guard) return guard;

  const ops = Array.isArray(parsed?.ops) ? (parsed.ops as PermissionTreeOp[]) : null;
  if (!ops) {
    return localizedError(request, "errors.permission.invalidInput", 400);
  }

  const rows = await listPermissionTree(env.FEED_DB, audience);
  const plan = planPermissionOps(rows, ops, Date.now(), audience);
  if (plan.error) {
    return localizedError(request, plan.error.key, plan.error.status, plan.error.params);
  }
  await env.FEED_DB.batch(
    plan.statements.map((statement) =>
      env.FEED_DB.prepare(statement.sql).bind(...statement.params),
    ),
  );
  return jsonResponse(
    {rows: await listPermissionTree(env.FEED_DB, audience)},
    {headers: NO_STORE},
  );
};

/**
 * `GET /ajax/rbac/permission-tree/export?audience=` — 该端权限树当前状态的
 * data 迁移文本。只读：不写库，把「运行时改动回写成迁移」这一步交还给用户提交。
 */
export const exportPermissionTreeEndpoint: APIRoute = async ({locals, request}) => {
  const audience = parseAudience(new URL(request.url).searchParams.get("audience"));
  if (!audience) {
    return localizedError(request, "errors.permission.invalidInput", 400);
  }
  const guard = await requireAudienceGuard(locals, audience, request, env.FEED_DB);
  if (guard) return guard;
  const rows = await listPermissionTree(env.FEED_DB, audience);
  return jsonResponse(
    {sql: buildPermissionExportSql(rows, Date.now())},
    {headers: NO_STORE},
  );
};
