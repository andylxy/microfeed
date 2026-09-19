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

/** Everything the volume board page needs to render one book. */
export interface VolumeBoard {
  /** Null when the requested book does not exist. */
  book: VolumeBookOption | null;
  groups: VolumeGroup[];
  /** Distinct volume labels, excluding the unfiled bucket, for pickers. */
  volumeNames: string[];
}
