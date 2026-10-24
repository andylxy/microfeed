// App 关于页内容（AboutInfo）读写层。
//
// 存储是专用表 `ext_app_about_info`（migration 0145）：name 主键即 App 端
// AboutActivity 的分发枚举（about_thks / about_manual / about_bookname /
// app_updata_log），text 为逐字字符串（App 自有 `$x{...}` 标记 + **真换行**
// 分行，非 Markdown），后台编辑器只作输入面板、内容原样存取（ADR-0029 存取约定）。
//
// ⚠️ 分行符是**真换行（LF）**，不是旧后端的 `|`：migration 0146 把存量 `|`
// 一次性转成 LF，App 端也同步去掉了 `split("|")`，实现「后端怎么存、App 就
// 怎么显示」。别再把 `|` 当分行符写回来。
//
// 保存口径：**整表同步**——upsert 提交里的每一行，并删除提交里没有的行。
// 槽位集合是封闭枚举（App 只认 4 个 name），整表同步让「删槽位」成为显式动作，
// 不会留下 App 永远不显示的幽灵行。

export interface AboutInfoEntry {
  name: string;
  text: string;
}

export type AboutInfoSaveResult =
  | {ok: true}
  | {ok: false; reason: "invalid"};

/** 单个槽位的校验：name 非空且 ≤80（与建表列宽一致），text 必须是字符串。 */
function entryValid(entry: unknown): entry is AboutInfoEntry {
  if (!entry || typeof entry !== "object") return false;
  const {name, text} = entry as {name?: unknown; text?: unknown};
  return typeof name === "string" &&
    name.trim().length > 0 &&
    name.length <= 80 &&
    typeof text === "string";
}

/** 全表读取。排序对齐 netcore 的入库顺序（about_thks → bookname → manual → updata_log）：
 *  此前 `ORDER BY name` 按字母序把 thks 排到第三，与 netcore 的「关于」页顺序不一致。
 *  表当前 4 行（name 主键），CASE 排序不增加 D1 读取行数；若新增关于行，需在此处补分支。
 *  ELSE 之后再用 name 兜底保证顺序稳定。同款排序见 src/server/tcm/config.ts 的
 *  getAppAboutInfo（App 端），两处需同步改。 */
export async function readAboutInfo(
  database: D1Database,
): Promise<AboutInfoEntry[]> {
  const result = await database.prepare(
    "SELECT name, text FROM ext_app_about_info ORDER BY CASE name " +
      "WHEN 'about_thks' THEN 1 WHEN 'about_bookname' THEN 2 " +
      "WHEN 'about_manual' THEN 3 WHEN 'app_updata_log' THEN 4 ELSE 99 END, name",
  ).all<{name: string; text: string}>();
  return (result.results ?? []).map((row) => ({name: row.name, text: row.text}));
}

/**
 * 整表同步：upsert 提交行 + 删除未提交行，同一 batch 原子生效。
 * `new Date().toISOString()` 写 updated_at（SQLite TIMESTAMP 列接受 ISO 文本，
 * 与 `FeedDb` 的 item 时间戳写法同款）。
 */
export async function saveAboutInfo(
  database: D1Database,
  entries: unknown,
): Promise<AboutInfoSaveResult> {
  if (!Array.isArray(entries)) return {ok: false, reason: "invalid"};
  for (const entry of entries) {
    if (!entryValid(entry)) return {ok: false, reason: "invalid"};
  }
  const normalized = (entries as AboutInfoEntry[]).map((entry) => ({
    name: entry.name,
    text: entry.text,
  }));
  const names = normalized.map((entry) => entry.name);
  // name 主键天然去重；重复提交同一 name 时保留最后一行（逐条覆盖写）。
  const unique = new Map<string, AboutInfoEntry>();
  for (const entry of normalized) {
    unique.set(entry.name, entry);
  }
  const now = new Date().toISOString();
  const statements = [
    ...[...unique.values()].map((entry) => database.prepare(
      "INSERT INTO ext_app_about_info (name, text, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(name) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at",
    ).bind(entry.name, entry.text, now)),
    // 整表同步：提交里没有的 name 删掉。names 为空时占位防 SQL 空 IN 报错。
    names.length > 0
      ? database.prepare(
          `DELETE FROM ext_app_about_info WHERE name NOT IN (${
            names.map(() => "?").join(", ")
          })`,
        ).bind(...names)
      : database.prepare("DELETE FROM ext_app_about_info"),
  ];
  await database.batch(statements);
  return {ok: true};
}
