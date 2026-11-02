/**
 * 注册来源（分组）的形状、默认值与校验——浏览器与服务端共用。
 *
 * 来源列表存 `settings` 的 `signup_sources`（`[{value, label}]`），后台可在
 * 「新建分组」弹层里增删改名。校验必须两端同一份：客户端的即时预检与端点的
 * 保存闸门各写一遍，规则迟早分叉。
 *
 * 放 `shared/` 的原因与 `AdminAccountColumns` 相同：`UsersApp` 是浏览器代码，
 * 不能 import `@/server/*`。
 */

export interface SignupSourceOption {
  value: string;
  label: string;
}

/**
 * 建号链路写死在 SQL 里的三个来源，不允许从列表里删除。
 *
 * 它们不是"默认分组"，而是三条建号路径写下的字面量：安装引导/后台建号写
 * `admin`、邮箱注册写 `email`、QQ 首登写 `qq`。删掉其中一个，下一次注册就会
 * 写进一个不在列表里的值——那正是「未知来源」的来源。显示名可以改，value 不能减。
 */
export const BUILTIN_SIGNUP_SOURCES: readonly string[] = ["admin", "email", "qq"];

/** 来源 value 规则：小写字母开头，后接小写字母 / 数字 / 下划线，最长 32 位。 */
export const SIGNUP_SOURCE_VALUE_PATTERN = /^[a-z][a-z0-9_]{0,31}$/u;

/**
 * 种子默认值：`settings` 里没有配置时的回落，也是新部署的第一份列表。
 *
 * 前三条对应建号路径（见 {@link BUILTIN_SIGNUP_SOURCES}）。`back` 是"当前部署
 * 实际存在"的来源——最初由手工 SQL 写入，0169 把它登记成了正式分组；把它放进
 * 默认值，是为了让「没有任何配置行」的库打开用户页时看到的列表与实际分组一致，
 * 而不是少一行。它**不在**内建集合里，没人用时可以删。
 */
export const DEFAULT_SIGNUP_SOURCES: readonly SignupSourceOption[] = [
  {value: "admin", label: "管理员"},
  {value: "email", label: "邮箱注册"},
  {value: "qq", label: "QQ 登录"},
  {value: "back", label: "后台创建"},
];

/**
 * 「已封禁账号」分组的固定键。
 *
 * 它**不是**一个注册来源：成员由 `auth_user.banned` 实时过滤出来，账号的
 * `signup_source` 永远不会等于它。因此它不进 `signup_sources` 配置——那一列的
 * 取值域必须与 `auth_user.signup_source` 一致，混进一个布尔视图会让「来源」
 * 和「状态」两个概念在同一份列表里打架。
 *
 * 左栏固定追加它、不可改名不可删除；封禁 / 解封后成员立刻变化，正是需求里
 * 「封禁即自动标记到已封禁账号」的实现方式。
 */
export const BANNED_GROUP_VALUE = "__banned__";

export function isValidSignupSourceOption(value: unknown): value is SignupSourceOption {
  if (!value || typeof value !== "object") return false;
  const option = value as Record<string, unknown>;
  if (typeof option.label !== "string" || option.label.trim().length === 0) return false;
  return typeof option.value === "string" && isValidSignupSourceValue(option.value);
}

/**
 * 一个字符串能不能当来源 `value`。
 *
 * 「已封禁账号」是系统视图，不能借任何路径混进来源列表——否则那一列的取值域会
 * 多出一个账号永远不会拥有的值。读路径补全、迁移登记、表单校验都用这一条。
 */
export function isValidSignupSourceValue(value: string): boolean {
  return value !== BANNED_GROUP_VALUE && SIGNUP_SOURCE_VALUE_PATTERN.test(value);
}

/** 整份列表的校验：非空、逐项合法、value 不重复。 */
export function validateSignupSources(value: unknown): value is SignupSourceOption[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const seen = new Set<string>();
  for (const item of value) {
    if (!isValidSignupSourceOption(item)) return false;
    if (seen.has(item.value)) return false;
    seen.add(item.value);
  }
  return true;
}

export function hasSignupSource(
  sources: readonly SignupSourceOption[],
  value: string,
): boolean {
  return sources.some((option) => option.value === value);
}

/**
 * 把「这次保存会删掉的来源」分成两类，调用方按类型给出不同的状态码与文案。
 *
 * 输入是 `removedSources` 的结果——分开取是因为调用方要先用同一份 `removed`
 * 去数账号；让这个函数自己再算一遍，两处迟早错开。
 */
export function classifyRemovedSources(
  removed: readonly string[],
  usage: Readonly<Record<string, number>>,
): {builtinRemoved: string[]; inUse: {count: number; value: string}[]} {
  return {
    builtinRemoved: removed.filter((value) => BUILTIN_SIGNUP_SOURCES.includes(value)),
    inUse: removed
      .filter((value) => (usage[value] ?? 0) > 0)
      .map((value) => ({count: usage[value] ?? 0, value})),
  };
}

/** 这次保存会删掉哪些来源。计数与闸门共用这一份，免得两处各算一遍。 */
export function removedSources(
  current: readonly SignupSourceOption[],
  next: readonly SignupSourceOption[],
): string[] {
  return current
    .map((option) => option.value)
    .filter((value) => !hasSignupSource(next, value));
}

/**
 * 一个账号在不在某个分组里。
 *
 * 来源分组**排除已封禁账号**：封禁之后它只出现在「已封禁账号」里，一个账号
 * 在同一时刻只属于一个分组（「全部用户」根不受影响，仍列出全部）。
 */
export function matchesSignupCategory(
  account: {banned: boolean; signupSource: string},
  category: string,
): boolean {
  if (category === BANNED_GROUP_VALUE) return account.banned;
  return !account.banned && account.signupSource === category;
}
