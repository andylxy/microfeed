import type {APIRoute} from "astro";
import {cache, env} from "cloudflare:workers";

import FeedDb from "@/server/feed/FeedDb";
import {jsonResponse} from "@/server/http";
import {appEnvelope} from "@/server/tcm/envelope";
import {emailRegisterGate} from "@/server/app/email-register/gate";
import {emailAlreadyRegistered} from "@/server/app/email-register/existing";
import {
  EMAIL_PATTERN,
  normalizeEmail,
  readJsonBody,
} from "@/server/app/email-register/form";

/**
 * 邮箱是否已注册的轻量查询（邮箱 + 验证码注册）。匿名端点。
 *
 * 这是注册页「邮箱输入失焦即查」的专用端点（ADR §3.x）：只读 `auth_user` 一列，
 * **不发码、不发信、不占限流额度**——发码链路 `code/get` 已经做过早期拒绝，
 * 但那是用户主动点「发送验证码」才触发；失焦检查要在用户刚输完地址、还没点任何
 * 按钮时就给「该邮箱已注册」的反馈，不能靠发码端点（它会真发信 + 限流）。
 *
 * ## 开关门是有意的
 *
 * 本端点同样先走 `emailRegisterGate`：邮箱注册被后台关掉时，这里也必须统一回
 * 「邮箱注册暂未开放」，不能泄露「这个地址注册过没有」——那等于绕过 kill-switch
 * 把枚举信号重新打开。App 侧在开关关闭时本来就不显示邮箱方式卡，这个分支在正常
 * 流程里到不了，属纵深防御。
 *
 * 失败一律 `appEnvelope(文案字符串)`：旧后端风格（HTTP 200 + data 为字符串），
 * App 的 RequestHandler 按 data 是否为字符串判定成败，命中「该邮箱已注册」时
 * 服务端文案原样透出为 toast。
 */
export const POST: APIRoute = async ({request}) => {
  const body = await readJsonBody(request);
  const db = new FeedDb(env, request, cache);

  // 1. 开关门（见上头注释：关掉时既不发码也不泄露注册状态）
  const gate = await emailRegisterGate(db);
  if (gate) return gate;

  // 2. 邮箱格式
  const email = normalizeEmail(body);
  if (!EMAIL_PATTERN.test(email)) {
    return jsonResponse(appEnvelope("邮箱格式不正确"));
  }

  // 3. 查库：已注册 → 明确文案；未注册 → 空 Bean（成功形态）
  if (await emailAlreadyRegistered(env.FEED_DB, email)) {
    return jsonResponse(appEnvelope("该邮箱已注册"));
  }
  return jsonResponse(appEnvelope({}));
};
