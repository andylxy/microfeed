/**
 * 菜单管理页端点（票 03 起全部只读：list / export 保留，save 的写入通道关闭）。
 *
 * 三个端点全部绑定 `system:menu:manage`——与 `menu_management` 菜单行同一个码，
 * admin-page-guards 的硬规则同样覆盖这组端点与页面的配对。
 *
 * 取数代价：`ext_menu` 全表读。本地库实测 33 行（0041 种子 16 行 + 0050 分组 5 行
 * + 0061/0062/0083/0084/0087/0123/0126 逐次追加），一次 `SELECT` 读全表约 2.5 KB
 * （33 行文本合计 2573 字节），且该表由迁移种子封顶增长（运营自建行数按站点计，
 * 个位数），不构成全表扫描风险。
 * 管理页需要「含不可见行、含无权限过滤」的完整结构，可见行过滤在
 * `src/server/admin/menu.ts` 的渲染路径做，两者语义不同、不共用查询。
 */

import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, localizedError} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {
  buildMenuExportSql,
  MENU_ROW_CUSTOM_ID_PREFIX,
  type MenuAdminRowWithMeta,
} from "@/shared/MenuAdminOps";
import {PERMISSION_CODES} from "@/shared/Constants";

const ALL_ROWS_SQL =
  "SELECT id, code, parent_code, path, i18n_key, icon, name_zh, name_en, " +
  "permission_code, sort, is_visible, created_at_ms " +
  "FROM ext_menu ORDER BY sort, code";

interface MenuRowRecord {
  code: string;
  created_at_ms: number;
  i18n_key: string;
  icon: string | null;
  id: string;
  name_en: string | null;
  name_zh: string | null;
  parent_code: string | null;
  path: string;
  permission_code: string | null;
  sort: number;
  is_visible: number;
}

export async function listMenuAdminRows(db: D1Database): Promise<MenuAdminRowWithMeta[]> {
  const result = await db.prepare(ALL_ROWS_SQL).all<MenuRowRecord>();
  return (result.results ?? []).map((row) => ({
    code: row.code,
    createdAtMs: row.created_at_ms,
    deletable: row.id.startsWith(MENU_ROW_CUSTOM_ID_PREFIX),
    i18nKey: row.i18n_key,
    icon: row.icon,
    id: row.id,
    nameEn: row.name_en,
    nameZh: row.name_zh,
    parentCode: row.parent_code,
    path: row.path,
    permissionCode: row.permission_code,
    sort: row.sort,
    visible: row.is_visible === 1,
  }));
}

const NO_STORE = {"cache-control": "private, no-store"};

/** `GET /ajax/menu` — 管理页全量行（含不可见行），供编辑表格渲染。 */
export const listMenuAdminEndpoint: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.SYSTEM_MENU_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  return jsonResponse(
    {rows: await listMenuAdminRows(env.FEED_DB)},
    {headers: NO_STORE},
  );
};

/**
 * `POST /ajax/menu/save` — 只读一版（ADR-0042 D6）：写入通道已关闭。
 *
 * 侧栏改读权限节点后，写进 `ext_menu` 不再影响任何渲染结果，请求却仍回报成功：
 * 照旧提交、界面毫无变化，这类无声失败比明确报错更难定位。路由与鉴权保留
 * （整条端点的退役属票 04），写入一律拒绝。
 */
export const saveMenuAdminEndpoint: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.SYSTEM_MENU_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  return localizedError(request, "errors.menu.readOnly", 409);
};

/**
 * `GET /ajax/menu/export` — 当前菜单状态的 data 迁移文本（迁移单向性的补齐通道）。
 * 只读：不写库，把「运行时改动回写成迁移」这一步交还给用户提交。
 */
export const exportMenuAdminEndpoint: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.SYSTEM_MENU_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  const rows = await listMenuAdminRows(env.FEED_DB);
  return jsonResponse(
    {sql: buildMenuExportSql(rows, Date.now())},
    {headers: NO_STORE},
  );
};
