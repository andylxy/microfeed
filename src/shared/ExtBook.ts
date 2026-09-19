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

/** One row of the dashboard book list. */
export interface BookAdmin {
  id: string;
  title: string;
  author: string;
  cover: string;
  description: string;
  serialStatus: string;
  wordCount: number | null;
  categoryId: string;
  categoryName: string;
  /** `channels.status`: 1 published, 2 draft, 3 deleted. */
  status: number;
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
  wordCount?: number | null;
  categoryId?: string | null;
  status?: number;
}

/** A category the book can be filed under. */
export interface BookCategoryOption {
  id: string;
  name: string;
}

export interface BooksBoard {
  books: BookAdmin[];
  categories: BookCategoryOption[];
}
