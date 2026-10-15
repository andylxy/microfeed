/**
 * Runtime-neutral shapes for the novel-cms "volume aggregation" board.
 *
 * A volume comes in two kinds, and the board treats both through one key field:
 * a TCM book's volume **is** an entity (the `chapter` row, keyed by its id),
 * while a tag-based novel book's volume is only the `_microfeed.volume` string
 * tag its chapters carry (keyed by the tag itself). These types live in
 * `src/shared` so the admin React app can use them without importing from
 * `src/server` (a hard boundary in this repo) — the same reason `ExtCategory`
 * lives here.
 */

/** Sentinel key for the "unfiled" bucket — entries whose volume tag is empty,
 *  or TCM sections whose `tcm_parent_id` points at nothing in this book. Item
 *  ids are 11 characters, so the sentinel can never collide with a real volume
 *  key, and it survives a URL query parameter ("an empty value" would not). */
export const UNFILED_VOLUME_KEY = "unfiled";

/** A lightweight `{id, title}` book reference for the admin book picker. */
export interface VolumeBookOption {
  id: string;
  title: string;
}

/** One volume row on the on-demand board — the volume **without** its entries.
 *
 *  Clicking a book loads these rows only; a volume's entries come from a second
 *  request when the admin expands it. `chapterCount` is what lets the row read
 *  as "this volume is empty" / "this volume has 306 条文" without paying for the
 *  entries: the server derives it from one covering index scan of the book. */
export interface VolumeSummary {
  /** Server-supplied key. A TCM volume is its `chapter` row id; a tag volume is
   *  the `_microfeed.volume` label itself; the unfiled bucket is
   *  {@link UNFILED_VOLUME_KEY}. The client never has to tell the kinds apart. */
  key: string;
  /** Volume label. Empty string is the "unfiled" bucket. */
  name: string;
  /** Entries currently under this volume, deleted ones excluded. */
  chapterCount: number;
  /** Explicit volume order when the volume carries one (`_microfeed.section`
   *  for a TCM chapter, `volumeOrder` for tagged chapters); null otherwise. */
  order: number | null;
}

/** Everything the volume list needs to render one book's volumes. */
export interface VolumeList {
  /** Null when the requested book does not exist. */
  book: VolumeBookOption | null;
  /** True for TCM-structured books: volumes are `chapter` entities and their
   *  entries are 条文. Drives wording only — the key shape is the same either
   *  way, so no other branch in the UI should read it. */
  tcm: boolean;
  /** The book's volumes, unfiled bucket last (only when it has entries). */
  volumes: VolumeSummary[];
}

/** One entry inside an expanded volume — the row the admin edits or audits.
 *
 *  This is what the second request (one volume) returns. It carries the fields
 *  a row shows plus what the row links need; the body text stays in the item
 *  editor. `index` is the entry's position within this volume, 1-based, so the
 *  numbering the admin sees matches the order the volume was read in. */
export interface VolumeEntry {
  datePublished: string;
  id: string;
  index: number;
  /** Raw microfeed item status (draft / published / ...). */
  status: number;
  title: string;
  /** Explicit volume order carried by the entry (tag books); null for a TCM
   *  section, whose position comes from its chapter relation. */
  volumeOrder: number | null;
}

/** One volume's entries, read on demand. */
export interface VolumeEntryList {
  /** Every entry of this volume, oldest structure first, never paged. */
  entries: VolumeEntry[];
  /** Volume label the key resolved to; empty for the unfiled bucket. */
  name: string;
  /** True for TCM-structured books — drives the 条文 / 章 wording. */
  tcm: boolean;
  /** True when the key is not a volume of this book. Then `entries` is empty
   *  and nothing else was read: a stale or hand-edited URL can't make the
   *  server list another book's entries. */
  unknown: boolean;
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
