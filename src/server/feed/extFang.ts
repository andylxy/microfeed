import {STATUSES} from "@/shared/Constants";
import type {
  FangBoard,
  FangRow,
  VolumeBookOption,
} from "@/shared/ExtVolume";
import {listVolumeBooks, type VolumeDb} from "./extVolume";

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

/** Books (channels) offered in the fang board's book picker.
 *
 *  Reuses the volume board's picker: container channels (方剂/本草/名词) are
 *  filtered out because their entries belong to the real books through
 *  `_microfeed.sourceBookId` — a fang board is always "formulas of book X". */
export async function listFangBooks(db: VolumeDb): Promise<VolumeBookOption[]> {
  return listVolumeBooks(db);
}

/** The fang board for one real book: every 方剂 whose `_microfeed.sourceBookId`
 *  points at this book, ordered by `_microfeed.no` then id.
 *
 *  The board is a read-only catalog in the style of the volume/chapter board:
 *  each row carries just the fields it renders (name / no / status) and links
 *  out to the item editor, which owns composition and status editing. */
export async function listFangBoard(
  db: VolumeDb,
  bookId: string,
): Promise<FangBoard> {
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
    return {book, fangs: []};
  }

  const fangResult = await db.prepare(
    "SELECT id, status, data FROM items " +
      "WHERE tcm_kind = 'fang' AND status != ? " +
      "AND json_extract(data, '$._microfeed.sourceBookId') = ? " +
      "ORDER BY json_extract(data, '$._microfeed.no'), id",
  ).bind(STATUSES.DELETED, bookId).all();
  const fangRows = Array.isArray(fangResult.results) ? fangResult.results : [];

  const fangs: FangRow[] = [];
  for (const fangRow of fangRows) {
    const data = safeParseJson(fangRow.data);
    const pocket = data._microfeed && typeof data._microfeed === "object"
      ? data._microfeed as Record<string, unknown>
      : {};
    fangs.push({
      id: asText(fangRow.id),
      name: typeof data.title === "string" && data.title
        ? data.title
        : "未命名方剂",
      no: asNumberOrNull(pocket.no),
      status: Number(fangRow.status ?? 0),
    });
  }

  return {book, fangs};
}
