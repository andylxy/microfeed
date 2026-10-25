/**
 * App 登录方式配置的类型与归一（ADR-0050；运行时中立，server 与 admin 组件共用）。
 *
 * 存储是 `settings` 表 category=`app_login_methods` 的单行 JSON（方案 §3）；
 * IO（读 / read-through 缓存 / 保存）在 `src/server/app/login/config.ts`，
 * 本模块只放无运行时依赖的部分：类型、默认值、字段归一。
 */

/** 六个开关键。`loginEnabled` 是总闸（关掉 = App 登录功能整体停用）；登录方式是开放集：加一种 = 加一个键，零迁移（ADR-0050 D1）。 */
export const LOGIN_METHOD_TOGGLE_KEYS = [
  "loginEnabled",
  "accountPasswordEnabled",
  "smsEnabled",
  "wechatEnabled",
  "qqEnabled",
  "captchaEnabled",
] as const;

export type LoginMethodToggleKey = (typeof LOGIN_METHOD_TOGGLE_KEYS)[number];

export interface LoginMethodsConfig {
  /** 登录功能总闸：false 时 `appLogin` 不做任何检查直接返回「功能开发中」，App 登录入口不放行。 */
  loginEnabled: boolean;
  accountPasswordEnabled: boolean;
  smsEnabled: boolean;
  wechatEnabled: boolean;
  qqEnabled: boolean;
  captchaEnabled: boolean;
  /** 服务端保存时刻；`settings.updated_at` 列只在 INSERT 触发，不可信。 */
  updatedAtMs: number;
  updatedBy: string | null;
}

/**
 * SSOT 单一默认源：字段缺失兜底、整行缺失兜底都取它。`updatedAtMs: 0` 表示
 * 「从未保存过」，App 端只作可观测字段，不参与逻辑。缺行兜底 = 当前既有行为
 * （登录可用、要验证码、受理账号密码）——与「未配置实例静默不验码」的安全回退
 * 方向相反（ADR-0050 D2）。
 */
export const DEFAULT_LOGIN_METHODS: LoginMethodsConfig = {
  loginEnabled: true,
  accountPasswordEnabled: true,
  smsEnabled: false,
  wechatEnabled: false,
  qqEnabled: false,
  captchaEnabled: true,
  updatedAtMs: 0,
  updatedBy: null,
};

/** 保存请求允许携带的字段（版本与操作者由服务端置值，patch 不含）。 */
export type LoginMethodsPatch = Partial<Record<LoginMethodToggleKey, unknown>>;

export type LoginMethodsWriteResult =
  | {ok: true}
  | {ok: false; reason: "invalidConfig"};

/**
 * 归一：布尔字段 true/false 之外（缺失、坏类型）补默认值；版本与操作者字段
 * 坏值归零 / 置 null。幂等——对已归一的值再跑一遍结果不变，缓存命中路径
 * 与 D1 路径共用这一套校验。
 */
export function parseLoginMethodsConfig(raw: unknown): LoginMethodsConfig {
  const source = (raw !== null && typeof raw === "object"
    ? raw
    : {}) as Record<string, unknown>;
  const config: LoginMethodsConfig = {
    loginEnabled: boolField(source, "loginEnabled"),
    accountPasswordEnabled: boolField(source, "accountPasswordEnabled"),
    smsEnabled: boolField(source, "smsEnabled"),
    wechatEnabled: boolField(source, "wechatEnabled"),
    qqEnabled: boolField(source, "qqEnabled"),
    captchaEnabled: boolField(source, "captchaEnabled"),
    updatedAtMs: DEFAULT_LOGIN_METHODS.updatedAtMs,
    updatedBy: DEFAULT_LOGIN_METHODS.updatedBy,
  };
  if (typeof source.updatedAtMs === "number" && Number.isFinite(source.updatedAtMs)) {
    config.updatedAtMs = source.updatedAtMs;
  }
  if (typeof source.updatedBy === "string" && source.updatedBy) {
    config.updatedBy = source.updatedBy;
  }
  return config;
}

function boolField(
  source: Record<string, unknown>,
  key: LoginMethodToggleKey,
): boolean {
  const value = source[key];
  if (value === true || value === false) return value;
  return DEFAULT_LOGIN_METHODS[key];
}
