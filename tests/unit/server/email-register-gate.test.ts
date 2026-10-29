import {describe, expect, it, vi, beforeEach} from "vitest";
import {readFileSync} from "node:fs";
import path from "node:path";

import {
  DEFAULT_LOGIN_METHODS,
  LOGIN_METHOD_TOGGLE_KEYS,
  parseLoginMethodsConfig,
} from "@/shared/AppLoginMethods";
import {emailRegisterGate} from "@/server/app/email-register/gate";

/**
 * 邮箱注册的「开关门」守卫。
 *
 * ADR §6.1「开关门控」：三个匿名端点（发码 / 校验 / 建号）共用同一条前置检查，
 * 后台「登录方式」里 `emailRegisterEnabled` 关掉时三者都该在最早处统一拒绝。
 *
 * 三层防护，缺一不可：
 * 1. 配置默认值必须是关（功能上线不等于默认开放）；
 * 2. 门函数 `emailRegisterGate` 关闭时返回统一失败响应；
 * 3. 每个端点源码都必须调用门函数并守卫——这层没法用请求级测试覆盖（端点依赖
 *    `cloudflare:workers` 的 env 注入），所以直接盯住源码。
 */

const mocks = vi.hoisted(() => ({
  readLoginMethodsConfigCached: vi.fn(),
}));

vi.mock("@/server/app/login/config", () => ({
  readLoginMethodsConfigCached: mocks.readLoginMethodsConfigCached,
}));

describe("emailRegisterEnabled 配置", () => {
  it("缺省为关闭：功能上线不等于默认开放", () => {
    expect(DEFAULT_LOGIN_METHODS.emailRegisterEnabled).toBe(false);
  });

  it("是合法的开关键，保存端点据此自动允许写入", () => {
    expect(LOGIN_METHOD_TOGGLE_KEYS).toContain("emailRegisterEnabled");
  });

  it("整行缺失时回落默认值（关闭）", () => {
    expect(parseLoginMethodsConfig(null).emailRegisterEnabled).toBe(false);
    expect(parseLoginMethodsConfig({}).emailRegisterEnabled).toBe(false);
  });

  it("非布尔值不被当成 truthy 值放行", () => {
    expect(parseLoginMethodsConfig({emailRegisterEnabled: "true"}).emailRegisterEnabled)
      .toBe(false);
    expect(parseLoginMethodsConfig({emailRegisterEnabled: 1}).emailRegisterEnabled).toBe(false);
  });

  it("显式 true / false 原样保留", () => {
    expect(parseLoginMethodsConfig({emailRegisterEnabled: true}).emailRegisterEnabled).toBe(true);
    expect(parseLoginMethodsConfig({emailRegisterEnabled: false}).emailRegisterEnabled)
      .toBe(false);
  });
});

describe("smsRegisterEnabled 配置", () => {
  it("缺省为开启：手机号注册是注册页默认流程", () => {
    expect(DEFAULT_LOGIN_METHODS.smsRegisterEnabled).toBe(true);
  });

  it("是合法的开关键，保存端点据此自动允许写入", () => {
    expect(LOGIN_METHOD_TOGGLE_KEYS).toContain("smsRegisterEnabled");
  });

  it("整行缺失时回落默认值（开启）", () => {
    expect(parseLoginMethodsConfig(null).smsRegisterEnabled).toBe(true);
    expect(parseLoginMethodsConfig({}).smsRegisterEnabled).toBe(true);
  });

  it("非布尔值不被当成 truthy 值放行", () => {
    expect(parseLoginMethodsConfig({smsRegisterEnabled: "false"}).smsRegisterEnabled)
      .toBe(true);
    expect(parseLoginMethodsConfig({smsRegisterEnabled: 0}).smsRegisterEnabled).toBe(true);
  });

  it("显式 true / false 原样保留", () => {
    expect(parseLoginMethodsConfig({smsRegisterEnabled: true}).smsRegisterEnabled).toBe(true);
    expect(parseLoginMethodsConfig({smsRegisterEnabled: false}).smsRegisterEnabled).toBe(false);
  });
});

describe("emailRegisterGate 开关门", () => {
  beforeEach(() => {
    mocks.readLoginMethodsConfigCached.mockReset();
  });

  it("开关开启时返回 null，业务继续", async () => {
    mocks.readLoginMethodsConfigCached.mockResolvedValue({emailRegisterEnabled: true});
    await expect(emailRegisterGate({} as never)).resolves.toBeNull();
  });

  it("开关关闭时返回统一失败响应（含统一文案）", async () => {
    mocks.readLoginMethodsConfigCached.mockResolvedValue({emailRegisterEnabled: false});
    const response = await emailRegisterGate({} as never);
    expect(response).not.toBeNull();
    const body = (await response!.json()) as {data: string};
    expect(body.data).toBe("邮箱注册暂未开放");
  });

  it("读取的正是登录方式配置（门函数把 db 传进去）", async () => {
    const db = {} as never;
    mocks.readLoginMethodsConfigCached.mockResolvedValue({emailRegisterEnabled: true});
    await emailRegisterGate(db);
    expect(mocks.readLoginMethodsConfigCached).toHaveBeenCalledWith(db);
  });
});

describe("四个邮箱端点各自调用开关门", () => {
  const endpoints = [
    "src/pages/api/AppBookRequest/emailCodeGet.ts",
    "src/pages/api/AppBookRequest/emailCodeCheckout.ts",
    "src/pages/api/AppBookRequest/emailRegister.ts",
    "src/pages/api/AppBookRequest/checkEmailRegistered.ts",
  ];

  for (const relative of endpoints) {
    it(`${path.basename(relative)} 在动手前先读开关`, () => {
      const source = readFileSync(path.join(process.cwd(), relative), "utf8");
      expect(source).toContain("emailRegisterGate");
      expect(source).toContain("if (gate) return gate;");
    });
  }
});
