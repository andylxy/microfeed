/**
 * 版本门解析（spec §6.3 / §6.4，ADR-0002 / ADR-0005 / ADR-0008）。
 *
 * `resolveMinVersionForRequest` 为一个请求回答一个问题：*这个调用方至少得在哪个
 * `versionCode` 上，低于它算不算硬阻？* 它把灰度规则叠加在全局地板之上：
 *
 *   device (exact) > user (exact) > percent (hash) > all
 *   floor = max(matched rules WHERE force = 1, ext_app_version.min_version_code)
 *
 * 关键语义（ADR-0008 / ADR-0009）：地板 = max(全局 min_version_code, 命中且 force=1 的规则)，
 * `force=0` 的软规则只提示、不抬地板。
 *
 * 本函数**只回答"地板是多少"**，不回答"要不要强制"：内容门按地板判 426；
 * 而 `/api/app/version` 的 `force` 是**面向调用方**的另一套判定（还要看请求头是否缺版本），
 * 由那个端点自己算。两者刻意不合并——合并过就会出现"软提示被硬化成不可关闭"。
 *
 * 版本门**不是安全边界**：客户端可以伪造一个很高的 `app-version` 来绕过 426。
 * 真正的安全边界是登录凭证 + RBAC。
 */

import {readAppVersionConfig, readRolloutRules} from "./config";

/** 整数比较，归一化到 -1 / 0 / 1（ADR-0002：不做点分号式比较）。 */
export function compareVersionCode(a: number, b: number): number {
  const left = Number.isFinite(a) ? a : 0;
  const right = Number.isFinite(b) ? b : 0;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * 把 `app-version` 请求头解析成整数 `versionCode`。
 *
 * 缺失、空、带符号或非整数一律返回 `null`。`null` 的含义是"客户端没给出可用的东西"，
 * 版本门会把它当作*低于地板*——但**仅当确实配置了地板时**（`minVersionCode > 0`）。
 * 没有地板时版本门完全关闭（票据 20），所以没带请求头的客户端不会因为版本旧而受罚；
 * 强制升级是靠*抬高地板*做到的（ADR-0005 / ADR-0008）。
 */
export function parseAppVersionCode(header: string | null): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(value) ? value : null;
}

/** 设备 id 的确定性 0..99 分桶（FNV-1a 32-bit，仅后端使用）。 */
export function hashDevicePercent(deviceId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < deviceId.length; i++) {
    hash ^= deviceId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
}

export interface ResolvedMinVersion {
  /** 该请求的最终地板：max(全局 min_version_code, 命中且 force=1 的规则)。 */
  minVersionCode: number;
}

export interface VersionGateContext {
  userId?: string | null;
  deviceId?: string | null;
}

/**
 * 解析单个请求的实际地板（只返回 `minVersionCode`，不含 `force`）。
 *
 * `userId` / `deviceId` 可以缺失（MVP 的 pre-auth 版本门只知道全局地板）；
 * 这时 device/user/percent 规则都会被跳过。
 *
 * ⚠️ **只有硬性要求才计入 `minVersionCode`。** 命中但 `force = 0` 的规则是*软提示*：
 * 它不能抬高地板，因为内容门正是按地板判 426 —— 让软规则去抬地板，等于对那些规则
 * 本来只想顺带提醒一下的客户端硬阻内容（ADR-0008 §5：软提示仅适用于地板之上的灰度）。
 * 所以软规则在这里是隐形的；它们通过 `/api/app/version` 那个面向调用方的 `force`
 * 来上报（见 `src/pages/api/app/version.ts`）。
 */
export async function resolveMinVersionForRequest(
  db: D1Database,
  context: VersionGateContext = {},
): Promise<ResolvedMinVersion> {
  const [config, rules] = await Promise.all([
    readAppVersionConfig(db),
    readRolloutRules(db),
  ]);
  const globalFloor = config.minVersionCode > 0 ? config.minVersionCode : 0;
  const userId = context.userId ?? null;
  const deviceId = context.deviceId ?? null;

  const matched = rules.filter((rule) => {
    switch (rule.scope) {
      case "device":
        return deviceId !== null && rule.target === deviceId;
      case "user":
        return userId !== null && rule.target === userId;
      case "percent":
        return deviceId !== null &&
          rule.target !== null &&
          hashDevicePercent(deviceId) < Number.parseInt(rule.target, 10);
      case "all":
        return true;
      default:
        return false;
    }
  });

  // 全局地板按定义就是硬的；灰度规则只有自己声明了（`force = 1`）才算硬。
  const hardRuleFloor = matched.reduce(
    (max, rule) => (rule.force ? Math.max(max, rule.minVersionCode) : max),
    0,
  );
  const minVersionCode = Math.max(hardRuleFloor, globalFloor);
  return {minVersionCode};
}
