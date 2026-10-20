/**
 * 接口清单的一行（ADR-0039 D6，migration 0131 起两端共用同一形状）。
 *
 * 形状放 `src/shared/`：权限管理页的树叶子与详情表是浏览器组件，不能从
 * Worker 层取类型。数据装配仍在服务端（App 清单从 `access.ts` 与
 * `api-permissions.ts` 推导，PC 清单见 `src/server/admin/pc-interfaces.ts`），
 * 这里只有字段定义。
 */
export interface InterfaceCatalogRow {
  /** `anonymous` 匿名；`mflc` 登录凭证（Bearer）；`session` 后台会话（PC 管理端点）。 */
  auth: "anonymous" | "mflc" | "session";
  /** HTTP 方法；一个端点收多个方法时每个方法一行。 */
  method: string;
  /** 调用路径。 */
  path: string;
  /**
   * 该端点要求的权限码；匿名端点为空数组。多码 = 任一双码门（持其中任意
   * 一个即放行，migration 0131）。
   */
  permissionCodes: readonly string[];
}

/** 兼容别名：App 端清单行与 PC 端清单行同构。 */
export type AppInterfaceRow = InterfaceCatalogRow;
