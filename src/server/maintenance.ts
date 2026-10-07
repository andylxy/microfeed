import {runWebhookScheduledMaintenance} from "@/server/webhooks/events";

/**
 * 有保留期的审计 / 日志表各留多久。
 *
 * `ext_content_audit` 与 `ext_rbac_audit` 不在这里——它们是只增不改的审计链
 * （架构测试禁止 `DELETE` / 改写），清理靠运维侧归档。
 */
export const LOG_RETENTION_DAYS = {
  /** API 访问日志（`ext_api_access_log`）：应用层只写不读，供人工审计。 */
  apiAccess: 90,
  /** App 登录日志（`ext_app_login_log`）：按设备 × 自然日累计。 */
  appLogin: 180,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 清理有保留期的审计 / 日志表，外加过期会话。
 *
 * `auth_session.expiresAt`、`ext_app_login_log.login_at` 都是 ISO 字符串，按字典序
 * 比较等价于按时间比较；`ext_api_access_log.created_at_ms` 是毫秒数。
 */
export async function pruneRetainedLogs(
  db: D1Database,
  now: number = Date.now(),
): Promise<void> {
  const apiCutoff = now - LOG_RETENTION_DAYS.apiAccess * DAY_MS;
  const loginCutoff = new Date(
    now - LOG_RETENTION_DAYS.appLogin * DAY_MS,
  ).toISOString();
  await db.batch([
    db.prepare("DELETE FROM auth_session WHERE expiresAt <= ?").bind(
      new Date(now).toISOString(),
    ),
    db.prepare(
      "DELETE FROM ext_api_access_log WHERE created_at_ms < ?",
    ).bind(apiCutoff),
    db.prepare(
      "DELETE FROM ext_app_login_log WHERE login_at < ?",
    ).bind(loginCutoff),
  ]);
}

/** 每天 UTC 0 点跑一次重活（与 webhook 的每日清理同一判定）。 */
export function isDailyMaintenanceDue(scheduledTime: number): boolean {
  return new Date(scheduledTime).getUTCHours() === 0;
}

/**
 * Cron 入口。
 *
 * 保留清理与 webhook 无关，必须**先跑**：此前的 `scheduled` 在没配 webhook 队列时
 * 直接 return，实例上其它表的清理永远不执行。
 */
export async function runScheduledMaintenance(
  runtimeEnv: Env,
  scheduledTime: number,
): Promise<void> {
  if (isDailyMaintenanceDue(scheduledTime)) {
    await pruneRetainedLogs(runtimeEnv.FEED_DB);
  }
  if (runtimeEnv.WEBHOOK_QUEUE) {
    await runWebhookScheduledMaintenance(runtimeEnv, scheduledTime);
  }
}
