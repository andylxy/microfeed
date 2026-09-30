/**
 * 旧后端统一响应包装（golden 对齐 2026-09-28）：
 * 旧 .NET 框架把每个 Json(...) 返回包成 `{code, data, msg}`（HttpData 形状，
 * App 的 RequestHandler 按 code 判定成功失败），字段名小驼峰。
 *
 * 本命名空间 13 个端点一律用此包装，与旧后端逐字节同形。唯一例外是
 * `GetTipsStyleConfig`：旧后端从未实现该端点，App 端用本地兜底；其响应体
 * 故意发裸 `{styles:[...]}`（顶层 `styles`，不走 HttpData 信封）——因为 App 的
 * `StyleConfigApiBean` 直接反序列化顶层 `styles` 字段，且 `RequestHandler`
 * 对非 HttpData 类型不做信封拆包。详见 spec.md §6（GetTipsStyleConfig 行）。
 */
export function appEnvelope(data: unknown): {code: number; data: unknown; msg: string} {
  return {code: 200, data, msg: "请求成功"};
}
