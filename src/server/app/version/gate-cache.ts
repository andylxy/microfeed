/**
 * 版本门输入的共享缓存（方案 4.5）。
 *
 * 每个 App 请求都要读 `ext_app_version` 单行 + `ext_app_rollout` 全表来解析地板，
 * 而这两张表只在后台保存时变化。这里把 `{config, rules}` 一起放进 `cachedJson`，
 * 桶 `version` 取控制项的 `rule` 档（默认 7200 秒）——版本地板允许的最长陈旧时间
 * 就是这一档。
 *
 * 键名与清理放在本文件，`resolve.ts` 只负责组装输入、`config.ts` 只负责保存后清理，
 * 两边共用同一个常量，不会各拼一遍而清错键。
 */

import {cachedJson, deleteCachedJson} from "@/server/cache/app-cache";
import type {VersionGateInputs} from "./resolve";

export const VERSION_GATE_CACHE = "version-gate";

export function cachedVersionGateInputs(
  load: () => Promise<VersionGateInputs>,
): Promise<VersionGateInputs> {
  return cachedJson<VersionGateInputs>(
    VERSION_GATE_CACHE,
    load,
    "version",
  );
}

/** 配置或灰度规则保存成功后清条目；下一次请求回源新值。 */
export async function purgeVersionGateCache(): Promise<void> {
  await deleteCachedJson(VERSION_GATE_CACHE);
}
