/**
 * 设备管理 + 版本升级特性的跨端 DTO。
 *
 * 这些形状跨越服务端/客户端边界——AJAX 处理器负责序列化，管理后台 React 组件负责反序列化——
 * 所以统一放在 `src/shared/`（两端都可导入的运行时中立层），而不是各写一份然后各自漂移
 * （AGENTS.md「源码架构」）。
 *
 * 运行时中立是刻意的：不依赖 D1、不依赖 `cloudflare:workers`、不碰 DOM。
 */

/** 设备行状态：与 `ext_user_devices.status` 的取值一致（票据 03）。 */
export type AdminDeviceStatus = "active" | "revoked";

/** 设备总览（`/admin/devices/`）的一行，跨全部账号。 */
export interface AdminDeviceRow {
  deviceId: string;
  userId: string;
  username: string | null;
  email: string | null;
  status: AdminDeviceStatus;
  lastSeenAt: string | null;
  createdAt: string | null;
}

/** 版本配置单行（`ext_app_version`，`id = 1`）。 */
export interface AppVersionConfig {
  latestVersionCode: number;
  latestVersionName: string;
  minVersionCode: number;
  downloadUrl: string;
  md5: string;
  updateLog: string;
  updatedAt: string | null;
}

/**
 * 单行的缺省值：管理后台表单的初始状态用。
 * 注意**不是**服务端的兜底——服务端读不到行会直接抛错（配置损坏必须暴露，不能伪装成"未配置"）。
 */
export const DEFAULT_APP_VERSION_CONFIG: AppVersionConfig = {
  downloadUrl: "",
  latestVersionCode: 0,
  latestVersionName: "",
  md5: "",
  minVersionCode: 0,
  updateLog: "",
  updatedAt: null,
};

/** 灰度规则的作用域（`ext_app_rollout.scope`），唯一事实来源。 */
export const APP_ROLLOUT_SCOPES = ["all", "user", "device", "percent"] as const;

export type AppRolloutScope = (typeof APP_ROLLOUT_SCOPES)[number];

/** scope 取值是否合法——服务端校验、前端下拉与标签映射共用同一份判定。 */
export function isRolloutScope(value: unknown): value is AppRolloutScope {
  return typeof value === "string"
    && (APP_ROLLOUT_SCOPES as readonly string[]).includes(value);
}

/**
 * 按 scope 归一化并校验 `target`。
 *
 * 服务端保存与前端表单共用，避免两处各写一遍规则而漂移：
 * - `all`：不需要 target，一律归 `null`；
 * - `percent`：0–100 的整数百分比（不含 `+5`、` 5 `、`1000` 这类写法）；
 * - `user` / `device`：非空的 userId / deviceId。
 */
export function normalizeRolloutTarget(
  scope: AppRolloutScope,
  target: unknown,
): {ok: true; value: string | null} | {ok: false} {
  if (scope === "all") {
    return {ok: true, value: null};
  }
  const trimmed = typeof target === "string" ? target.trim() : "";
  if (trimmed === "") {
    return {ok: false};
  }
  if (scope === "percent") {
    if (!/^\d{1,3}$/.test(trimmed)) {
      return {ok: false};
    }
    const percent = Number.parseInt(trimmed, 10);
    return percent <= 100 ? {ok: true, value: String(percent)} : {ok: false};
  }
  return {ok: true, value: trimmed};
}

/** 一条灰度规则（`ext_app_rollout`）。 */
export interface AppRolloutRule {
  id: number;
  scope: AppRolloutScope;
  target: string | null;
  minVersionCode: number;
  force: boolean;
}

/**
 * `POST /ajax/app-versions/save` 的请求体：两半都可单独提交，
 * 这样后台能把「版本表单」和「灰度表格」分开保存。
 */
export interface AppVersionSavePayload {
  config?: Partial<AppVersionConfig>;
  rules?: Array<Partial<AppRolloutRule>>;
}
