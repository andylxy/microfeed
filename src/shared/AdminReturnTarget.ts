/**
 * 后台编辑器「返回目标」的解析。
 *
 * 原「卷 / 方剂 / 中药 / 名词」四个 legacy 看板随 ADR-0069 退役，不再注册返回
 * 目标；独立模块看板（book-info / book-chapter / ming-ci / zhongyao / fang-yao /
 * yao-alia）当前不携带 `?from=`。故本模块不再解析任何看板：
 *   - `resolveAdminReturnTarget` 恒返回 `null`，调用方（条目编辑器）退回自己的默认返回链接；
 *   - `adminReturnQuery` 对任何看板名抛「未知看板」。
 *
 * 后续若某看板要接回编辑器返回目标，恢复注册表（`RETURN_BOARDS` 形如
 * `{<board>: {menuCode, params, required, path}}`）与解析逻辑即可，接口保持稳定。
 *
 * 接一个看板 = 注册一项 + 在链接上加一处 `?from=`，其余不动。
 */
import type {AdminMenuCode} from "./AdminNavigation";

/** 解析好的「回到你点进来的地方」。 */
export interface AdminReturnTarget {
  /** 返回链接文案的 i18n 键（`menu.item.<code>`）。 */
  labelKey: string;
  /** 编辑器应当高亮的菜单行。 */
  menuCode: AdminMenuCode;
  /** 要回去的后台地址，含查询串。 */
  url: string;
}

/**
 * 从编辑器地址上读 `?from=…`，解析成返回目标。
 *
 * 无注册看板（ADR-0069 退役全部 legacy 看板后），本函数恒返回 `null`，
 * 调用方保留自己的默认返回链接。
 */
export function resolveAdminReturnTarget(
  _search: URLSearchParams,
  _adminPath?: string | null,
): AdminReturnTarget | null {
  return null;
}

/**
 * 看板拼到编辑器链接上的查询串。
 *
 * 无注册看板，任何看板名都是未知：恒抛错。调用方不应再构造 `?from=`。
 */
export function adminReturnQuery(
  board: never,
  _params: Record<string, string | null | undefined>,
): string {
  throw new Error(`Unknown return board: ${String(board)}`);
}
