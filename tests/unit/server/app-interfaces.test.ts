import {describe, expect, it} from "vitest";

import {listAppInterfaces} from "@/server/admin/app-interfaces";
import {
  APP_BOOK_REQUEST_ANONYMOUS_ROUTES,
  APP_BOOK_REQUEST_CONTENT_SUFFIXES,
} from "@/server/api/access";

/**
 * App 接口清单（ADR-0039 D6，migration 0131 起按内容域逐端点分发门码）。
 *
 * 清单不另立登记表，18 行全部从现有代码推导，所以这里断言的是「推导结果」：
 * 数字对得上、每个端点的门码与 `DOMAIN_RULES` 的逐端点分发一致。清单哪天
 * 漏了新端点或挂了错码，这几条会先红。
 */
describe("listAppInterfaces", () => {
  const rows = listAppInterfaces();

  it("holds exactly the 18 App interfaces", () => {
    // 8 内容 + 6 匿名 + 4 个 /api/app/*。
    expect(rows).toHaveLength(18);
    expect(APP_BOOK_REQUEST_CONTENT_SUFFIXES.size).toBe(8);
    expect(APP_BOOK_REQUEST_ANONYMOUS_ROUTES).toHaveLength(6);
  });

  it("lists the anonymous pre-auth routes without a permission code", () => {
    const anonymous = rows.filter((row) => row.auth === "anonymous");
    expect(anonymous).toHaveLength(6);
    expect(anonymous.map((row) => row.path).sort()).toEqual(
      APP_BOOK_REQUEST_ANONYMOUS_ROUTES
        .map((route) => `/api/AppBookRequest/${route}`)
        .sort(),
    );
    // 匿名行不需要凭证，也就不该要码。
    expect(anonymous.every((row) => row.permissionCodes.length === 0)).toBe(true);
  });

  it("derives each content route's gate code from its own domain rule", () => {
    const gateOf = (path: string): readonly string[] =>
      rows.find((row) => row.path === path)?.permissionCodes ?? [];
    // 一个码对应一个内容域；同码只出现在中药的两个列表端点上。
    expect(gateOf("/api/AppBookRequest/GetNav/")).toEqual(["app:nav:read"]);
    expect(gateOf("/api/AppBookRequest/GetTipsStyleConfig/")).toEqual(["app:style:read"]);
    expect(gateOf("/api/AppBookRequest/GetBookChapter/")).toEqual(["app:chapter:read"]);
    expect(gateOf("/api/AppBookRequest/GetChapterContent/")).toEqual(["app:content:read"]);
    expect(gateOf("/api/AppBookRequest/GetBookIdFang/")).toEqual(["app:fang:read"]);
    expect(gateOf("/api/AppBookRequest/GetAllZhongYao/")).toEqual(["app:zhongyao:read"]);
    expect(gateOf("/api/AppBookRequest/GetAliaZhongYao/")).toEqual(["app:zhongyao:read"]);
    // 名词数据端点与 mingci-permission 同码：数据与它的查看权同权。
    expect(gateOf("/api/AppBookRequest/GetAllMingCi/")).toEqual(["app:mingci:view"]);
  });

  it("carries the four /api/app/* endpoints with their own codes", () => {
    const appApi = rows.filter((row) => row.path.startsWith("/api/app/"));
    expect(appApi.map((row) => row.path)).toEqual([
      "/api/app/search-permission/",
      "/api/app/mingci-permission/",
      "/api/app/version/",
      "/api/app/announcements/",
    ]);
    // 搜索权限是任一双码门；其余三个各挂一枚码，推不出来说明 DOMAIN_RULES
    // 与端点路径脱节了。
    expect(appApi[0]?.permissionCodes).toEqual(["app:search:global", "app:search:book"]);
    expect(appApi[1]?.permissionCodes).toEqual(["app:mingci:view"]);
    expect(appApi[2]?.permissionCodes).toEqual(["app:version:read"]);
    expect(appApi[3]?.permissionCodes).toEqual(["app:announcement:read"]);
  });

  it("keeps every path unique so the table reads as one entry per endpoint", () => {
    const paths = rows.map((row) => row.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(rows.every((row) => row.method === "GET")).toBe(true);
  });
});
