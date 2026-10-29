/**
 * App 登录方式配置的类型与归一（ADR-0050；运行时中立，server 与 admin 组件共用）。
 *
 * 存储是 `settings` 表 category=`app_login_methods` 的单行 JSON（方案 §3）；
 * IO（读 / read-through 缓存 / 保存）在 `src/server/app/login/config.ts`，
 * 本模块只放无运行时依赖的部分：类型、默认值、字段归一。
 */

/** 七个开关键。`loginEnabled` 是总闸；登录方式是开放集：加一种 = 加一个键，零迁移（ADR-0050 D1）。
 * `emailRegisterEnabled` / `smsRegisterEnabled` 例外于「登录方式」语义——它们是**注册**
 * 开关（邮箱 + 验证码注册 / 手机号注册），复用同一份配置通道与后台开关 UI，
 * 避免为一个布尔再起一套 settings 类目。 */
export const LOGIN_METHOD_TOGGLE_KEYS = [
  "loginEnabled",
  "accountPasswordEnabled",
  "smsEnabled",
  "wechatEnabled",
  "qqEnabled",
  "captchaEnabled",
  "emailRegisterEnabled",
  "smsRegisterEnabled",
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
  /**
   * 邮箱注册开关（默认 false）：false 时 `code/get`（发码）与 `register`（建号）
   * 直接返回「邮箱注册暂未开放」，不发码、不建号。关掉它是停机手段，不是权限手段——
   * 已注册账号的登录不受影响。
   */
  emailRegisterEnabled: boolean;
  /**
   * 手机号注册开关（默认 true）：false 时 App 注册页不露手机号入口。
   *
   * <p>手机号注册是注册页的默认（原始）流程，默认放开；与 {@link emailRegisterEnabled}
   * 一样复用「登录方式」的配置通道与后台开关 UI。手机号注册的硬门在 App 端
   * （microfeed 尚未实现 `code/get` + `user/register` 的短信链路，提交会 404），
   * 后台此开关目前只控**显隐**，不控服务端行为。
   */
  smsRegisterEnabled: boolean;
  /** 服务端保存时刻；`settings.updated_at` 列只在 INSERT 触发，不可信。 */
  updatedAtMs: number;
  updatedBy: string | null;
}

/**
 * SSOT 单一默认源：字段缺失兜底、整行缺失兜底都取它。`updatedAtMs: 0` 表示
 * 「从未保存过」，App 端只作可观测字段，不参与逻辑。缺行兜底 = 当前既有行为
 * （登录可用、要验证码、受理账号密码）——与「未配置实例静默不验码」的安全回退
 * 方向相反（ADR-0050 D2）。
 *
 * `emailRegisterEnabled: false`：新功能默认关闭，需后台显式开启后 App 才放出行入口。
 */
export const DEFAULT_LOGIN_METHODS: LoginMethodsConfig = {
  loginEnabled: true,
  accountPasswordEnabled: true,
  smsEnabled: false,
  wechatEnabled: false,
  qqEnabled: false,
  captchaEnabled: true,
  emailRegisterEnabled: false,
  smsRegisterEnabled: true,
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
    emailRegisterEnabled: boolField(source, "emailRegisterEnabled"),
    smsRegisterEnabled: boolField(source, "smsRegisterEnabled"),
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
