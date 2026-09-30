# ADR-02 — App 端点契约（形状来源、两处反直觉特例、golden 比对策略）

- 状态：已采纳（2026-09-28）
- 关联：spec.md §6 / §6.0 / §6.2；issues 15、16
- 上游：旧 .NET 后端 `AppBookRequest` 命名空间一组匿名 HTTP 端点

## 背景（Context）

Android App 直接消费旧后端一组端点（`GetNav`/`GetBookChapter`/`GetChapterContent`/
`GetBookIdFang`/`GetAllZhongYao`/`GetAliaZhongYao`/`GetAllMingCi`/`GetTipsStyleConfig`/
`login`/`replaceToken`/`GetProjectInfo`/`GetLoginInfo`/`getAboutInfo`/`getPicCaptcha`）。
迁移到 microfeed 后这组端点必须**逐字节兼容**，否则 App 解析失败。

## 决策（Decision）

14 个端点挂在 `/api/AppBookRequest/` 下，中间件对该命名空间**匿名放行**（对应旧后端
AllowAnonymous）。响应形状严格对齐旧后端（经 golden 比对确认）：

- **信封**：统一 `appEnvelope` 包成 `{ code: 200, data, msg: "请求成功" }`——旧 .NET 框架
  把每个 `Json(...)` 包成 `HttpData` 形状，App 的 `RequestHandler` 按 `code` 判定成败。
- **字段名**：全小驼峰（实测，非臆测）。
- **数值字段**：旧后端序列化为**字符串**；空值发 **null**。
- **排序**：按源主键序返回（导入时把源编号存进 `_microfeed.no`，查询 `ORDER BY`）。

### 两处反直觉特例（务必记住）

1. **`GetTipsStyleConfig` 不包信封**，直接返回裸 `{ styles: [...] }`。原因：App 的
   `StyleConfigApiBean` 反序列化**顶层** `styles` 字段，且 `RequestHandler` 只特判 `HttpData`、
   对该端点不拆信封——包了信封反而让 App 拿到 `null`。该端点旧后端本就不存在（App 本地兜底），
   属新增，无 golden 可比，但契约由 App 源码锁定。
2. **`GetBookIdFang(bookId)` 按 `_microfeed.sourceBookId` 过滤，不是按频道 id**。App 传入的是
   源典籍 id（int64 镜像值），而方剂条目的 `book_id` 指向容器频道（方剂），二者不同。

## golden 比对策略（契约对齐的唯一仲裁）

- `scripts` 之外另起 `.scratch/tcm-import/golden/` 工具链：`capture.mts` 抓取旧后端
  （192.168.2.158:9991）8 个内容端点的真实响应，`compare.mts` 与新 dev 逐项字段对比，
  产出 `report.json`。
- 判定标准：**8 端点零 MISMATCH** 才算契约对齐（已达成）。已知差异分类为
  known-id / known-merge / known-adaptation / known-signature-removed / known-order /
  known-data-drift，均非缺陷。
- `tests/unit/tcm-golden.test.ts` 锁该契约（依赖外部 golden 文件，CI 跳过）；
  `tests/worker/tcm-app-routes.test.ts` 直击 14 个路由处理器，锁信封形状，CI 必跑。
