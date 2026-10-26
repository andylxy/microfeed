// 后台列表搜索：items 直查（ADR-0051 D2）。
//
// 站点全文搜索的存储层（site_search 表族 + 9 条同步触发器）随迁移 0151 退役，
// 公开站的搜索端点也一并下线。后台列表顶部的搜索框仍要能用，这里改成直接查
// items：状态集合先收窄，圈内对 `json_extract(data,'$.title')` 逐个查询词做
// LIKE 子串匹配（多个词之间取 AND），再按既有排序列排序并截断。
//
// 读代价（2026-10-26 本地库实测，items = 9,506 行）：
//   EXPLAIN QUERY PLAN = `SCAN items USING INDEX items_updated_at`，无 TEMP B-TREE。
//   撞够 LIMIT 条即停 —— 实测取到第 5 条用 5.6 ms（"%黄芪%"）；一个字都命不中的
//   词才扫完整条索引，实测 29.9 ms，上界 = items 全表 9,506 行读取（占每日
//   5,000,000 行读额度的 0.19%）。后台是低频操作，可接受这个上界。
//
// 状态名到数字的映射在 SQL 外面算好，`status IN (?, ?, ?)` 由调用方传进来的状态
// 集合决定；写成 `status != 3` 会把「除了已删除之外」的语义固化进 SQL。
//
// `INDEXED BY items_updated_at` 是必须的：不带它，SQLite 会挑 items_status 把
// 每个状态的匹配行先装进临时 B 树再排序（`SEARCH items USING INDEX items_status`
// + `USE TEMP B-TREE FOR ORDER BY`），每次都按全表行数物化一遍；带上它则转成沿
// (updated_at, id) 倒序流式读取、撞够 LIMIT 即停。
import {
  ITEM_STATUSES_DICT,
  ITEM_STATUSES_STRINGS_DICT,
} from "@/shared/Constants";
import {
  parseItemSearchQuery,
  type ItemSearchClause,
  type ItemSearchStatus,
} from "@/shared/ItemSearch";
import {msToRFC3339, rfc3399ToMs} from "@/shared/TimeUtils";

// `\` 作 LIKE 的转义符：用户输入里的 `%` `_` 不再被当成通配符。
const LIKE_ESCAPE = "\\";
const EPOCH_ISO = new Date(0).toISOString();

export interface AdminSearchSegment {
  matched: boolean;
  text: string;
}

// 形状按 `getAdminItemSearch` 实际消费的字段给，端点侧映射因此不用改。
export interface AdminSearchItem {
  date_modified: string;
  date_published: string;
  highlights: {title: AdminSearchSegment[]};
  id: string;
  match_type: "exact";
  status: ItemSearchStatus;
  title: string;
}

interface AdminSearchRow {
  id: string;
  pub_date: string | null;
  status: number;
  title: string;
  updated_at: string;
}

const ADMIN_SEARCH_SELECT = `
  id,
  status,
  COALESCE(json_extract(data, '$.title'), '') AS title,
  pub_date,
  updated_at`;

/**
 * 每个词都转成 `%词%` 子串模式（引号短语与普通词同一口径——引号只在切词阶段
 * 阻止短语被空格劈开）。
 * `\` 与 LIKE 通配符先转义，用户输入的 `%` `_` 因此只代表字面字符。
 */
function clausePattern(clause: ItemSearchClause): string {
  const escaped = clause.text.replace(
    /[\\%_]/gu,
    (character) => `${LIKE_ESCAPE}${character}`,
  );
  return `%${escaped}%`;
}

