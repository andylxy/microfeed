/**
 * 旧后端统一响应包装（golden 对齐 2026-09-28）：
 * 旧 .NET 框架把每个 Json(...) 返回包成 `{code, data, msg}`（HttpData 形状，
 * App 的 RequestHandler 按 code 判定成功失败），字段名小驼峰。
 *
 * App 数据端点返回 HttpData 形状时用此包装：`/api/AppBookRequest/*` 14 个路由中
 * 10 个经此 helper 包装（GetNav / GetBookChapter / GetAllZhongYao / GetAliaZhongYao
 * 四个直接返回原始结构，不走包装）。`GetTipsStyleConfig` 返回 `{styles, version}`，
 * 也走此包装（见该路由）。
 */
export function appEnvelope(data: unknown): {code: number; data: unknown; msg: string} {
  return {code: 200, data, msg: "请求成功"};
}
