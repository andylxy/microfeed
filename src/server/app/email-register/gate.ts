/**
 * 邮箱注册的「开关门」守卫。
 *
 * 三个匿名端点（发码 / 校验 / 建号）共用同一条前置检查：后台「登录方式」里的
 * `emailRegisterEnabled` 关掉时，三者都该在最早处统一拒绝。提取到这里后，
 * 三个端点各写一行守卫即可，拒绝文案也只有这一处。
 *
 * 本模块只做「开关判断 + 统一失败响应」，不碰请求体、不碰数据库业务。
 */
import type FeedDb from "@/server/feed/FeedDb";
import {jsonResponse} from "@/server/http";
import {appEnvelope} from "@/server/tcm/envelope";
import {readLoginMethodsConfigCached} from "@/server/app/login/config";

/**
 * 邮箱注册开关门：开启返回 null（继续业务），关闭返回统一失败响应。
 * 调用方 `const gate = await emailRegisterGate(db); if (gate) return gate;`。
 */
export async function emailRegisterGate(
  db: FeedDb,
): Promise<Response | null> {
  const methods = await readLoginMethodsConfigCached(db);
  if (!methods.emailRegisterEnabled) {
    return jsonResponse(appEnvelope("邮箱注册暂未开放"));
  }
  return null;
}
