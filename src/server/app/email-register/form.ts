/**
 * 邮箱注册三个匿名端点（发码 / 校验 / 建号）的请求解析与失败文案。
 *
 * 这三个端点读同一组字段、用同一条邮箱形态规则、把同几种失败原因翻成同一批
 * 中文文案。集中到这里以后，改一句提示语只改一处，端点文件里只剩各自的业务流程。
 *
 * 本模块不碰数据库、不发信，只做「请求 → 值」与「失败原因 → 文案」。
 */

import {readStringField} from "@/server/http";

/**
 * 邮箱形态校验：不追求 RFC 完备，只挡明显脏数据与超长输入。
 * 本地部分 ≤64、域名 ≤255、顶级域 ≥2，与 RFC 5321 的长度上限一致。
 */
export const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/u;

/** 验证码用途的默认值：本端点族只服务注册，另两种用途留给后续端点。 */
export const DEFAULT_OTP_PURPOSE = "register";

/**
 * 取邮箱并归一：去首尾空白 + 转小写。
 * 后续查库、查重、发信、写 OTP 行都用这个值，保证同一个地址只有一种写法。
 */
export function normalizeEmail(body: unknown): string {
  return readStringField(body, "email").trim().toLowerCase();
}

/** 取验证码用途，缺省 `register`。 */
export function otpPurpose(body: unknown): string {
  return readStringField(body, "purpose").trim() || DEFAULT_OTP_PURPOSE;
}

/**
 * 解析请求体。解析失败返回 null，由调用方按「字段全空」处理——此时各端点会
 * 因为拿不到邮箱直接回「邮箱格式不正确」，不会走到查库与发信。
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * OTP 校验失败原因 → 给 App 看的文案。
 *
 * 「查不到」与「已过期」合并成一句：两者对用户是同一个动作（重新获取），
 * 分开说反而泄露「这个地址有没有发过码」。
 */
export function otpFailureMessage(
  reason: "notFound" | "expired" | "tooManyAttempts" | "mismatch",
): string {
  switch (reason) {
    case "tooManyAttempts":
      return "尝试次数过多，请重新获取";
    case "mismatch":
      return "验证码错误";
    case "notFound":
    case "expired":
      return "验证码无效或已过期";
  }
}
