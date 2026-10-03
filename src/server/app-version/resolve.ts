/**
 * Version-gate resolution (spec §6.3 / §6.4, ADR-0002 / ADR-0005 / ADR-0008).
 *
 * `resolveMinVersionForRequest` answers one question for one request: *what is
 * the minimum `versionCode` this caller must be on, and is falling below it a
 * hard block?* It layers grayscale rules over the global floor:
 *
 *   device (exact) > user (exact) > percent (hash) > all
 *   floor = max(matched rules, ext_app_version.min_version_code)
 *
 * Two semantics worth naming (ADR-0008):
 *  - a violation of the **global floor** is always a hard block (`force = true`),
 *    even if a grayscale rule with `force = 0` also matched — the floor is not
 *    negotiable;
 *  - a grayscale rule *above* the floor may be soft (`force = 0`), i.e. "please
 *    update" rather than "you must update".
 *
 * The version gate is **not a security boundary**: a client can forge a high
 * `app-version` and bypass 426. Real security is the login credential + RBAC.
 */

import {readAppVersionConfig, readRolloutRules} from "./config";

/** Integer comparison, normalised to -1 / 0 / 1 (ADR-0002: no dotted compare). */
export function compareVersionCode(a: number, b: number): number {
  const left = Number.isFinite(a) ? a : 0;
  const right = Number.isFinite(b) ? b : 0;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Parse the `app-version` header into an integer `versionCode`.
 *
 * Returns `null` for a missing, empty, signed, or non-integer value — the gate
 * treats `null` as "below the floor" so an old client that does not send the
 * header (or an attacker stripping it) cannot slip past the force-upgrade
 * (ADR-0005).
 */
export function parseAppVersionCode(header: string | null): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(value) ? value : null;
}

/** Deterministic 0..99 bucket for a device id (FNV-1a 32-bit, backend-only). */
export function hashDevicePercent(deviceId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < deviceId.length; i++) {
    hash ^= deviceId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
}

export interface ResolvedMinVersion {
  /** The effective floor for this request. */
  minVersionCode: number;
  /** `true` when falling below the floor is a hard block (426, not closable). */
  force: boolean;
}

export interface VersionGateContext {
  userId?: string | null;
  deviceId?: string | null;
}

/**
 * Resolve the effective floor + force flag for one request.
 *
 * `userId` / `deviceId` may be absent (the MVP pre-auth gate only knows the
 * global floor); device/user/percent rules are then skipped.
 *
 * ⚠️ **Only hard requirements contribute to `minVersionCode`.** A matched rule
 * with `force = 0` is a *soft prompt*: it must not raise the floor, because the
 * floor is what the content gate 426s on — letting a soft rule raise it would
 * hard-block content for exactly the clients the rule only meant to nudge
 * (ADR-0008 §5: 软提示仅适用于地板之上的灰度). Soft rules are therefore invisible
 * here; they are reported through `/api/app/version`'s caller-aware `force`
 * (see `src/pages/api/app/version.ts`).
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

  // The global floor is hard by definition; a grayscale rule is hard only when
  // it says so (`force = 1`).
  const hardRuleFloor = matched.reduce(
    (max, rule) => (rule.force ? Math.max(max, rule.minVersionCode) : max),
    0,
  );
  const minVersionCode = Math.max(hardRuleFloor, globalFloor);
  if (minVersionCode <= 0) return {force: false, minVersionCode: 0};

  // A non-zero hard floor is a hard block by construction.
  return {force: true, minVersionCode};
}
