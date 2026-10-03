import {STATUSES} from "@/shared/Constants";
import type {
  TcmEntryBoard,
  TcmEntryRow,
  VolumeBookOption,
} from "@/shared/ExtVolume";
import type {VolumeDb} from "./extVolume";

function safeParseJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function asNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Books (channels) that carry at least one item of the given `tcmKind`.
 *
 *  Unlike the fang board (whose entries live on a container channel and point at
 *  the real book via `sourceBookId`), yao/term entries sit directly on their own
 *  book channel — membership is `items.book_id = channel.id`. The picker is
 *  narrowed to books that actually hold this kind so a yao board never offers a
 *  novel or a 名词 book that would render empty. */
export async function listTcmEntryBooks(
  db: VolumeDb,
  tcmKind: string,
): Promise<VolumeBookOption[]> {
  const result = await db.prepare(
    "SELECT DISTINCT i.book_id AS id, c.data AS cdata FROM items i " +
      "JOIN channels c ON c.id = i.book_id " +
      "WHERE i.tcm_kind = ? AND i.status != ? AND c.status != ? " +
      "ORDER BY c.created_at ASC",
  ).bind(tcmKind, STATUSES.DELETED, STATUSES.DELETED).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  const books: VolumeBookOption[] = [];
  for (const row of rows) {
    const data = safeParseJson(row.cdata);
    books.push({
      id: asText(row.id),
      title: typeof data.title === "string" && data.title
        ? data.title
        : "未命名作品",
    });
  }
  return books;
}

/** Strip the deterministic `<p>` wrapping the import writes, so the board can
 *  show / edit plain text without dragging the HTML wrapper through the UI. */
function plainText(html: unknown): string {
  if (typeof html !== "string" || html === "") return "";
  return html
    .replace(/<p>/g, "")
    .replace(/<\/p>/g, "")
    .replace(/\r\n|\r|\n/g, "\n")
    .trim();
}

/** The yao/term board for one book: every item of `tcmKind` whose `book_id`
 *  points at this book, ordered by `_microfeed.no` then id.
 *
 *  Live rows (`status != 3`) by default; `includeDeleted` swaps in the
 *  soft-deleted ones so the board can offer a restore. The board owns the
 *  row's identity + publishing state (add / rename / publish / soft-delete /
 *  restore); the full body still belongs to the item editor, which each row
 *  links out to. */
export async function listTcmEntryBoard(
  db: VolumeDb,
  bookId: string,
  tcmKind: string,
  includeDeleted = false,
): Promise<TcmEntryBoard> {
  const bookRow = await db.prepare(
    "SELECT id, data FROM channels WHERE id = ?",
  ).bind(bookId).first();
  const book: VolumeBookOption | null = bookRow == null ? null : {
    id: asText(bookRow.id),
    title: (() => {
      const data = safeParseJson(bookRow.data);
      return typeof data.title === "string" && data.title
        ? data.title
        : "未命名作品";
    })(),
  };
  if (book == null) {
    return {book, entries: []};
  }

  // `includeDeleted` lists only the removed rows (the recycle view); otherwise
  // the live ones. Keeping the two disjoint avoids ever rendering both at once.
  const statusFilter = includeDeleted
    ? " = ?"
    : " != ?";
  const entryResult = await db.prepare(
    "SELECT id, status, data FROM items " +
      `WHERE tcm_kind = ? AND book_id = ? AND status ${statusFilter} ` +
      "ORDER BY json_extract(data, '$._microfeed.no'), id",
  ).bind(tcmKind, bookId, STATUSES.DELETED).all();
  const entryRows = Array.isArray(entryResult.results)
    ? entryResult.results
    : [];

  const entries: TcmEntryRow[] = [];
  for (const entryRow of entryRows) {
    const data = safeParseJson(entryRow.data);
    const pocket = data._microfeed && typeof data._microfeed === "object"
      ? data._microfeed as Record<string, unknown>
      : {};
    const status = Number(entryRow.status ?? 0);
    entries.push({
      id: asText(entryRow.id),
      name: typeof data.title === "string" && data.title
        ? data.title
        : "未命名条目",
      no: asNumberOrNull(pocket.no),
      status,
      text: plainText(data.description),
      deleted: status === STATUSES.DELETED,
    });
  }

  return {book, entries};
}
