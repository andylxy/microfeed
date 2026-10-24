import {isAdminPathname} from "@/shared/AdminPath";

/**
 * 全局安全响应头（ADR-0047 D2 / F2）。
 *
 * 应用点在 middleware 的导出层：`handleRequest` 的任意出口（含 308 / 404 /
 * 426 / 429 早退）都经这里补头，先于本模块的只有 `applyWorkerCachePolicy`
 * （缓存头与本模块互不重叠）。`public/` 静态资产经 ASSETS 直出、不经过
 * middleware，不在覆盖范围。
 *
 * 逐条依据：
 * - `nosniff`：阻止 MIME 嗅探；个别响应（site-files / media）已自带，重复
 *   设置无意义，故已存在则跳过。
 * - `Referrer-Policy`：跨源只泄 origin，与既有密码设置页的取值一致。
 * - `X-Frame-Options: SAMEORIGIN`（非 DENY）：主题预览以同源 iframe 嵌入
 *   后台设置页，DENY 会把它一并拦掉。
 * - HSTS 仅 https 响应携带：本地 dev 是 http，带上属无效头。
 * - CSP 只加在 admin 路径，且响应已自带 CSP（主题预览有自己的策略）时跳过，
 *   避免两条 CSP 取交集改变预览语义。`script-src 'unsafe-inline'` 的依据：
 *   语言脚本（AdminLanguageScript）与后台壳是内联 `<script>`，Astro islands
 *   的外链脚本由 `'self'` 覆盖。
 */
const ADMIN_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");

function setHeaderIfAbsent(
  headers: Headers,
  name: string,
  value: string,
): void {
  if (!headers.has(name)) {
    headers.set(name, value);
  }
}

/**
 * 就地补全安全响应头并返回同一 Response。只新增头，不覆盖上游已设置的值；
 * CSP 在已存在时整条跳过。
 */
export function withSecurityHeaders(
  request: Request,
  response: Response,
  options: {adminPath?: string | null},
): Response {
  const headers = response.headers;
  setHeaderIfAbsent(headers, "x-content-type-options", "nosniff");
  setHeaderIfAbsent(headers, "referrer-policy", "strict-origin-when-cross-origin");
  setHeaderIfAbsent(headers, "x-frame-options", "SAMEORIGIN");
  if (new URL(request.url).protocol === "https:") {
    setHeaderIfAbsent(headers, "strict-transport-security", "max-age=31536000");
  }
  const pathname = new URL(request.url).pathname;
  if (
    !headers.has("content-security-policy") &&
    isAdminPathname(pathname, options.adminPath)
  ) {
    headers.set("content-security-policy", ADMIN_CSP);
  }
  return response;
}
