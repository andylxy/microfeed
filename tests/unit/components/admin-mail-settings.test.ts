import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it} from "vitest";

import MailSettingsApp, {
  MAIL_SETTINGS_SUBMIT_KEY,
} from "@/components/admin/settings/MailSettingsApp";

/**
 * 「邮件设置」卡片的静态守卫（本仓无 DOM 环境，effect 不执行，只测首帧）。
 *
 * 卡片是 `client:only` 的 React 岛：设置页的 HTML 里看不到它，所以断链
 * （字段缺失、i18n 键缺失、按钮消失）只能靠这里挡住。首帧一律是「未读到配置」
 * 的降级态——四个输入为空、发信通道提示为缺失——这是**预期**的：真实值来自
 * 挂载后的 GET，effect 在 SSR 不跑。
 */
describe("mail settings card", () => {
  const render = () => renderToStaticMarkup(React.createElement(MailSettingsApp));

  it("renders the four editable fields with their labels", () => {
    const output = render();
    expect(output).toContain("Mail settings");
    expect(output).toContain("Sender address");
    expect(output).toContain("Sender name");
    expect(output).toContain("Subject template");
    expect(output).toContain("Body template (HTML)");
  });

  it("offers the save action wired to its own submit key", () => {
    const output = render();
    // SettingsBase 只在拿到 onSubmit 时才画右上角按钮；卡片自带保存流程，
    // 按钮消失意味着整块表单变成只读。
    expect(output).toContain('data-slot="card-action"');
    expect(output).toContain(">Update</button>");
    expect(MAIL_SETTINGS_SUBMIT_KEY).toBe("mail-settings");
  });

  it("documents the placeholders the templates accept", () => {
    const output = render();
    expect(output).toContain("{{code}}");
    expect(output).toContain("{{expireMinutes}}");
  });

  it("starts in the degraded delivery state until the config is loaded", () => {
    const output = render();
    // 未配置密钥时必须是醒目的红框提示，不能让人以为「保存了就能发信」。
    expect(output).toContain("RESEND_API_KEY");
    expect(output).toContain("border-destructive/40");
  });
});
