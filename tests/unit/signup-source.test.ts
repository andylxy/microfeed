import {describe, expect, it} from "vitest";

import {
  BANNED_GROUP_VALUE,
  BUILTIN_SIGNUP_SOURCES,
  DEFAULT_SIGNUP_SOURCES,
  SIGNUP_SOURCE_VALUE_PATTERN,
  checkSignupSourceRemoval,
  hasSignupSource,
  isValidSignupSourceOption,
  matchesSignupCategory,
  removedSources,
  validateSignupSources,
  type SignupSourceOption,
} from "@/shared/SignupSource";

function option(value: string, label = value): SignupSourceOption {
  return {label, value};
}

describe("signup source options", () => {
  it("accepts the seeded four", () => {
    expect(validateSignupSources([...DEFAULT_SIGNUP_SOURCES])).toBe(true);
    // `back` 是"当前部署已有、由手工 SQL 写入后被登记"的来源，跟着默认值一起
    // 下发，保证没有配置行时左栏与实际分组一致。
    expect(DEFAULT_SIGNUP_SOURCES.map((entry) => entry.value))
      .toEqual(["admin", "email", "qq", "back"]);
  });

  it("keeps every builtin source in the seed — the signup paths write them verbatim", () => {
    // 三条建号路径把这三个 value 写死在 SQL 里；种子漏掉一个，保存闸门会把
    // 默认列表判成「删了内建来源」，管理员第一次打开弹层就保存不了。
    for (const value of BUILTIN_SIGNUP_SOURCES) {
      expect(hasSignupSource([...DEFAULT_SIGNUP_SOURCES], value)).toBe(true);
    }
  });

  it("requires a lowercase identifier and a non-empty label", () => {
    expect(isValidSignupSourceOption(option("vip", "付费会员"))).toBe(true);
    expect(isValidSignupSourceOption(option("Vip", "付费会员"))).toBe(false);
    expect(isValidSignupSourceOption(option("1vip", "付费会员"))).toBe(false);
    expect(isValidSignupSourceOption({label: "   ", value: "vip"})).toBe(false);
    expect(isValidSignupSourceOption(option("a".repeat(33)))).toBe(false);
  });

  it("shares one pattern with the browser", () => {
    // 客户端预检与端点闸门用同一个正则，规则不会各写一份再分叉。
    expect(SIGNUP_SOURCE_VALUE_PATTERN.test("wechat_pay")).toBe(true);
    expect(SIGNUP_SOURCE_VALUE_PATTERN.test("wechat-pay")).toBe(false);
  });

  it("rejects an empty list and duplicate identifiers", () => {
    expect(validateSignupSources([])).toBe(false);
    expect(validateSignupSources(null)).toBe(false);
    expect(validateSignupSources([option("vip", "甲"), option("vip", "乙")])).toBe(false);
  });

  it("refuses to let the banned view leak into the source list", () => {
    // 「已封禁账号」按 banned 字段过滤，账号的 signup_source 永远不会等于它。
    // 一旦混进配置，那一列的取值域就多了一个谁也不会有的值。
    expect(isValidSignupSourceOption({label: "已封禁账号", value: BANNED_GROUP_VALUE}))
      .toBe(false);
    expect(validateSignupSources([
      option("admin"),
      option("email"),
      option("qq"),
      {label: "已封禁账号", value: BANNED_GROUP_VALUE},
    ])).toBe(false);
  });

  it("answers whether a value is configured", () => {
    expect(hasSignupSource([...DEFAULT_SIGNUP_SOURCES], "qq")).toBe(true);
    expect(hasSignupSource([...DEFAULT_SIGNUP_SOURCES], "vip")).toBe(false);
  });
});

describe("checkSignupSourceRemoval", () => {
  const current = [...DEFAULT_SIGNUP_SOURCES, option("vip", "付费会员")];

  it("allows dropping an unused custom source", () => {
    const next = [...DEFAULT_SIGNUP_SOURCES];
    expect(checkSignupSourceRemoval(current, next, {})).toEqual({
      builtinRemoved: [],
      inUse: [],
      removed: ["vip"],
    });
  });

  it("flags a dropped builtin even when nobody uses it", () => {
    const next = current.filter((entry) => entry.value !== "email");
    expect(checkSignupSourceRemoval(current, next, {}).builtinRemoved).toEqual(["email"]);
  });

  it("flags a dropped custom source that still has accounts", () => {
    const next = [...DEFAULT_SIGNUP_SOURCES];
    expect(checkSignupSourceRemoval(current, next, {vip: 3}).inUse)
      .toEqual([{count: 3, value: "vip"}]);
  });

  it("reports both kinds at once — the endpoint decides the status code", () => {
    const result = checkSignupSourceRemoval(current, [], {email: 2, vip: 1});
    expect(result.builtinRemoved).toEqual(["admin", "email", "qq"]);
    expect(result.inUse).toEqual([
      {count: 2, value: "email"},
      {count: 1, value: "vip"},
    ]);
  });

  it("shares the removed list with the counter instead of recomputing it", () => {
    const next = current.filter((entry) => entry.value !== "vip");
    expect(removedSources(current, next)).toEqual(["vip"]);
    expect(checkSignupSourceRemoval(current, next, {}).removed).toEqual(["vip"]);
  });
});

describe("matchesSignupCategory", () => {
  const bannedAccount = {banned: true, signupSource: "qq"};
  const activeAccount = {banned: false, signupSource: "qq"};

  it("puts a banned account only in the banned group", () => {
    expect(matchesSignupCategory(bannedAccount, BANNED_GROUP_VALUE)).toBe(true);
    // 来源分组排除已封禁账号：一个账号在同一时刻只属于一个分组。
    expect(matchesSignupCategory(bannedAccount, "qq")).toBe(false);
  });

  it("puts an active account only in its source group", () => {
    expect(matchesSignupCategory(activeAccount, "qq")).toBe(true);
    expect(matchesSignupCategory(activeAccount, BANNED_GROUP_VALUE)).toBe(false);
    expect(matchesSignupCategory(activeAccount, "email")).toBe(false);
  });

  it("keeps an unknown source reachable under its own category name", () => {
    expect(matchesSignupCategory({banned: false, signupSource: "back"}, "back")).toBe(true);
  });
});
