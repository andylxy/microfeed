import {describe, expect, it} from "vitest";

import {translate} from "@/shared/i18n";
import {RBAC_AUDIT_ACTIONS} from "@/shared/RbacAudit";

/**
 * `RBAC_AUDIT_ACTIONS` 的注释要求它与 `rbacAudit.actionLabel.*` 保持同步，但此前
 * 没有任何东西强制这一点：漏一个标签，审计板会直接显示原始动作码（`role.login`
 * 就漏过一次）。这里逐项核对。
 */
describe("RBAC 审计动作标签", () => {
  it("每个动作都有中英文标签", () => {
    for (const action of RBAC_AUDIT_ACTIONS) {
      const key = `rbacAudit.actionLabel.${action}`;
      expect(translate(key, "en"), key).not.toBe(key);
      expect(translate(key, "zh-CN"), key).not.toBe(key);
    }
  });
});
