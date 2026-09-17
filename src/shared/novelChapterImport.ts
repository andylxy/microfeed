/**
 * Pure, dependency-free parser that turns a pasted/uploaded novel `.txt` into
 * a list of {@link ChapterDraft} chapter objects. Used by the admin
 * "txt 分章导入" tool (`./ImportChaptersApp`) and covered by the esbuild +
 * node:sqlite smoke harness.
 *
 * Design notes (upgrade-zero-conflict):
 * - This module has NO server-only imports, so it is safe to bundle into the
 *   admin React client AND to unit-test in isolation.
 * - It does not touch the public API contract; it only produces plain data
 *   that the caller persists via `_microfeed` (volume / chapterNo / genre).
 */

export interface ChapterDraft {
  title: string;
  content: string;
  volume?: string;
  chapterNo?: number;
}

const CN_NUMERALS: Record<string, number> = {
  '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5,
  '六': 6, '七': 7, '八': 8, '九': 9, '十': 10, '百': 100, '千': 1000,
};

/** Convert an Arabic or simple Chinese numeral (零..千) to a number. */
export function toArabic(raw: string): number {
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  let section = 0;
  let current = 0;
  for (const ch of raw) {
    const v = CN_NUMERALS[ch];
    if (v === undefined) continue;
    if (v >= 100) {
      section += (current || 1) * v;
      current = 0;
    } else if (v === 10) {
      section += (current || 1) * 10;
      current = 0;
    } else {
      current = v;
    }
  }
  return section + current;
}

// No trailing \b: it is an ASCII word boundary, and 卷/章 are not ASCII word
// characters, so `第一章 ` would never produce a boundary and the heading would
// be silently missed. A CJK-only lookahead expresses the intent instead.
const CJK = "\\u3400-\\u9fff";
// The capture includes the leading 第 so the volume label reads 第一卷 rather
// than 一卷.
const VOLUME_RE = new RegExp(
  `^\\s*(第\\s*[0-9零一二三四五六七八九十百千两]+\\s*[卷部篇集])(?![${CJK}])`,
);
const CHAPTER_RE = new RegExp(
  `^\\s*(第\\s*[0-9零一二三四五六七八九十百千两]+\\s*[章回节篇])(?![${CJK}])`,
);
const CHAPTER_NUM_RE =
  /^\s*第\s*([0-9零一二三四五六七八九十百千两]+)\s*[章回节篇]/;
const MARKDOWN_HEADING_RE = /^\s*#{1,6}\s+(.+)$/;
const EN_CHAPTER_RE = /^\s*chapter\s+(\d+)\b/i;

/**
 * Split raw novel text into chapters.
 *
 * Algorithm:
 * 1. Split the text into blocks separated by one or more blank lines.
 * 2. For each block, inspect its first line:
 *    - a "volume" marker (第N卷/部/篇/集) updates the current volume and, if
 *      the block has more lines, becomes a leading chapter of that volume;
 *    - a "chapter" marker (第N章/回/节, a markdown heading, or `Chapter N`)
 *      becomes a titled chapter, with its number parsed when present;
 *    - otherwise the whole block becomes a chapter with an auto-generated
 *      title + sequential number.
 * 3. Subsequent chapters inherit the most recent volume marker.
 */
export function splitChapters(text: string): ChapterDraft[] {
  if (!text) return [];
  const blocks = text
    .replace(/\r\n/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  const chapters: ChapterDraft[] = [];
  let currentVolume: string | undefined;
  let autoNo = 0;

  for (const block of blocks) {
    const lines = block.split('\n');
    const firstLine = (lines[0] ?? '').trim();

    const volMatch = firstLine.match(VOLUME_RE);
    if (volMatch) {
      currentVolume = (volMatch[1] ?? '').replace(/\s+/g, '');
      const rest = lines.slice(1).join('\n').trim();
      if (rest.length > 0) {
        autoNo += 1;
        chapters.push({
          title: `${currentVolume}·起始`,
          content: rest,
          volume: currentVolume,
          chapterNo: autoNo,
        });
      }
      continue;
    }

    const mdMatch = firstLine.match(MARKDOWN_HEADING_RE);
    const enMatch = firstLine.match(EN_CHAPTER_RE);
    const zhMatch = firstLine.match(CHAPTER_RE);

    if (mdMatch || enMatch || zhMatch) {
      const numMatch = firstLine.match(CHAPTER_NUM_RE);
      // `Chapter 7` carries its number in the English form; without this the
      // detected heading was ignored and the chapter was auto-numbered.
      const detectedRaw = numMatch?.[1] ?? enMatch?.[1];
      const detectedNo = detectedRaw ? toArabic(detectedRaw) : undefined;
      const chapterNo = detectedNo ?? (autoNo + 1);
      // Always resync, not only on the auto path: after an explicit 第十章 the
      // next untitled block must continue at 11, not restart at 1.
      autoNo = chapterNo;
      const content = lines.slice(1).join('\n').trim();
      chapters.push({
        title: mdMatch ? (mdMatch[1] ?? '').trim() : firstLine,
        content,
        volume: currentVolume,
        chapterNo,
      });
      continue;
    }

    autoNo += 1;
    chapters.push({
      title: `第${autoNo}章`,
      content: block,
      volume: currentVolume,
      chapterNo: autoNo,
    });
  }

  return chapters;
}
