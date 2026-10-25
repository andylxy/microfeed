import {afterEach, describe, expect, it} from "vitest";
import {env} from "cloudflare:workers";

import FeedDb from "@/server/feed/FeedDb";
import {
  readLoginMethodsConfig,
  readLoginMethodsConfigCached,
  saveLoginMethodsConfig,
} from "@/server/app/login/config";
import {
  DEFAULT_LOGIN_METHODS,
  parseLoginMethodsConfig,
} from "@/shared/AppLoginMethods";
import {
  APP_LOGIN_METHODS_CACHE,
  deleteCachedJson,
} from "@/server/cache/app-cache";

const db = env.FEED_DB;
const ORIGIN = "https://feed.example.com";
const CATEGORY = "app_login_methods";
// 与 app-cache.ts 的 appCacheKey 同一拼法（缓存键按字面量拼进测试是该模块的既有先例）。
const CACHE_KEY = new URL(
  `/app/${APP_LOGIN_METHODS_CACHE}`,
  "https://app-cache.microfeed.internal",
);

function newDb(): FeedDb {
  return new FeedDb(env, new Request(ORIGIN));
}

async function seedRaw(data: string): Promise<void> {
  await db.prepare(
    "INSERT INTO settings (category, data) VALUES (?, ?) " +
      "ON CONFLICT(category) DO UPDATE SET data = excluded.data",
  ).bind(CATEGORY, data).run();
}

afterEach(async () => {
  await db.prepare("DELETE FROM settings WHERE category = ?").bind(CATEGORY).run();
  await deleteCachedJson(APP_LOGIN_METHODS_CACHE);
});

describe("parseLoginMethodsConfig", () => {
  it("null 与坏类型整行兜底为默认（登录可用、账号密码开、验证码开、其余关）", () => {
    expect(parseLoginMethodsConfig(null)).toEqual(DEFAULT_LOGIN_METHODS);
    expect(parseLoginMethodsConfig("not-an-object")).toEqual(DEFAULT_LOGIN_METHODS);
    expect(DEFAULT_LOGIN_METHODS.loginEnabled).toBe(true);
  });

  it("字段缺失或坏类型逐字段补默认", () => {
    const parsed = parseLoginMethodsConfig({
      accountPasswordEnabled: false,
      smsEnabled: "yes",
      captchaEnabled: true,
    });
    expect(parsed.loginEnabled).toBe(true);
    expect(parsed.accountPasswordEnabled).toBe(false);
    expect(parsed.smsEnabled).toBe(DEFAULT_LOGIN_METHODS.smsEnabled);
    expect(parsed.wechatEnabled).toBe(false);
    expect(parsed.qqEnabled).toBe(false);
    expect(parsed.captchaEnabled).toBe(true);
  });

  it("loginEnabled 显式 false 保留（总闸可关），坏类型补默认 true", () => {
    expect(parseLoginMethodsConfig({loginEnabled: false}).loginEnabled).toBe(false);
    expect(parseLoginMethodsConfig({loginEnabled: "no"}).loginEnabled).toBe(true);
  });

  it("updatedAtMs / updatedBy 坏值归零、置 null", () => {
    const parsed = parseLoginMethodsConfig({
      updatedAtMs: "soon",
      updatedBy: 42,
    });
    expect(parsed.updatedAtMs).toBe(0);
    expect(parsed.updatedBy).toBe(null);
  });

  it("归一幂等：对已归一对象再跑一遍结果不变", () => {
    const once = parseLoginMethodsConfig({
      accountPasswordEnabled: false,
      captchaEnabled: false,
      updatedAtMs: 1730000000000,
      updatedBy: "acc_x",
    });
    expect(parseLoginMethodsConfig(once)).toEqual(once);
  });
});

describe("readLoginMethodsConfig", () => {
  it("缺行返回默认", async () => {
    const config = await readLoginMethodsConfig(newDb());
    expect(config).toEqual(DEFAULT_LOGIN_METHODS);
  });

  it("行存在时返回原值", async () => {
    await seedRaw(JSON.stringify({
      accountPasswordEnabled: false,
      captchaEnabled: false,
      smsEnabled: true,
      updatedAtMs: 1730000000000,
      updatedBy: "acc_x",
    }));
    const config = await readLoginMethodsConfig(newDb());
    expect(config.accountPasswordEnabled).toBe(false);
    expect(config.captchaEnabled).toBe(false);
    expect(config.smsEnabled).toBe(true);
    expect(config.updatedAtMs).toBe(1730000000000);
    expect(config.updatedBy).toBe("acc_x");
  });

  it("坏 JSON 行经 getSettingsCategory 归 null 后兜底为默认", async () => {
    await seedRaw("{not json");
    const config = await readLoginMethodsConfig(newDb());
    expect(config).toEqual(DEFAULT_LOGIN_METHODS);
  });
});

