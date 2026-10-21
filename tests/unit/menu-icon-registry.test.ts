import {describe, expect, it} from "vitest";

import {MENU_ICONS} from "@/components/admin/AdminMenuItemLink";
import {translate} from "@/shared/i18n";
import {MENU_ICON_NAMES} from "@/shared/MenuIconNames";

/**
 * 图标清单的两条不变量。原先住在 `menu-admin-ops.test.ts`（随菜单管理页一起退役），
 * 但权限树编辑器的图标下拉仍依赖它们，因此单独保留。
 */
describe("menu icon registry", () => {
  it("keeps MENU_ICONS (renderer) exactly in sync with MENU_ICON_NAMES (validator)", () => {
    expect(Object.keys(MENU_ICONS).sort()).toEqual([...MENU_ICON_NAMES].sort());
  });

  // 选择器对每个登记的图标名渲染 `menu.icon.<name>`，缺文案的项会直接显示原始键；
  // scripts/check-i18n.ts 在门禁层看同一组键，这里把失败留在清单旁边。
  it("labels every icon name in both languages", () => {
    for (const name of MENU_ICON_NAMES) {
      const key = `menu.icon.${name}`;
      expect(translate(key, "en"), key).not.toBe(key);
      expect(translate(key, "zh-CN"), key).not.toBe(key);
    }
  });
});
