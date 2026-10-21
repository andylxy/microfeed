import {describe, expect, it} from "vitest";

import {RBAC_PERMISSIONS} from "@/server/rbac/seed";
import {RBAC_PERMISSION_DOCS, permissionDoc} from "@/shared/RbacPermissionDocs";

/**
 * 权限说明必须与权限目录同步：目录新增码时这里会失败，提醒补说明。
 * 同时钉住两条「不编造」的口径——无守卫引用、无后台页面的码如实标注。
 */
describe("RBAC permission docs", () => {
  it("covers every code in the catalog", () => {
    const missing = RBAC_PERMISSIONS.map((permission) => permission.code).filter(
      (code) => !RBAC_PERMISSION_DOCS[code],
    );
    expect(missing).toEqual([]);
  });

  it("has no entry for a code the catalog does not define", () => {
    const catalog = new Set(RBAC_PERMISSIONS.map((permission) => permission.code));
    const extra = Object.keys(RBAC_PERMISSION_DOCS).filter((code) => !catalog.has(code));
    expect(extra).toEqual([]);
  });

  it("gives every entry a summary and at least one gate", () => {
    for (const [code, doc] of Object.entries(RBAC_PERMISSION_DOCS)) {
      expect(doc.summary.trim(), code).not.toBe("");
      expect(doc.gates.length, code).toBeGreaterThan(0);
    }
  });

  it("does not invent a guard for the unused login-log manage code", () => {
    expect(permissionDoc("system:login-log:manage")?.gates).toEqual([
      "代码中暂无守卫引用",
    ]);
  });

  it("returns null for an unknown or empty code", () => {
    expect(permissionDoc("nope:missing:code")).toBeNull();
    expect(permissionDoc(null)).toBeNull();
    expect(permissionDoc("")).toBeNull();
  });
});