describe("saveLoginMethodsConfig", () => {
  it("只改 patch 携带的键，其余保留；版本与操作者服务端置值", async () => {
    const dbi = newDb();
    const result = await saveLoginMethodsConfig(
      dbi,
      {captchaEnabled: false, qqEnabled: true},
      "acc_admin",
    );
    expect(result).toEqual({ok: true});

    const stored = await readLoginMethodsConfig(dbi);
    // patch 外的布尔保留默认值。
    expect(stored.accountPasswordEnabled).toBe(true);
    expect(stored.smsEnabled).toBe(false);
    expect(stored.wechatEnabled).toBe(false);
    expect(stored.captchaEnabled).toBe(false);
    expect(stored.qqEnabled).toBe(true);
    expect(stored.updatedAtMs).toBeGreaterThan(0);
    expect(stored.updatedBy).toBe("acc_admin");
  });

  it("二次保存走 read-merge-write：已有值不被默认覆盖", async () => {
    const dbi = newDb();
    await saveLoginMethodsConfig(dbi, {accountPasswordEnabled: false}, "acc_a");
    await saveLoginMethodsConfig(dbi, {captchaEnabled: false}, "acc_b");

    const stored = await readLoginMethodsConfig(dbi);
    expect(stored.accountPasswordEnabled).toBe(false);
    expect(stored.captchaEnabled).toBe(false);
    expect(stored.updatedBy).toBe("acc_b");
  });

  it("patch 非布尔整次拒绝且不动库", async () => {
    const dbi = newDb();
    const before = await readLoginMethodsConfig(dbi);
    const result = await saveLoginMethodsConfig(
      dbi,
      {captchaEnabled: "off" as unknown as boolean},
      "acc_admin",
    );
    expect(result).toEqual({ok: false, reason: "invalidConfig"});
    expect(await readLoginMethodsConfig(dbi)).toEqual(before);
  });

  it("允许全部关闭", async () => {
    const dbi = newDb();
    const result = await saveLoginMethodsConfig(dbi, {
      accountPasswordEnabled: false,
      smsEnabled: false,
      wechatEnabled: false,
      qqEnabled: false,
      captchaEnabled: false,
    }, "acc_admin");
    expect(result).toEqual({ok: true});
    const stored = await readLoginMethodsConfig(dbi);
    expect(stored.accountPasswordEnabled).toBe(false);
    expect(stored.captchaEnabled).toBe(false);
  });
});

describe("readLoginMethodsConfigCached", () => {
  it("保存后缓存读到新值（清缓存生效）", async () => {
    const dbi = newDb();
    await saveLoginMethodsConfig(dbi, {captchaEnabled: false}, "acc_admin");
    const cached = await readLoginMethodsConfigCached(dbi);
    expect(cached.captchaEnabled).toBe(false);
  });

  it("缓存命中：绕过 save 直接改 D1 后，cached 读到旧值、直读读到新值", async () => {
    const dbi = newDb();
    await saveLoginMethodsConfig(dbi, {captchaEnabled: false}, "acc_admin");
    // 预热缓存条目。
    expect(await readLoginMethodsConfigCached(dbi)).toMatchObject({captchaEnabled: false});
    // 绕过 save 直接改库：缓存条目仍是旧值。
    await db.prepare(
      "UPDATE settings SET data = ? WHERE category = ?",
    ).bind(JSON.stringify({
      accountPasswordEnabled: true,
      captchaEnabled: true,
      updatedAtMs: 1,
      updatedBy: "direct",
    }), CATEGORY).run();

    const cached = await readLoginMethodsConfigCached(dbi);
    expect(cached.captchaEnabled).toBe(false);
    expect(await readLoginMethodsConfig(dbi)).toMatchObject({captchaEnabled: true});
  });

  it("缓存条目坏 JSON 时按未命中回源", async () => {
    const dbi = newDb();
    await saveLoginMethodsConfig(dbi, {captchaEnabled: false}, "acc_admin");
    await (caches as unknown as {
      default: {put: (k: URL, b: Response) => Promise<void>};
    }).default.put(CACHE_KEY, new Response("{not json"));
    const cached = await readLoginMethodsConfigCached(dbi);
    expect(cached.captchaEnabled).toBe(false);
  });

  it("缓存写入失败（无 Cache Storage）时退化为直读", async () => {
    // 本用例在 worker 环境有 Cache Storage，降级分支由 unit 环境覆盖
    //（globalThis.caches 为 undefined 时 cachedJson 直读）。此处验证带缓存
    // 环境下结果一致即可。
    const dbi = newDb();
    const cached = await readLoginMethodsConfigCached(dbi);
    expect(cached).toEqual(DEFAULT_LOGIN_METHODS);
  });
});
