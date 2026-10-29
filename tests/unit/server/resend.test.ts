import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

import {EmailSendError, sendEmailOtp} from "@/server/mail/resend";

/**
 * 发信传输层（`src/server/mail/resend.ts`）。
 *
 * 这一层是整条发信链路里**唯一与 Resend 直接对话**的地方，也是唯一无法在
 * 单测里真发一封的地方。所以这里 mock `fetch`，断言的是「我们发出去的请求
 * 长什么样」与「Resend 拒绝时我们抛什么」——这两件事一旦错了，线上表现是
 * 「用户点了发送、什么都没发生」，从日志里也看不出是请求体错了还是被拒了。
 *
 * 不 mock 到 `sendEmailOtp` 内部：断言请求体形状是这里的主要价值。
 */

/** 只提供 `RESEND_API_KEY` 的最小 env；其余字段与业务无关。 */
function envWith(apiKey: string | undefined): Env {
  return {RESEND_API_KEY: apiKey} as unknown as Env;
}

const OK_BODY = {id: "email_123"};

function okResponse(): Response {
  return new Response(JSON.stringify(OK_BODY), {
    status: 200,
    headers: {"content-type": "application/json"},
  });
}

function errResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({message, name: "validation_error"}), {
    status,
    headers: {"content-type": "application/json"},
  });
}

describe("sendEmailOtp", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("posts the four fields Resend requires, to the emails endpoint", async () => {
    await sendEmailOtp(
      envWith("re_test_key"),
      "user@example.com",
      "您的邮箱注册验证码",
      "<div>123456</div>",
      "微读中医 <no-reply@881019.xyz>",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer re_test_key",
    );
    expect((init.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
    // `to` 必须是数组：Resend 接受字符串但语义是「单收件人」，数组才是文档形态。
    expect(JSON.parse(init.body as string)).toEqual({
      from: "微读中医 <no-reply@881019.xyz>",
      to: ["user@example.com"],
      subject: "您的邮箱注册验证码",
      html: "<div>123456</div>",
    });
  });

  it("throws EmailSendError without calling fetch when the API key is missing", async () => {
    await expect(
      sendEmailOtp(envWith(undefined), "user@example.com", "s", "<p/>", "a@b.c"),
    ).rejects.toThrow(EmailSendError);
    // 缺 key 时不该发请求：空 key 打过去只会拿到 401，还白烧一次出站。
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws EmailSendError without calling fetch when the from address is empty", async () => {
    await expect(
      sendEmailOtp(envWith("re_test_key"), "user@example.com", "s", "<p/>", ""),
    ).rejects.toThrow(EmailSendError);
    // from 为空时 Resend 必回 422；本地先拒，省一次出站也给出更明确的错误。
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces the HTTP status on a non-2xx response so logs can tell 401 from 403", async () => {
    // 403 = 域名未验证，401 = key 无效。两者对运维的处理完全不同，日志必须能区分。
    fetchMock.mockResolvedValueOnce(errResponse(403, "domain is not verified"));

    await expect(
      sendEmailOtp(
        envWith("re_test_key"),
        "user@example.com",
        "s",
        "<p/>",
        "no-reply@example.com",
      ),
    ).rejects.toThrow(/resend responded 403/u);
  });

  it("does not leak Resend's response body into the error message", async () => {
    // 响应体可能含账号 id / 域名信息；错误对象会被上层 console.error，
    // 所以只允许状态码出门。
    fetchMock.mockResolvedValueOnce(
      errResponse(422, "account_abc123 has no verified domain"),
    );

    await expect(
      sendEmailOtp(
        envWith("re_test_key"),
        "user@example.com",
        "s",
        "<p/>",
        "no-reply@example.com",
      ),
    ).rejects.toThrow(/^resend responded 422$/u);
  });

  it("resolves quietly on 2xx", async () => {
    await expect(
      sendEmailOtp(
        envWith("re_test_key"),
        "user@example.com",
        "s",
        "<p/>",
        "no-reply@example.com",
      ),
    ).resolves.toBeUndefined();
  });
});
