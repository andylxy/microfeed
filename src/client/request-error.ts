/**
 * 从 axios 错误里取出服务端已经本地化好的文案；取不到时用调用方给的兜底键。
 *
 * 后台 AJAX 失败统一回 `{"ok": false, "error": "<文案>"}`（HTTP 200），axios 把它
 * 放进 `error.response.data`，所以错误文案不需要客户端再翻译一次——服务端知道
 * 失败原因，客户端只负责显示。
 */
export function errorMessage(error: unknown, fallback: string): string {
  const response = (error as {response?: {data?: {error?: string}}})?.response;
  return response?.data?.error || fallback;
}
