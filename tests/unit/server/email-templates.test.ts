import {describe, expect, it} from "vitest";

import {
  DEFAULT_OTP_EMAIL_TEMPLATE,
  renderOtpEmail,
} from "@/server/mail/email-templates";
import {
  DEFAULT_MAIL_SETTINGS,
  parseMailSettingsConfig,
  resolveFromAddress,
} from "@/server/mail/mail-config";

/**
 * 邮件设置的数据侧守卫：模板渲染（纯函数）+ 配置归一 + 发信地址解析。
 *
 * 这三个函数是「后台邮件设置卡片 → 用户收到的邮件」这条链路上唯一可离线验证的
 * 一段：D1 那一步由 `saveMailSettingsConfig` / `readMailSettingsConfig` 直接
 * 读写 settings 表，集成验证只能在联调环境做；而「留空回落默认」「占位符替换」
 * 「显示名拼接」的语义全在这里，因此在这里钉住。
 */

describe("renderOtpEmail", () => {
  it("falls back to the factory template when nothing is configured", () => {
    const rendered = renderOtpEmail(null, "123456", 10);
    expect(rendered.subject).toBe(DEFAULT_OTP_EMAIL_TEMPLATE.subject);
    // 默认正文里占位符必须已被替换：留一个 `{{code}}` 就意味着用户收到空验证码。
    expect(rendered.html).not.toContain("{{code}}");
    expect(rendered.html).not.toContain("{{expireMinutes}}");
    expect(rendered.html).toContain("123456");
    expect(rendered.html).toContain("10 分钟");
  });

  it("treats empty and whitespace-only fields as \"use the default\"", () => {
    for (const value of ["", "   ", "\n\t"]) {
      const rendered = renderOtpEmail(
        {subjectTemplate: value, bodyTemplate: value},
        "654321",
        5,
      );
      expect(rendered.subject).toBe(DEFAULT_OTP_EMAIL_TEMPLATE.subject);
      expect(rendered.html).toBe(
        // 有效期不同，正文必然不同，所以这里比对的是「替换后的默认正文」。
        DEFAULT_OTP_EMAIL_TEMPLATE.bodyHtml
          .split("{{code}}").join("654321")
          .split("{{expireMinutes}}").join("5"),
      );
    }
  });

  it("uses the configured subject and body, replacing every occurrence", () => {
    const rendered = renderOtpEmail(
      {
        subjectTemplate: "【中医百科】{{code}} 是您的验证码",
        bodyTemplate: "<p>{{code}}</p><p>again {{code}}</p><p>{{expireMinutes}} 分钟</p>",
      },
      "000123",
      10,
    );
    expect(rendered.subject).toBe("【中医百科】000123 是您的验证码");
    expect(rendered.html).toBe(
      "<p>000123</p><p>again 000123</p><p>10 分钟</p>",
    );
  });

  it("replaces literally, never as a regular-expression pattern", () => {
    // `String.replace` 会把替换串里的 `$&` 当成「整个匹配」再展开一次，
    // 验证码里一旦出现 `$` 就会被二次解释。split/join 不应有这个行为。
    const rendered = renderOtpEmail({bodyTemplate: "{{code}}"}, "$&$1", 10);
    expect(rendered.html).toBe("$&$1");
  });

  it("ignores non-string template values", () => {
    const rendered = renderOtpEmail(
      // 越过类型边界：库里是 JSON，脏数据可能给出数字或对象。
      {subjectTemplate: 123 as unknown as string, bodyTemplate: null},
      "111111",
      10,
    );
    expect(rendered.subject).toBe(DEFAULT_OTP_EMAIL_TEMPLATE.subject);
    expect(rendered.html).toContain("111111");
  });
});

describe("parseMailSettingsConfig", () => {
  it("returns the default config for null, arrays and primitives", () => {
    for (const raw of [null, undefined, [], "string", 42]) {
      expect(parseMailSettingsConfig(raw)).toEqual(DEFAULT_MAIL_SETTINGS);
    }
  });

  it("trims strings and keeps server-owned fields", () => {
    const config = parseMailSettingsConfig({
      fromAddress: "  no-reply@example.com  ",
      fromName: " 中医百科 ",
      subjectTemplate: " 主题 ",
      bodyTemplate: " <p>正文</p> ",
      updatedAtMs: 1700000000000,
      updatedBy: "u_1",
    });
    expect(config).toEqual({
      fromAddress: "no-reply@example.com",
      fromName: "中医百科",
      subjectTemplate: "主题",
      bodyTemplate: "<p>正文</p>",
      updatedAtMs: 1700000000000,
      updatedBy: "u_1",
    });
  });

  it("drops non-string fields instead of coercing them", () => {
    const config = parseMailSettingsConfig({
      fromAddress: 123,
      fromName: {nested: true},
      subjectTemplate: [],
      bodyTemplate: false,
    });
    expect(config.fromAddress).toBe("");
    expect(config.fromName).toBe("");
    expect(config.subjectTemplate).toBe("");
    expect(config.bodyTemplate).toBe("");
  });
});

describe("resolveFromAddress", () => {
  const config = (overrides: Record<string, string> = {}) => ({
    ...DEFAULT_MAIL_SETTINGS,
    ...overrides,
  });

  it("prefers the saved address over the environment fallback", () => {
    expect(resolveFromAddress(config({fromAddress: "a@x.com"}), "b@y.com"))
      .toBe("a@x.com");
  });

  it("falls back to the environment address when the field is empty", () => {
    expect(resolveFromAddress(config(), "b@y.com")).toBe("b@y.com");
  });

  it("joins the display name in RFC 5322 form", () => {
    expect(
      resolveFromAddress(
        config({fromAddress: "a@x.com", fromName: "中医百科"}),
        "",
      ),
    ).toBe("中医百科 <a@x.com>");
  });

  it("returns an empty string when neither source has an address", () => {
    expect(resolveFromAddress(config(), undefined)).toBe("");
    expect(resolveFromAddress(config({fromName: "中医百科"}), "")).toBe("");
  });
});
