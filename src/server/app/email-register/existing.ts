/**
 * 邮箱是否已注册的查重守卫（邮箱 + 验证码注册）。
 *
 * 四个端点共用同一条查重，保证「已注册邮箱」在整个流程里任何一步都不会被放过：
 *
 * - `code/get`（发码）：**早期反馈**——已注册邮箱直接拒绝、不发码，避免用户走完
 *   「发码 → 校验 → 提交」全程最后才被告知「该邮箱已注册」。
 * - `code/checkout`（校验）：**预校验反馈**——已注册邮箱在输码后立即告知，
 *   不必等到提交建号。
 * - `register`（建号）：**最后一道守卫**——即使验证码有效，也拒绝为已占用邮箱建号。
 * - `checkEmailRegistered`（失焦检查）：**轻量只读查询**——不发码不发信，专供
 *   注册页「邮箱输入失焦即查」；命中「该邮箱已注册」时 App 直接 toast。
 *
 * 查的是 better-auth 的 `auth_user` 表（`user.modelName = "auth_user"`，见
 * better-auth.ts），email 已由 `normalizeEmail` 统一为小写，这里精确匹配。
 * 该表 `email` 列本身有 `UNIQUE` 约束（迁移 0002），查重只是提前拦截，不是唯一防线。
 *
 * ## 关于「注册过没有」暴露成可问信号（tradeoff）
 *
 * `code/get` 与 `checkEmailRegistered` 都会把「这个邮箱注册过没有」变成无需验证码
 * 即可问出的信号（枚举面）。这是刻意的产品取舍：移动端注册的常见做法就是点发送时
 * 立刻告知「该邮箱已注册」，失焦检查更是把反馈提前到输入完地址的那一刻，换取更直接
 * 的 UX。兜底由 `emailRegisterEnabled` 开关（默认关闭，停机手段）+ 发码限流承担，
 * 泄露的信息本身低敏感。
 */
export async function emailAlreadyRegistered(
  database: D1Database,
  email: string,
): Promise<boolean> {
  const row = await database
    .prepare("SELECT id FROM auth_user WHERE email = ?")
    .bind(email)
    .first<{id: string}>();
  return row !== null;
}
