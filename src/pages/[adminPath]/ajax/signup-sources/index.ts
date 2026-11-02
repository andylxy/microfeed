/**
 * 注册来源（分组）配置写入（`PUT /admin/ajax/signup-sources`）。
 *
 * 只有 `PUT`：列表由用户页 SSR 直读（`getSignupSources`），客户端只在「管理
 * 分组」弹层保存时提交整份数组。没有需要单独 GET 的调用方，就不开这个端点。
 *
 * 策略与闸门在 `src/server/admin/signup-sources-handler.ts`。
 */
export {updateAdminSignupSources as PUT} from "@/server/admin/signup-sources-handler";
