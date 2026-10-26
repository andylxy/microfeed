/**
 * `settings` 表的单行读写，与 `FeedDb` 的实例方法同源。
 *
 * 抽成自由函数是为了让只需要一个开关的调用方（缓存控制项）不必构造 `FeedDb`
 * 实例——那个类会连带引入媒体存储与主题模块。`FeedDb.getSettingsCategory` /
 * `setSettingsCategory` 委托到这里，SQL 因此仍然只有一处。
 */

/** 按 category 主键点查一行，返回解析后的 JSON；缺行与坏 JSON 一律 null。 */
export async function readSettingsCategory<T>(
  db: D1Database,
  category: string,
): Promise<T | null> {
  const row = await db.prepare(
    "SELECT data FROM settings WHERE category = ? LIMIT 1",
  ).bind(category).first() as Record<string, unknown> | null;
  if (!row) return null;
  try {
    return JSON.parse(String(row["data"] ?? "")) as T;
  } catch {
    return null;
  }
}

/**
 * Upsert 一个 settings 行。`data` 是已经序列化好的 JSON 文本。
 * `updated_at` 在冲突时刷新，仅作观测：SQLite 的 DEFAULT 只在 INSERT 时触发，
 * 需要可审计时间戳的调用方把时间写在 `data` 里面。
 */
export async function writeSettingsCategory(
  db: D1Database,
  category: string,
  data: string,
): Promise<void> {
  await db.prepare(
    "INSERT INTO settings (category, data) VALUES (?, ?) " +
      "ON CONFLICT(category) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP",
  ).bind(category, data).run();
}
