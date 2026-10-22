/**
 * Admin-side view of a novel-cms book.
 *
 * A book is a `channels` row: the public site reads its title, authors, cover
 * and description straight from `data`, and the novel-specific fields
 * (serial status, word count, genre) live in the `data._microfeed` pocket.
 * This module describes the shape the dashboard exchanges with the server —
 * the public-facing summaries stay in `ExtCategory`.
 */

export interface BookAuthor {
  name: string;
}

/**
 * 「会员」书籍状态码（`ext_book_status` 的 0143 种子行）：只对持会员角色的账号
 * 可见，不进公开站。状态字典本身是数据表，这个常量只给「会员门」与目录收录用。
 */
export const MEMBER_BOOK_STATUS = 10;

/** One row of the dashboard book list. */
export interface BookAdmin {
  id: string;
  title: string;
  author: string;
  cover: string;
  description: string;
  serialStatus: string;
  /** Derived from the book's published chapters — never hand-typed. */
  wordCount: number;
  categoryId: string;
  categoryName: string;
  /** The `ext_book_status` code this book carries. 1/2/3 are the seeded system
   *  rows (visible / hidden / deleted); custom statuses start at 10. */
  status: number;
  /** True when this status code is the dictionary's delete state
   *  (`ext_book_status.admin_list_hidden`, migration 0142) — the books board
   *  offers restore / purge for these rows instead of edit / soft-delete. */
  isDeleted: boolean;
  /** The primary channel is the site's own feed, so it cannot be deleted. */
  isPrimary: boolean;
  chapterCount: number;
}

export interface BookInput {
  title: string;
  author?: string;
  cover?: string;
  description?: string;
  serialStatus?: string;
  categoryId?: string | null;
  status?: number;
}

/** A category the book can be filed under. */
export interface BookCategoryOption {
  id: string;
  name: string;
}

/**
 * Accepted colour values for a status badge: `#RGB` or `#RRGGBB` — the only
 * shapes the native colour input produces. `rgb()`/`rgba()` are deliberately
 * NOT accepted: the picker cannot store alpha, so an `rgba()` value would be
 * silently flattened on the next edit. `null` (or an empty column) means
 * "leave the label uncoloured".
 */
export const BOOK_STATUS_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/u;

/** The badge label for the current language; the other language is the fallback. */
export function bookStatusDisplayName(
  status: {nameZh: string; nameEn: string},
  chinese: boolean,
): string {
  return (chinese ? status.nameZh : status.nameEn) || status.nameZh;
}

/**
 * Inline style for a status badge, or undefined when the row carries no colour
 * (the caller then renders the plain label). Shared by the books board and the
 * status manage page so the two previews cannot drift.
 */
export function bookStatusBadgeStyle(
  status: {colorFg: string | null; colorBg: string | null},
): {color?: string; backgroundColor?: string} | undefined {
  if (!status.colorFg && !status.colorBg) return undefined;
  return {
    color: status.colorFg || undefined,
    backgroundColor: status.colorBg || undefined,
  };
}

/**
 * One `ext_book_status` row as the server reads it (migrations 0142/0143).
 *
 * Lives in `shared` so the dashboard types its AJAX payload against the same
 * shape the server writes — `BooksApp` does the same with `BookAdmin`. A field
 * added here shows up as a compile error on both sides instead of a silent
 * payload mismatch.
 */
export interface BookStatusRow {
  /** The value stored in `channels.status` (1–127). */
  code: number;
  nameZh: string;
  nameEn: string;
  formSelectable: boolean;
  publicVisible: boolean;
  adminListHidden: boolean;
  isSystem: boolean;
  sort: number;
  /** Badge colours on the books board; null leaves the label uncoloured. */
  colorFg: string | null;
  colorBg: string | null;
}

/**
 * The board-facing slice of a status row: the edit form's options and the list
 * row labels. Derived from {@link BookStatusRow} so a field added there shows
 * up here as a compile error instead of a silent payload mismatch.
 */
export type BookStatusOption = Pick<BookStatusRow,
  | "code"
  | "nameZh"
  | "nameEn"
  | "formSelectable"
  | "colorFg"
  | "colorBg">;

export interface BooksBoard {
  books: BookAdmin[];
  categories: BookCategoryOption[];
  statuses: BookStatusOption[];
}
