/**
 * 发信传输层（邮箱 + 验证码注册 §3.2）。
 *
 * 只负责把一封**已经渲染好**的邮件交给 Resend。模板与占位符在
 * {@link module:email-templates} 处理，本模块不拼接正文、不认识验证码——
 * 这样传输层可独立替换（换邮件服务商只改这里）。
 *
 * 选用 Resend 的原因：生产运行时是 Cloudflare Workers，出站只有 HTTP
 * `fetch`，没有原生 TCP socket，SMTP 协议在运行时里无法建立连接。Resend 提供
 * HTTP API，Workers 原生 fetch 即可调用，无需新增 npm 依赖。
 *
 * API Key 只从 env 取（Workers secret），不进 UI / 不进 DB / 不进版本库。
 */

/** 发信失败。调用方（`code/get`）捕获后返回「验证码发送失败，请稍后重试」。 */
export class EmailSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailSendError";
  }
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * 发送一封邮件。
 *
 * @param runtimeEnv 提供 `RESEND_API_KEY`（Workers secret）的运行时环境。
 * @param to 收件邮箱。
 * @param subject 已渲染的主题。
 * @param html 已渲染的正文（HTML）。
 * @param fromAddress 发信地址（来自后台「邮件设置」，缺省由调用方回落 `RESEND_FROM`）。
 * @throws {EmailSendError} 缺密钥或 Resend 返回非 2xx。
 */
export async function sendEmailOtp(
  runtimeEnv: Env,
  to: string,
  subject: string,
  html: string,
  fromAddress: string,
): Promise<void> {
  const apiKey = runtimeEnv.RESEND_API_KEY;
  if (!apiKey) {
    throw new EmailSendError("RESEND_API_KEY is not configured");
  }
  if (!fromAddress) {
    throw new EmailSendError("from address is not configured");
  }

  const response = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddress,
      to: [to],
      subject,
      html,
    }),
  });

  if (!response.ok) {
    // 状态码进错误信息：Resend 的 4xx 多半是域名未验证 / 收件人被拒，
    // 排查时只看「发信失败」无法定位。响应体可能含账号信息，不外抛。
    throw new EmailSendError(`resend responded ${response.status}`);
  }
}
