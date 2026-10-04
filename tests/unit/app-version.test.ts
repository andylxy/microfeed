import {describe, expect, it} from "vitest";

import {
  compareVersionCode,
  hashDevicePercent,
  parseAppVersionCode,
} from "@/server/app-version/resolve";

/**
 * 纯逻辑测试（spec §6.3 / §6.4）。
 *
 * 这里**只测不碰数据库的函数**。原先还有一个按 SQL 文本嗅探的 `stubDb` 假 D1，
 * 违反 AGENTS.md「禁止 mock/假的」，且它"测"的规则在
 * `tests/worker/app-version-routes.test.ts` 里已用**真实 D1** 覆盖（那才是可信的）。
 * 灰度解析的语义（优先级、软规则不抬地板、percent 分桶）现在全部由 worker 测试承担。
 */

describe("compareVersionCode", () => {
  it("按整数比较大小，而不是点分字符串", () => {
    expect(compareVersionCode(10, 9)).toBe(1);
    expect(compareVersionCode(9, 10)).toBe(-1);
    expect(compareVersionCode(10, 10)).toBe(0);
  });

  it("把非有限输入当作 0，而不是抛错", () => {
    expect(compareVersionCode(Number.NaN, 0)).toBe(0);
    expect(compareVersionCode(1, Number.NaN)).toBe(1);
  });
});

describe("parseAppVersionCode", () => {
  it("解析普通非负整数（允许首尾空白）", () => {
    expect(parseAppVersionCode("10")).toBe(10);
    expect(parseAppVersionCode(" 42 ")).toBe(42);
  });

  it("拒绝缺失、点分、带符号与非数字", () => {
    expect(parseAppVersionCode(null)).toBeNull();
    expect(parseAppVersionCode("")).toBeNull();
    expect(parseAppVersionCode("1.0.0")).toBeNull();
    expect(parseAppVersionCode("-1")).toBeNull();
    expect(parseAppVersionCode("abc")).toBeNull();
  });

  it("拒绝带小数点或指数形式的数字", () => {
    // 这些若被放行，`10.5` 会被当成 105 之类的错值，或让地板比较失真。
    expect(parseAppVersionCode("10.5")).toBeNull();
    expect(parseAppVersionCode("1e2")).toBeNull();
    expect(parseAppVersionCode("+10")).toBeNull();
  });
});

describe("hashDevicePercent", () => {
  it("确定性且落在 0..99", () => {
    const bucket = hashDevicePercent("device-abc");
    expect(bucket).toBe(hashDevicePercent("device-abc"));
    expect(bucket).toBeGreaterThanOrEqual(0);
    expect(bucket).toBeLessThan(100);
  });

  it("把不同设备分到不同桶", () => {
    const buckets = new Set(
      ["d1", "d2", "d3", "d4", "d5"].map((id) => hashDevicePercent(id)),
    );
    expect(buckets.size).toBeGreaterThan(1);
  });
});
