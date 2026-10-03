/**
 * Runtime-neutral shapes for the novel-cms "volume aggregation" board.
 *
 * A volume is **not** an entity: it is only the `_microfeed.volume` string tag
 * carried by each chapter (item). These types live in `src/shared` so the admin
 * React app can use them without importing from `src/server` (a hard boundary
 * in this repo) — the same reason `ExtCategory` lives here.
 */

/** A chapter row inside a volume group. */
export interface VolumeChapter {
  id: string;
  title: string;
  /** Volume label. Empty string means the chapter is not filed under a volume. */
  volume: string;
  chapterNo: number;
  /** Raw microfeed item status (draft / published / ...). */
  status: number;
  /** `pub_date` as stored, used to break `chapterNo` ties. */
  datePublished: string;
  /** Explicit volume order when the chapter carries `_microfeed.volumeOrder`. */
  volumeOrder: number | null;
}

/** One volume bucket and the chapters filed under it. */
export interface VolumeGroup {
  /** Volume label. Empty string is the "unfiled" bucket. */
  name: string;
  /** Explicit order when any chapter in the volume carries `volumeOrder`. */
  order: number | null;
  chapters: VolumeChapter[];
}

/** A lightweight `{id, title}` book reference for the admin book picker. */
export interface VolumeBookOption {
  id: string;
  title: string;
}

/** One ingredient row of a 方剂, mirroring the shape build.ts writes into
 *  `_microfeed.fangYaoList` — the App's GetBookIdFang reads these exact fields
 *  (suffix/amount/yaoID/weight/showName/extraProcess). Shared so the item
 *  editor's FangEditor and the fang board both speak the same type. */
export interface FangYaoEntry {
  yaoId: string;
  amount?: string | number | null;
  weight?: string | number | null;
  suffix?: string | null;
  showName?: string;
  extraProcess?: string | null;
}

/** One 方剂 (prescription) row on the dedicated fang board.
 *
 *  Fang entries are items on the book's channel whose real book is resolved
 *  through `_microfeed.sourceBookId` (the board is keyed by that real book).
 *  The board is a read-only catalog in the same style as the volume/chapter
 *  board: each row links out to the item editor, which owns composition
 *  (`fangYaoList`) and status editing, so only the fields the row displays
 *  are carried. */
export interface FangRow {
  id: string;
  /** Prescription name (the fang item's title). */
  name: string;
  /** Raw microfeed item status (draft / published / ...). */
  status: number;
  /** Source `_microfeed.no` (display order within the book). */
  no: number | null;
}

/** Everything the fang board page needs to render one book's prescriptions. */
export interface FangBoard {
  /** Null when the requested book does not exist. */
  book: VolumeBookOption | null;
  /** The book's 方剂 (prescriptions), ordered by `_microfeed.no` then id. */
  fangs: FangRow[];
}

/** One 中药 (herb) / 名词 (term) row on the dedicated yao/term board.
 *
 *  These are flat TCM books: the item's `book_id` is the real book channel
 *  (no `sourceBookId`), so membership is resolved by `book_id` + `tcm_kind`.
 *  The board owns the row's identity + publishing state (add / rename / publish
 *  / soft-delete / restore); the full body text is still owned by the item
 *  editor, so only what the board renders (or needs to edit) is carried. */
export interface TcmEntryRow {
  id: string;
  /** Entry title (the item's title). */
  name: string;
  /** Raw microfeed item status (draft / published / ...). */
  status: number;
  /** Source `_microfeed.no` (display order within the book). */
  no: number | null;
  /** Item body text (plain text, `<p>` markup stripped) for the board's editor. */
  text: string;
  /** True when the row is soft-deleted (`status = 3`); only listed with `?deleted=1`. */
  deleted: boolean;
}

/** Everything a yao/term board page needs to render one book's entries. */
export interface TcmEntryBoard {
  /** Null when the requested book does not exist. */
  book: VolumeBookOption | null;
  /** The book's entries of the requested kind, ordered by `_microfeed.no` then id. */
  entries: TcmEntryRow[];
}

/** Everything the volume board page needs to render one book. */
export interface VolumeBoard {
  /** Null when the requested book does not exist. */
  book: VolumeBookOption | null;
  groups: VolumeGroup[];
  /** Distinct volume labels, excluding the unfiled bucket, for pickers. */
  volumeNames: string[];
  /**
   * True for TCM-structured books (伤寒杂病论・桂林古本 等): their "volumes"
   * are real chapter entities and the chapters under them are the sections
   * filed via `tcm_parent_id` — not `_microfeed.volume` tags. Reassigning or
   * renaming volumes would write stray tags onto TCM items, so the board is
   * read-only (structure view) for these books.
   */
  readOnly?: boolean;
}
