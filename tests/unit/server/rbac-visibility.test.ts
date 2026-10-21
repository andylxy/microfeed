import {describe, expect, it} from "vitest";

import {isAppBoardVisible} from "@/server/rbac/resolve";

/**
 * App 权限板可见性（ADR-0039 R1，2026-10-21 收紧）。
 *
 * 这道闸门是「看不看得到 App 分类」的唯一依据，必须与 App 端四个数据端点
 * （权限树 list/save/export、role-permissions）的守卫码严格一致——只认
 * `system:app-capability:manage`。`app:` 系列码是移动端运行时用的业务码，
 * 默认会授给 editor，若把它们当成可见性依据，就会出现「看得到标题、点进去
 * 却 403」的破窗。本文件把这道锁钉住，防止以后回潮。
 */
describe("isAppBoardVisible", () => {
  it("grants the wildcard holder (super_admin)", () => {
    expect(isAppBoardVisible(new Set(["*"]))).toBe(true);
  });

  it("grants a role that holds the App capability code", () => {
    expect(isAppBoardVisible(new Set(["system:app-capability:manage"]))).toBe(true);
  });

  it("hides from a role that holds only a mobile business code (no manage code)", () => {
    // editor 默认持 app:version:read / app:announcement:read，但无管理码。
    expect(isAppBoardVisible(new Set(["app:mingci:view"]))).toBe(false);
  });

  it("hides from a role that can open the RBAC page but holds no App manage code", () => {
    // 能开页（持 system:role:manage）+ 有 app: 码，却无 system:app-capability:manage
    // —— 这正是旧破窗场景，收紧后必须看不到 App 分类。
    expect(
      isAppBoardVisible(new Set(["system:role:manage", "app:mingci:view"])),
    ).toBe(false);
  });

  it("hides when the permission set is null or empty", () => {
    expect(isAppBoardVisible(null)).toBe(false);
    expect(isAppBoardVisible(new Set())).toBe(false);
  });

  it("hides a desktop-only admin that holds no App manage code", () => {
    expect(isAppBoardVisible(new Set(["system:role:manage"]))).toBe(false);
  });
});
