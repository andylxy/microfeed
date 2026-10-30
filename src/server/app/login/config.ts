/**
 * App 登录方式配置的 IO 层（ADR-0050）。
 *
 * 单行 JSON 存 `settings` 表（category=`app_login_methods`），驱动 App 登录页
 * 展示哪些登录方式、图形验证码是否强制。两个可控面（方案 §1/§2）：
 *   - 前端入口显隐：`GET /api/AppBookRequest/getLoginMethods` 给 App 渲染开关；
 *   - 后端受理（硬门）：`appLogin` 对停用方式直接拒绝。
 * 两条读路径共用同一份 `caches.default` 副本（{@link readLoginMethodsConfigCached}），
 * 保存路径写后清缓存（{@link saveLoginMethodsConfig}）。类型、默认值与归一
 * 在 `src/shared/AppLoginMethods.ts`（admin 组件同用）。
 *
 * 读写都走 {@link FeedDb} 的 settings 通道（getSettingsCategory /
 * setSettingsCategory），settings 表的 SQL 收在 FeedDb 一处。写先校验再动库，
 * 以可辨识结果返回而不是抛错，AJAX 层不用 try/catch 就能回 400。
 */

import {SETTINGS_CATEGORIES} from "@/shared/Constants";
import {
  LOGIN_METHOD_TOGGLE_KEYS,
  parseLoginMethodsConfig,
  type LoginMethodsConfig,
  type LoginMethodsPatch,
  type LoginMethodsWriteResult,
} from "@/shared/AppLoginMethods";
import {
  APP_LOGIN_METHODS_CACHE,
  cachedJson,
  deleteCachedJson,
} from "@/server/cache/app-cache";
import type FeedDb from "@/server/feed/FeedDb";

/** D1 直读（缓存未命中时的回源函数）：主键点查 1 行。 */
export async function readLoginMethodsConfig(
  db: FeedDb,
): Promise<LoginMethodsConfig> {
  const raw = await db.getSettingsCategory<unknown>(
    SETTINGS_CATEGORIES.APP_LOGIN_METHODS,
  );
  return parseLoginMethodsConfig(raw);
}

/**
 * read-through 读（ADR-0050 D3）：`caches.default` 命中 0 D1 行读；未命中 /
 * 坏条目回源 D1 一次并写回。缓存值是归一后配置的 JSON 文本，命中后再过一遍
 * {@link parseLoginMethodsConfig}（幂等），旧版本字段形状因此无害。
 */
export async function readLoginMethodsConfigCached(
  db: FeedDb,
): Promise<LoginMethodsConfig> {
  const raw = await cachedJson<unknown>(
    APP_LOGIN_METHODS_CACHE,
    () => readLoginMethodsConfig(db),
    "login-methods",
  );
  return parseLoginMethodsConfig(raw);
}

/**
 * read-merge-write 保存（ADR-0050 D3）：patch 只接受显式布尔（其余值是调用方
 * 契约错误，整次拒绝、不动库）；`updatedAtMs` / `updatedBy` 服务端置值；D1
 * upsert 成功后清缓存条目。允许全部关闭（ADR-0050 D5）。
 */
export async function saveLoginMethodsConfig(
  db: FeedDb,
  patch: LoginMethodsPatch,
  updatedBy: string,
): Promise<LoginMethodsWriteResult> {
  for (const key of LOGIN_METHOD_TOGGLE_KEYS) {
    if (patch[key] !== undefined && typeof patch[key] !== "boolean") {
      return {ok: false, reason: "invalidConfig"};
    }
  }
  const current = await readLoginMethodsConfig(db);
  const next: LoginMethodsConfig = {...current};
  for (const key of LOGIN_METHOD_TOGGLE_KEYS) {
    if (typeof patch[key] === "boolean") {
      next[key] = patch[key] as boolean;
    }
  }
  next.updatedAtMs = Date.now();
  next.updatedBy = updatedBy;
  await db.setSettingsCategory(
    SETTINGS_CATEGORIES.APP_LOGIN_METHODS,
    JSON.stringify(next),
  );
  await deleteCachedJson(APP_LOGIN_METHODS_CACHE);
  return {ok: true};
}

/**
 * 统一的登录方式业务闸（账号密码登录 app-auth 与第三方登录 app-third-party 共用）。
 *
 * 返回旧后端风格失败文案；返回 null 表示闸门通过。两端的总闸文案、方式闸文案
 * 只有这一处来源，不会分叉（此前两个文件各自写了一遍「登录功能开发中,敬请期待」/
 * 「该登录方式已停用」，改一处忘另一处就会不一致）。
 *
 * @param loginMethods   已读取的配置
 * @param methodEnabled  当前登录方式开关（账号密码传 accountPasswordEnabled，QQ 传 qqEnabled）
 */
export function enforceLoginMethodsGates(
  loginMethods: LoginMethodsConfig,
  methodEnabled: boolean,
): string | null {
  if (!loginMethods.loginEnabled) return "登录功能开发中,敬请期待";
  if (!methodEnabled) return "该登录方式已停用";
  return null;
}