function milliseconds(value: string | null): number {
  if (!value) return 0;
  const parsed = rfc3399ToMs(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoAtTime(value: number): string {
  return value > 0 ? msToRFC3339(value) : EPOCH_ISO;
}

function statusName(value: number): ItemSearchStatus {
  const name = ITEM_STATUSES_DICT[value]?.name;
  return name === "published" || name === "unlisted" ? name : "unpublished";
}

/**
 * 把命中的子串标成一组 {matched, text} 切片给后台下拉列表加亮。
 * SQLite 的 LIKE 对 ASCII 大小写不敏感，这里照同一口径再做一次不敏感匹配，
 * 免得出现「列表显示命中、加亮却划不出来」的自相矛盾。多个词的命中区间可能
 * 交叠，先合并再切分，保证切片顺序与原文一致且不出现零长度片段。
 */
function titleSegments(
  title: string,
  clauses: readonly ItemSearchClause[],
): AdminSearchSegment[] {
  const haystack = title.toLocaleLowerCase("und");
  const ranges: Array<[number, number]> = [];
  for (const clause of clauses) {
    const needle = clause.text.toLocaleLowerCase("und");
    if (needle.length === 0) continue;
    for (let index = haystack.indexOf(needle);
      index !== -1;
      index = haystack.indexOf(needle, index + needle.length)) {
      ranges.push([index, index + needle.length]);
    }
  }
  if (ranges.length === 0) return [{matched: false, text: title}];
  ranges.sort((left, right) => left[0] - right[0]);
  const segments: AdminSearchSegment[] = [];
  let consumed = 0;
  for (const [start, end] of ranges) {
    if (start < consumed) continue;
    if (start > consumed) {
      segments.push({matched: false, text: title.slice(consumed, start)});
    }
    segments.push({matched: true, text: title.slice(start, end)});
    consumed = end;
  }
  if (consumed < title.length) {
    segments.push({matched: false, text: title.slice(consumed)});
  }
  return segments.length > 0 ? segments : [{matched: false, text: title}];
}

function plainRow(row: AdminSearchRow): AdminSearchItem {
  return {
    date_modified: isoAtTime(milliseconds(row.updated_at)),
    date_published: isoAtTime(milliseconds(row.pub_date)),
    highlights: {title: [{matched: false, text: row.title}]},
    id: row.id,
    match_type: "exact",
    status: statusName(row.status),
    title: row.title,
  };
}

export interface AdminItemSearchOptions {
  limit: number;
  query: string;
  statuses: ItemSearchStatus[];
}

export async function searchAdminItems(
  database: D1Database,
  {limit, query, statuses}: AdminItemSearchOptions,
): Promise<AdminSearchItem[]> {
  const clauses = parseItemSearchQuery(query);
  if (clauses.length === 0) return [];
  const statusValues = statuses.map((status) =>
    ITEM_STATUSES_STRINGS_DICT[status]
  );
  const likeClauses = clauses.map(() =>
    `json_extract(data, '$.title') LIKE ? ESCAPE '${LIKE_ESCAPE}'`
  ).join(" AND ");
  const response = await database.prepare(`
    SELECT ${ADMIN_SEARCH_SELECT}
    FROM items INDEXED BY items_updated_at
    WHERE status IN (${statusValues.map(() => "?").join(", ")})
      AND ${likeClauses}
    ORDER BY updated_at DESC, id DESC
    LIMIT ?
  `).bind(
    ...statusValues,
    ...clauses.map(clausePattern),
    limit,
  ).all<AdminSearchRow & Record<string, unknown>>();
  return (response.results ?? []).map((row) => {
    const item = plainRow(row);
    return {
      ...item,
      highlights: {title: titleSegments(item.title, clauses)},
    };
  });
}

/** 搜索框空着时下拉显示最近改动的条目。 */
export async function latestAdminItems(
  database: D1Database,
  statuses: ItemSearchStatus[],
  limit: number,
): Promise<AdminSearchItem[]> {
  const statusValues = statuses.map((status) =>
    ITEM_STATUSES_STRINGS_DICT[status]
  );
  const response = await database.prepare(`
    SELECT ${ADMIN_SEARCH_SELECT}
    FROM items INDEXED BY items_updated_at
    WHERE status IN (${statusValues.map(() => "?").join(", ")})
    ORDER BY updated_at DESC, id DESC
    LIMIT ?
  `).bind(...statusValues, limit).all<AdminSearchRow & Record<string, unknown>>();
  return (response.results ?? []).map((row) => plainRow(row));
}
