import {describe, expect, it} from "vitest";

import * as Rbac from "@/shared/Rbac";

/**
 * 守护用例（ADR-0038 票据 06）：菜单派生的旧权限树机制必须保持退役状态。
 * 角色编辑器的授权树现在完全来自 `ext_permission_nodes`
 * （`readRbacBoard` → `buildGrantGroupsFromNodes`）。这里任何一个导出重新出现，
 * 都说明自持的树又退回到迁移 0127 冻结前那套 `ext_menu` + `ext_menu_permissions`
 * 的派生方式。
 */
describe("zero legacy permission-tree mapping (ADR-0038)", () => {
  const LEGACY_EXPORTS = [
    "buildPermissionTree",
    "RBAC_OTHER_GROUP",
    "RBAC_OTHER_PAGE",
    "RBAC_MINGCI_PAGE",
    "RBAC_VERSION_PAGE",
    "RBAC_ANNOUNCEMENT_PAGE",
    "RBAC_OPERATIONS_GROUP",
    "syntheticPageLabelKey",
  ];

  for (const symbol of LEGACY_EXPORTS) {
    it(`@/shared/Rbac no longer exports ${symbol}`, () => {
      expect(symbol in Rbac, `${symbol} should be retired`).toBe(false);
    });
  }
});
