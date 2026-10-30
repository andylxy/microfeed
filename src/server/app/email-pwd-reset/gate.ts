/**
 * 账号安全两条链路的开关门（ADR-0015 D6 / F33）。
 *
 * 与 `email-register/gate.ts` 同形，但**不复用它的键**：`emailRegisterEnabled`
 * 管的是"建号"，关掉它是防注册滥用的停机手段；找回密码 / 补邮箱改的是**已有账号**，
 * 关注册不该连带把它们关掉。两个键独立，后台各有一个开关。
 */
import type FeedDb from "@/server/feed/FeedDb";
import {jsonResponse} from "@/server/http";
import {appEnvelope} from "@/server/tcm/envelope";
import {
  readLoginMethodsConfigCached,
} from "@/server/app/login/config";
import type {LoginMethodsConfig} from "@/shared/AppLoginMethods";

/** 读一次配置，供端点在同一次请求里同时做「开关门」与「图形验证码」判定。 */
export function readMethods(db: FeedDb): Promise<LoginMethodsConfig> {
  return readLoginMethodsConfigCached(db);
}

/** 找回密码开关门：开启返回 null（继续业务）。 */
export function pwdResetGate(methods: LoginMethodsConfig): Response | null {
  if (!methods.passwordResetEnabled) {
    return jsonResponse(appEnvelope("找回密码暂未开放"));
  }
  return null;
}

/** 补充邮箱开关门：开启返回 null（继续业务）。 */
export function bindEmailGate(methods: LoginMethodsConfig): Response | null {
  if (!methods.bindEmailEnabled) {
    return jsonResponse(appEnvelope("邮箱绑定暂未开放"));
  }
  return null;
}
