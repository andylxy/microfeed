/**
 * Pure catalog shape for the novel content read API (ADR-0006).
 *
 * Kept free of I/O (no `cloudflare:workers`, no database) so the volume
 * grouping and the chapter cap can be unit-tested directly, and so the handler
 * in `src/server/api/content-read.ts` stays a thin adapter over it.
 */

/**
 * A chapter as `getBookChapters` returns it: the public feed item shape, with
 * the whole `items.data` JSON spread over the top and `_microfeed` alongside.
 */
export interface FeedChapter {
  id: string;
  title?: unknown;
  date_published?: unknown;
  _microfeed?: Record<string, unknown>;
}

/** One volume in the catalog response. */
export interface CatalogVolume {
  chapters: Array<{chapterNo: number; id: string; pubDate?: string; title: string}>;
  name: string;
}

function volumeName(chapter: FeedChapter): string {
  const value = chapter._microfeed?.volume;
  return typeof value === "string" ? value.trim() : "";
}

function chapterNumber(chapter: FeedChapter): number {
  const value = chapter._microfeed?.chapterNo;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function chapterDate(chapter: FeedChapter): string {
  return typeof chapter.date_published === "string" ? chapter.date_published : "";
}

function volumeOrder(chapter: FeedChapter): number | null {
  const value = chapter._microfeed?.volumeOrder;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Bucket chapters by their `volume` label, using the same rule the admin volume
 * board uses (see `listVolumeBoard` in `extVolume.ts`): order groups by an
 * explicit `volumeOrder`, else by each group's first chapter number, then that
 * chapter's publish date, then its id. The unfiled bucket (empty label) is
 * always last.
 */
function groupIntoVolumes(chapters: FeedChapter[]): Array<{
  chapters: FeedChapter[];
  name: string;
}> {
  const buckets = new Map<string, FeedChapter[]>();
  for (const chapter of chapters) {
    const name = volumeName(chapter);
    const bucket = buckets.get(name);
    if (bucket) bucket.push(chapter);
    else buckets.set(name, [chapter]);
  }
  return [...buckets.entries()]
    .map(([name, list]) => ({
      chapters: list,
      name,
      order: list.map(volumeOrder).find((value) => value != null) ?? null,
    }))
    .sort((left, right) => {
      if (!left.name !== !right.name) return left.name ? -1 : 1;
      const leftFirst = left.chapters[0];
      const rightFirst = right.chapters[0];
      if (!leftFirst || !rightFirst) return 0;
      const leftKey = left.order ?? chapterNumber(leftFirst);
      const rightKey = right.order ?? chapterNumber(rightFirst);
      if (leftKey !== rightKey) return leftKey - rightKey;
      const leftDate = chapterDate(leftFirst);
      const rightDate = chapterDate(rightFirst);
      if (leftDate !== rightDate) return leftDate < rightDate ? -1 : 1;
      return leftFirst.id < rightFirst.id ? -1 : 1;
    })
    .map(({chapters: list, name}) => ({chapters: list, name}));
}

/**
 * Turn an ordered chapter list into the catalog response body.
 *
 * The cap is applied to the flat list *before* grouping, so the result is
 * predictable ("the first `max` chapters in reading order"); `truncated` tells
 * the caller the last volume may therefore be incomplete.
 */
export function buildCatalog(
  chapters: FeedChapter[],
  max: number,
): {truncated: boolean; volumes: CatalogVolume[]} {
  return {
    truncated: chapters.length > max,
    volumes: groupIntoVolumes(chapters.slice(0, max)).map(
      ({chapters: list, name}) => ({
        chapters: list.map((chapter) => {
          const date = chapterDate(chapter);
          return {
            chapterNo: chapterNumber(chapter),
            id: chapter.id,
            ...(date ? {pubDate: date} : {}),
            title: typeof chapter.title === "string" ? chapter.title : "",
          };
        }),
        name,
      }),
    ),
  };
}
