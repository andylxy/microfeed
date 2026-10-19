import {beforeEach, describe, expect, it} from "vitest";

import {
  bindMenuAccount,
  isMenuCodeOpen,
  openMenuCode,
  syncMenuTopLevel,
  toggleMenuCode,
} from "@/client/menu-open-state";

/** 三个顶层分组。手风琴只在它们之间生效。 */
const TOP_LEVELS = ["group_content", "group_site", "group_integration"];

describe("menu open state", () => {
  beforeEach(() => {
    bindMenuAccount("menu-open-state-test");
    // 每个用例从「什么都没展开」开始。展开态是模块级单例，得逐个收起：
    // 不能用 `syncMenuTopLevel(null, …)` 复位——它会保留第一个已展开的顶层
    // （那是为了兼容老数据设计的，见 store 注释）。
    for (const code of [...TOP_LEVELS, "settings", "api"]) {
      if (isMenuCodeOpen(code)) toggleMenuCode(code, 0, TOP_LEVELS);
    }
  });

  it("keeps only one top level open at a time", () => {
    toggleMenuCode("group_content", 0, TOP_LEVELS);
    expect(isMenuCodeOpen("group_content")).toBe(true);

    toggleMenuCode("group_site", 0, TOP_LEVELS);
    expect(isMenuCodeOpen("group_site")).toBe(true);
    expect(isMenuCodeOpen("group_content")).toBe(false);
  });

  it("leaves deeper levels alone when the top level switches", () => {
    // 三级分区这类更深的节点不参与顶层互斥：切分组不该把它们收起来。
    openMenuCode("settings");
    toggleMenuCode("group_content", 0, TOP_LEVELS);
    toggleMenuCode("group_site", 0, TOP_LEVELS);

    expect(isMenuCodeOpen("group_content")).toBe(false);
    expect(isMenuCodeOpen("group_site")).toBe(true);
    expect(isMenuCodeOpen("settings")).toBe(true);
  });

  it("re-aligns to the page's own top level after navigation", () => {
    toggleMenuCode("group_content", 0, TOP_LEVELS);
    // 跳到「集成」下的页面：当前页所在的顶层展开，之前手动点开的那个收起。
    syncMenuTopLevel("group_integration", TOP_LEVELS);

    expect(isMenuCodeOpen("group_integration")).toBe(true);
    expect(isMenuCodeOpen("group_content")).toBe(false);
  });

  it("collapses leftover top levels recorded before the accordion existed", () => {
    openMenuCode("group_content");
    openMenuCode("group_site");
    // 老数据允许多个顶层同时展开；换页时只保留第一个，其余收起。
    syncMenuTopLevel(null, TOP_LEVELS);

    expect(isMenuCodeOpen("group_content")).toBe(true);
    expect(isMenuCodeOpen("group_site")).toBe(false);
  });

  it("collapses a top level when it is toggled twice", () => {
    toggleMenuCode("group_content", 0, TOP_LEVELS);
    toggleMenuCode("group_content", 0, TOP_LEVELS);

    expect(isMenuCodeOpen("group_content")).toBe(false);
  });
});
