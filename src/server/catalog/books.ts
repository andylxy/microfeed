/**
 * 前台书本信息只读层（ADR-0066 决策 4）。
 *
 * 可见性 = `deleted_at IS NULL`（软删排除）且 `hot_book = 0`（状态公开）。
 * `hot_book` 取值 0 公开 / 1 隐藏 / 2 会员（迁移 0173）；`is_enable` 与旧频道
 * 状态都不是发布判据（规范 §2.1 / ADR-0066 决策 12）。
 */
export interface CatalogBook {
  /** = book_info.id；与旧 channels.id 同值，所以 /book/<id>/ 地址不变 */
  id: string;
  title: string;
  image: string;
  author: string;
  description: string;
  caseDivision: string;
  url: string;
}

interface BookRow {
  id: string;
  book_name: string | null;
  image_url: string | null;
  author: string | null;
  comment: string | null;
  case_division: string | null;
}

const BOOK_COLUMNS =
  "id, book_name, image_url, author, comment, case_division";

function toBook(row: BookRow): CatalogBook {
  const id = String(row.id);
  return {
    id,
    title: String(row.book_name ?? ""),
    image: String(row.image_url ?? ""),
    author: String(row.author ?? ""),
    description: String(row.comment ?? ""),
    caseDivision: String(row.case_division ?? ""),
    url: `/book/${id}/`,
  };
}

export async function listBooksByGroup(
  db: D1Database,
  key: string,
): Promise<CatalogBook[]> {
  const {results} = await db
    .prepare(
      `SELECT ${BOOK_COLUMNS} FROM book_info ` +
        "WHERE case_division = ? AND deleted_at IS NULL AND hot_book = 0 " +
        "ORDER BY book_name",
    )
    .bind(key)
    .all<BookRow>();
  return (results ?? []).map(toBook);
}

export async function listAllBooks(db: D1Database): Promise<CatalogBook[]> {
  const {results} = await db
    .prepare(
      `SELECT ${BOOK_COLUMNS} FROM book_info ` +
        "WHERE deleted_at IS NULL AND hot_book = 0 ORDER BY book_name",
    )
    .all<BookRow>();
  return (results ?? []).map(toBook);
}

export async function getBookInfoById(
  db: D1Database,
  id: string,
): Promise<CatalogBook | null> {
  const row = await db
    .prepare(
      `SELECT ${BOOK_COLUMNS} FROM book_info ` +
        "WHERE id = ? AND deleted_at IS NULL AND hot_book = 0 LIMIT 1",
    )
    .bind(id)
    .first<BookRow>();
  return row ? toBook(row) : null;
}

/** 方剂按书解析链的第一步：book_info.id → book_info.book_no。 */
export async function getBookNoById(
  db: D1Database,
  id: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      "SELECT book_no FROM book_info WHERE id = ? AND deleted_at IS NULL LIMIT 1",
    )
    .bind(id)
    .first<{book_no: string | number | null}>();
  if (row?.book_no == null || String(row.book_no) === "") return null;
  return String(row.book_no);
}
