/**
 * 校验过的邮箱 → 真实账号（邮箱 + 验证码注册 §3.5）。
 *
 * ## 为什么必须走 better-auth
 *
 * `auth_user` 表没有 password 列——口令哈希在 `auth_account`
 * （`providerId='credential'` 行）。只有 better-auth 的建号路径会同时写这两张表，
 * 后续 `appLogin` → `auth.api.signInEmail()` 才验证得过；裸 SQL 插 `auth_user`
 * 会造出一个永远登不上的账号。
 *
 * ## 为什么是 `signUpEmail`
 *
 * 后台建号与 bootstrap 走 `account-insert.ts` 自拼语句；本链路保留公开注册原
 * 语，因为建号授权已经由调用方刚校验通过的验证码给出，原语顺带提供了邮箱唯一
 * 的冲突判定与口令哈希。实例由 `createSignUpEnabledAuth` 提供、按请求新建、只
 * 在本文件内使用。
 *
 * ## username 与 emailVerified 要补写
 *
 * `signUpEmail` 不写 `username`（那是 username 插件的入口才管的事），默认
 * `emailVerified=0`。邮箱已验证是建号的前提，所以这里一次补上；username 撞车
 * 不属于致命错误（登录走邮箱），降级为只置 emailVerified。
 */

import {createSignUpEnabledAuth} from "@/server/auth/better-auth";
import {baseUsername, deriveUniqueUsername} from "@/server/app/email-register/username";

export type EmailSignupResult =
  | {ok: true; userId: string}
  | {ok: false; reason: "createFailed"};

/**
 * 用给定邮箱与口令建一个已验证邮箱的普通账号，返回用户 id。
 *
 * `emailVerified` 由本函数负责置 1，调用方不必再管——它是「邮箱已验证」这件事
 * 的落库点，放在建号同一个函数里才不会漏。
 */
export async function createVerifiedEmailUser(
  env: Env,
  request: Request,
  email: string,
  password: string,
): Promise<EmailSignupResult> {
  const username = await deriveUniqueUsername(env.FEED_DB, baseUsername(email));
  const displayName = baseUsername(email);

  let userId: string | null = null;
  try {
    const created = await createSignUpEnabledAuth(env, request).api.signUpEmail({
      body: {email, password, name: displayName},
      headers: request.headers,
    });
    userId = (created as {user?: {id?: string}} | undefined)?.user?.id ?? null;
  } catch (error) {
    // 建号失败的原因（口令策略、唯一冲突、插件钩子拒绝…）种类很多，只写服务端
    // 日志；对外由端点回通用文案，不泄露内部细节。
    console.error("[email-signup] signUpEmail 失败:", error);
    return {ok: false, reason: "createFailed"};
  }

  if (!userId) {
    const row = await env.FEED_DB.prepare(
      "SELECT id FROM auth_user WHERE email = ?",
    ).bind(email).first<{id: string}>();
    userId = row?.id ?? null;
  }
  if (!userId) {
    console.error("[email-signup] 建号返回无 id，且按邮箱回查不到行:", email);
    return {ok: false, reason: "createFailed"};
  }

  try {
    await env.FEED_DB.prepare(
      "UPDATE auth_user SET username = ?, displayUsername = ?, emailVerified = 1 WHERE id = ?",
    ).bind(username, displayName, userId).run();
  } catch (error) {
    // username 唯一索引冲突（与 deriveUniqueUsername 的检查之间存在并发窗口，
    // 概率极小）：账号已经建好，登录走邮箱不依赖 username，降级只置 emailVerified。
    console.error("[email-signup] 补写 username 失败，降级为只置 emailVerified:", error);
    await env.FEED_DB.prepare(
      "UPDATE auth_user SET emailVerified = 1 WHERE id = ?",
    ).bind(userId).run();
  }

  return {ok: true, userId};
}
