/**
 * 方剂 / 中药 / 名词三条前台条目路由的只读取数层（ADR-0066 决策 7、规范 §5.4）。
 *
 * 每条都是各自表的单行点查（方剂另带一次组成列表与一次所属书反查），
 * 不再有「先查 A 再查 B」的跨表猜测。可见性只看 `deleted_at IS NULL`。
 */
import {
  renderBodyHtml,
  renderBodySource,
  loadMarkerStyles,
} from "./chapters";
import {getBookNoById} from "./books";

export interface CatalogYaoEntry {
  kind: "yao";
  id: string;
  no: number;
  name: string;
  alias: string;
  textHtml: string;
  textSource: string;
  /** zhong_yao_list 原样，不解析 */
  listRaw: string;
}

export interface CatalogFangBody {
  position: number;
  showName: string;
  amount: string;
  extra: string;
}

export interface CatalogFangEntry {
  kind: "fang";
  id: string;
  no: number;
  name: string;
  textHtml: string;
  textSource: string;
  drinkNum: string;
  /** book_info.id；按 book_no → source_book_legacy_id 反查，查不到为 null */
  bookId: string | null;
  bookName: string | null;
  bodies: CatalogFangBody[];
}

export interface CatalogTermEntry {
  kind: "term";
  id: string;
  no: number;
  name: string;
  alias: string;
  textHtml: string;
  textSource: string;
  image: string;
  bookId: string | null;
}

export interface CatalogFangRef {
  id: string;
  name: string;
}

interface YaoRow {
  id: string;
  zhong_yao_no: number | null;
  zhong_yao_name: string | null;
  zhong_yao_bei_ming: string | null;
  zhong_yao_text: string | null;
  zhong_yao_list: string | null;
}

interface FangRow {
  id: string;
  fang_no: number | null;
  fang_name: string | null;
  fang_text: string | null;
  fang_drink_num: string | null;
  source_book_legacy_id: string | null;
}

interface FangBodyRow {
  position: number | null;
  show_name: string | null;
  amount: string | null;
  extra_process: string | null;
}

interface TermRow {
  id: string;
  ming_ci_no: number | null;
  ming_ci_name: string | null;
  ming_ci_bei_ming: string | null;
  ming_ci_text: string | null;
  ming_ci_list: string | null;
  source_book_id: string | null;
  show_image: string | null;
}

export async function getYaoEntry(
  db: D1Database,
  id: string,
): Promise<CatalogYaoEntry | null> {
  const row = await db
    .prepare(
      "SELECT id, zhong_yao_no, zhong_yao_name, zhong_yao_bei_ming, " +
        "zhong_yao_text, zhong_yao_list FROM zhong_yao " +
        "WHERE id = ? AND deleted_at IS NULL LIMIT 1",
    )
    .bind(id)
    .first<YaoRow>();
  if (!row) return null;
  const styles = await loadMarkerStyles(db);
  const text = String(row.zhong_yao_text ?? "");
  return {
    kind: "yao",
    id: String(row.id),
    no: Number(row.zhong_yao_no ?? 0),
    name: String(row.zhong_yao_name ?? ""),
    alias: String(row.zhong_yao_bei_ming ?? ""),
    textHtml: renderBodyHtml(text, styles),
    textSource: renderBodySource(text),
    listRaw: String(row.zhong_yao_list ?? ""),
  };
}

export async function getFangEntry(
  db: D1Database,
  id: string,
): Promise<CatalogFangEntry | null> {
  const row = await db
    .prepare(
      "SELECT id, fang_no, fang_name, fang_text, fang_drink_num, " +
        "source_book_legacy_id FROM fang_yao " +
        "WHERE id = ? AND deleted_at IS NULL LIMIT 1",
    )
    .bind(id)
    .first<FangRow>();
  if (!row) return null;

  const [bodyResult, book, styles] = await Promise.all([
    db
      .prepare(
        "SELECT position, show_name, amount, extra_process FROM fang_yao_body " +
          "WHERE fang_yao_id = ? AND deleted_at IS NULL ORDER BY position",
      )
      .bind(id)
      .all<FangBodyRow>(),
    resolveBookBySourceNo(db, row.source_book_legacy_id),
    loadMarkerStyles(db),
  ]);
  const bodies = (bodyResult.results ?? []).map((entry) => ({
    position: Number(entry.position ?? 0),
    showName: String(entry.show_name ?? ""),
    amount: String(entry.amount ?? ""),
    extra: String(entry.extra_process ?? ""),
  }));
  const text = String(row.fang_text ?? "");
  return {
    kind: "fang",
    id: String(row.id),
    no: Number(row.fang_no ?? 0),
    name: String(row.fang_name ?? ""),
    textHtml: renderBodyHtml(text, styles),
    textSource: renderBodySource(text),
    drinkNum: String(row.fang_drink_num ?? ""),
    bookId: book?.id ?? null,
    bookName: book?.bookName ?? null,
    bodies,
  };
}

/** 方剂页「所属书」：按 source_book_legacy_id 反查 book_info.book_no。 */
async function resolveBookBySourceNo(
  db: D1Database,
  sourceNo: string | null,
): Promise<{id: string; bookName: string} | null> {
  if (!sourceNo) return null;
  const row = await db
    .prepare(
      "SELECT id, book_name FROM book_info " +
        "WHERE book_no = ? AND deleted_at IS NULL LIMIT 1",
    )
    .bind(String(sourceNo))
    .first<{id: string; book_name: string | null}>();
  return row ? {id: String(row.id), bookName: String(row.book_name ?? "")} : null;
}

export async function getTermEntry(
  db: D1Database,
  id: string,
): Promise<CatalogTermEntry | null> {
  const row = await db
    .prepare(
      "SELECT id, ming_ci_no, ming_ci_name, ming_ci_bei_ming, ming_ci_text, " +
        "ming_ci_list, source_book_id, show_image FROM ming_ci " +
        "WHERE id = ? AND deleted_at IS NULL LIMIT 1",
    )
    .bind(id)
    .first<TermRow>();
  if (!row) return null;
  const styles = await loadMarkerStyles(db);
  const text = String(row.ming_ci_text ?? "");
  return {
    kind: "term",
    id: String(row.id),
    no: Number(row.ming_ci_no ?? 0),
    name: String(row.ming_ci_name ?? ""),
    alias: String(row.ming_ci_bei_ming ?? ""),
    textHtml: renderBodyHtml(text, styles),
    textSource: renderBodySource(text),
    image: String(row.show_image ?? ""),
    bookId: row.source_book_id ? String(row.source_book_id) : null,
  };
}

/** 书页「附：方剂」块：book_info.book_no → fang_yao.source_book_legacy_id。 */
export async function listFangByBook(
  db: D1Database,
  bookInfoId: string,
): Promise<CatalogFangRef[]> {
  const bookNo = await getBookNoById(db, bookInfoId);
  if (!bookNo) return [];
  const {results} = await db
    .prepare(
      "SELECT id, fang_name FROM fang_yao " +
        "WHERE source_book_legacy_id = ? AND deleted_at IS NULL ORDER BY fang_no",
    )
    .bind(bookNo)
    .all<{id: string; fang_name: string | null}>();
  return (results ?? []).map((row) => ({
    id: String(row.id),
    name: String(row.fang_name ?? ""),
  }));
}
