/**
 * 标注层引用解析的唯一数据入口（ADR-0066 决策 6，规范 §4.3/4.4）。
 *
 * 方剂按书解析：`book_info.id → book_info.book_no → fang_yao.source_book_legacy_id`，
 * SQL 必须带 `source_book_legacy_id = ?`，不做跨书回落（D5-A）。中药全局按名查，
 * 因为 `zhong_yao` 没有归属列。
 */
import {getBookNoById} from "./books";
import {
  getFangEntry,
  getYaoEntry,
  type CatalogFangBody,
} from "./entries";

export interface MarkerRef {
  id: string;
  name: string;
  url: string;
}

/** 去掉尾部括号注（`吴茱萸(炮)` → `吴茱萸`），与旧标注层同一口径。 */
export function normalizeYaoName(name: string): string {
  return String(name ?? "")
    .replace(/^\d+\s*[、.．]\s*/u, "")
    .replace(/[（(][^）)]*[）)]\s*$/u, "")
    .trim();
}

export async function loadFangRefsForBook(
  db: D1Database,
  bookInfoId: string,
): Promise<Map<string, MarkerRef>> {
  const map = new Map<string, MarkerRef>();
  const bookNo = await getBookNoById(db, bookInfoId);
  if (!bookNo) return map;
  const {results} = await db
    .prepare(
      "SELECT id, fang_name FROM fang_yao " +
        "WHERE source_book_legacy_id = ? AND deleted_at IS NULL ORDER BY fang_no",
    )
    .bind(bookNo)
    .all<{id: string; fang_name: string | null}>();
  for (const row of results ?? []) {
    const name = String(row.fang_name ?? "").trim();
    const id = String(row.id);
    if (name && !map.has(name)) {
      map.set(name, {id, name, url: `/fang-yao/${id}/`});
    }
  }
  return map;
}

export async function findYaoRefByName(
  db: D1Database,
  pureName: string,
): Promise<MarkerRef | null> {
  const name = normalizeYaoName(pureName);
  if (!name) return null;
  const row = await db
    .prepare(
      "SELECT id, zhong_yao_name FROM zhong_yao " +
        "WHERE zhong_yao_name = ? AND deleted_at IS NULL LIMIT 1",
    )
    .bind(name)
    .first<{id: string; zhong_yao_name: string | null}>();
  if (!row) return null;
  const id = String(row.id);
  return {
    id,
    name: String(row.zhong_yao_name ?? name),
    url: `/zhongyao/${id}/`,
  };
}

export interface FangPopoverData {
  id: string;
  name: string;
  meta: string;
  bodies: CatalogFangBody[];
  bodySource: string;
  url: string;
}

export interface YaoPopoverData {
  id: string;
  name: string;
  meta: string;
  bodySource: string;
  url: string;
}

/** 浮层里的方剂详情；正文给未渲染的 source，由标注层统一渲染一次。 */
export async function getFangPopoverData(
  db: D1Database,
  id: string,
): Promise<FangPopoverData | null> {
  const entry = await getFangEntry(db, id);
  if (!entry) return null;
  const parts: string[] = [];
  if (entry.bodies.length > 0) parts.push(`${entry.bodies.length}味`);
  if (entry.drinkNum) parts.push(`煎服${entry.drinkNum}次`);
  return {
    id: entry.id,
    name: entry.name,
    meta: parts.join(" · "),
    bodies: entry.bodies,
    bodySource: entry.textSource,
    url: `/fang-yao/${entry.id}/`,
  };
}

export async function getYaoPopoverData(
  db: D1Database,
  id: string,
): Promise<YaoPopoverData | null> {
  const entry = await getYaoEntry(db, id);
  if (!entry) return null;
  return {
    id: entry.id,
    name: entry.name,
    meta: entry.alias ? `别名 ${entry.alias}` : "",
    bodySource: entry.textSource,
    url: `/zhongyao/${entry.id}/`,
  };
}
