/**
 * App 接口清单（ADR-0039 D6）：权限管理页「App 端管理」分类下、挂在各码结点
 * 下面的只读接口叶子的数据源。
 *
 * 清单不新建第二份登记表——路径与门码全部从现有代码推导：
 *   - 内容端点：`APP_BOOK_REQUEST_CONTENT_SUFFIXES`（要登录凭证，门码由
 *     `requiredApiPermission()` 现算——migration 0131 起按内容域逐端点分发，
 *     不再是单一 `app:mobile:access`）；
 *   - 匿名端点：`APP_BOOK_REQUEST_ANONYMOUS_ROUTES`（登录 / 换 token / 验证码 /
 *     项目与登录信息 / 关于页，不需要凭证也不需要码）；
 *   - `/api/app/*` 四个：搜索权限、名词解释、版本升级、运营公告，门码同样
 *     `requiredApiPermission()` 现算（搜索权限是 `app:search:global` / book 的
 *     任一双码门）。
 *
 * 这样接口新增或改门码时清单自动跟上，管理台不可能展示一份过期清单。
 * 只读：v1 不改鉴权级，运行时权威仍是中间件与各端点自身。
 */

import {
  APP_BOOK_REQUEST_ANONYMOUS_ROUTES,
  APP_BOOK_REQUEST_CONTENT_SUFFIXES,
} from "@/server/api/access";
import {requiredApiPermission} from "@/server/api/api-permissions";
import type {AppInterfaceRow} from "@/shared/AppInterface";

/** `/api/` 基址（App 端点沿用旧基址，但它们是当前接口面而非弃用面）。 */
const LEGACY_API_BASE = "/api/";
const APP_BOOK_BASE = "/api/AppBookRequest/";

/** `/api/app/*` 四个端点：路径带尾斜杠，与中间件规范化后的形态一致。 */
const APP_API_PATHS = [
  "/api/app/search-permission/",
  "/api/app/mingci-permission/",
  "/api/app/version/",
  "/api/app/announcements/",
] as const;

/** 单码 / 任一双码门统一成数组，匿名端点为空数组。 */
function gateCodes(path: string): readonly string[] {
  const required = requiredApiPermission(path, "GET");
  if (required === null) return [];
  return typeof required === "string" ? [required] : [...required];
}

/** 要凭证的端点：门码从映射表现算（内容端点与 `/api/app/*` 同一口径）。 */
function credentialRow(path: string): AppInterfaceRow {
  return {
    auth: "mflc",
    method: "GET",
    path,
    permissionCodes: gateCodes(path),
  };
}

/**
 * 全部 App 接口（18 行 = 8 内容 + 6 匿名 + 4 个 `/api/app/*`）。
 * 顺序即展示顺序：先内容端点，再匿名端点，最后 `/api/app/*`。
 */
export function listAppInterfaces(): AppInterfaceRow[] {
  return [
    ...[...APP_BOOK_REQUEST_CONTENT_SUFFIXES].map((suffix) =>
      credentialRow(`${LEGACY_API_BASE}${suffix}`)),
    ...APP_BOOK_REQUEST_ANONYMOUS_ROUTES.map((route) => ({
      auth: "anonymous" as const,
      method: "GET",
      path: `${APP_BOOK_BASE}${route}`,
      permissionCodes: [],
    })),
    ...APP_API_PATHS.map((path) => credentialRow(path)),
  ];
}
