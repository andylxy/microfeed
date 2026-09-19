/**
 * Pure data shapes for the novel-cms category layer.
 *
 * These live in `src/shared/` rather than next to the queries in
 * `src/server/feed/extCategory.ts` because the admin React app needs them too,
 * and a browser component must never import from `src/server/`. The D1 port
 * types stay server-side; only the plain shapes are shared.
 *
 * Keep this module dependency-free so it can be bundled into the admin client.
 */

/** A novel genre. `bookCount` is populated by the nav query, not stored. */
export interface Category {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  sort: number;
  visible: boolean;
  createdAt: string;
  bookCount?: number;
}

export interface CategoryInput {
  name: string;
  slug?: string;
  parentId?: string | null;
  sort?: number;
  visible?: boolean;
}

/** A book (channel) summary shown on the public category page. */
export interface ChannelBookSummary {
  id: string;
  title: string;
  image: string;
  link: string;
  author?: string;
  description?: string;
  serialStatus?: string;
  /** Human label for `serialStatus` (连载中 / 已完结). The raw value is an
   *  English enum (`serializing` / `finished`) and must not reach the UI. */
  serialStatusLabel?: string;
  wordCount?: string;
  /** Human label for the word count (e.g. `86万字`), for card display. */
  wordCountLabel?: string;
  genre?: string;
  /** Resolved category name for display on public book cards (best-effort). */
  categoryName?: string;
  /** The book channel's `_microfeed` pocket (serialStatus / genre / tags / ...). */
  microfeed?: Record<string, unknown>;
}
