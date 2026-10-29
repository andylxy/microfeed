import {describe, expect, it} from "vitest";

import {
  parseMailSettingsConfig,
  resolveFromAddress,
  saveMailSettingsConfig,
} from "@/server/mail/mail-config";
import {DEFAULT_MAIL_SETTINGS} from "@/shared/MailSettings";
import type FeedDb from "@/server/feed/FeedDb";

/**
 * 邮件设置的归一与发信地址拼接（`src/server/mail/mail-config.ts`）。
 *
 * 重点在 `fromName` 的清洗：它会被拼进 `Name <addr>`，含尖括号就会产出 Resend
 * 拒收的非法形态，而错误从后台界面完全看不出来（保存成功、发信 422）。
 * `saveMailSettingsConfig` 需要一个真 DB，这里用最小假对象——被测的是拼接逻辑，
 * 不是持久化（持久化由 `admin-mail-settings.test.ts` 与 worker 测试覆盖）。
 */

/** 只实现 `saveMailSettingsConfig` 用到的三个方法的假 DB。 */
function fakeDb(initial: unknown = null): FeedDb & {stored: unknown} {
  const holder = {
    stored: initial as unknown,
    getSettingsCategory: async () => holder.stored,
    setSettingsCategory: async (_category: string, value: string) => {
      holder.stored = JSON.parse(value) as unknown;
    },
  };
  return holder as unknown as FeedDb & {stored: unknown};
}

const base = {
  ...DEFAULT_MAIL_SETTINGS,
  fromAddress: "no-reply@881019.xyz",
};

describe("resolveFromAddress", () => {
  it("falls back to the env address when the config leaves it empty", () => {
    expect(
      resolveFromAddress({...base, fromAddress: ""}, "fallback@example.com"),
    ).toBe("fallback@example.com");
  });

  it("returns an empty string when both config and env are empty", () => {
    // 空串让传输层抛 EmailSendError，而不是发出一个 from 为空的请求。
    expect(resolveFromAddress({...base, fromAddress: ""}, undefined)).toBe("");
  });

  it("prefixes the display name when one is configured", () => {
    expect(resolveFromAddress({...base, fromName: "微读中医"}, undefined)).toBe(
      "微读中医 <no-reply@881019.xyz>",
    );
  });

  it("strips angle brackets and quotes that would break the Name <addr> form", () => {
    // 脏值形如用户把整个地址粘贴进了「发信人名称」框。不清洗的话拼出来是
    // `微读中医 <x@y.com> <no-reply@881019.xyz>`，Resend 回 422。
    const dirty = {
      ...base,
      fromName: '微读中医 <x@y.com> "quoted"',
    };
    expect(resolveFromAddress(dirty, undefined)).toBe(
      "微读中医 x@y.com quoted <no-reply@881019.xyz>",
    );
  });

  it("ignores a name that sanitizes down to nothing", () => {
    expect(resolveFromAddress({...base, fromName: "<>"}, undefined)).toBe(
      "no-reply@881019.xyz",
    );
  });
});

describe("parseMailSettingsConfig", () => {
  it("sanitizes a dirty fromName already sitting in the database", () => {
    const parsed = parseMailSettingsConfig({
      fromAddress: "no-reply@881019.xyz",
      fromName: "微读中医 <hack@evil.com>",
    });
    expect(parsed.fromName).toBe("微读中医 hack@evil.com");
  });

  it("keeps angle brackets in the body template", () => {
    // 模板本来就是 HTML，尖括号必须原样留着——清洗只针对 fromName。
    const parsed = parseMailSettingsConfig({
      bodyTemplate: "<div>{{code}}</div>",
    });
    expect(parsed.bodyTemplate).toBe("<div>{{code}}</div>");
  });
});

describe("saveMailSettingsConfig", () => {
  it("sanitizes fromName on write", async () => {
    const db = fakeDb();
    const result = await saveMailSettingsConfig(
      db,
      {fromName: '微读中医 <bad@x.com> "q"'},
      "admin",
    );
    expect(result).toEqual({ok: true});
    expect((db.stored as {fromName: string}).fromName).toBe("微读中医 bad@x.com q");
  });

  it("rejects a non-string patch without touching the database", async () => {
    const db = fakeDb();
    const result = await saveMailSettingsConfig(
      db,
      {fromAddress: 123} as unknown as Parameters<typeof saveMailSettingsConfig>[1],
      "admin",
    );
    expect(result).toEqual({ok: false, reason: "invalidConfig"});
    expect(db.stored).toBeNull();
  });
});
