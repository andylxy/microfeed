/**
 * 前台 sitemap 的 URL 集合与 XML 生成（ADR-0066 决策 14，规范 §3.4）。
 *
 * 只列 `deleted_at IS NULL` 的行，不按 `is_enable` 过滤；卷页 URL 用
 * `book_chapter.id`，三条条目路由用各自新表 id，旧地址不进 sitemap。
 */
import {listGroups} from "./groups";

export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
}

interface UpdatedRow {
  id: string;
  updated_at: string | null;
}

interface VolumeRow extends UpdatedRow {
  source_book_id: string | null;
}

/** `2026-11-06 13:00:04` → `2026-11-06T13:00:04Z`，已经是 ISO 的原样保留。 */
function toW3C(value: string | null): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (raw.includes("T")) return raw;
  return `${raw.replace(" ", "T")}Z`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

export async function listSitemapEntries(
  db: D1Database,
  origin: string,
): Promise<SitemapEntry[]> {
  const base = origin.replace(/\/+$/u, "");
  const entries: SitemapEntry[] = [{loc: `${base}/`, lastmod: null}];

  const groups = await listGroups(db);
  for (const group of groups) {
    entries.push({loc: `${base}/category/${encodeURIComponent(group.key)}/`, lastmod: null});
  }

  const append = (
    rows: UpdatedRow[],
    toPath: (id: string) => string,
  ): void => {
    for (const row of rows) {
      entries.push({
        loc: `${base}${toPath(String(row.id))}`,
        lastmod: toW3C(row.updated_at),
      });
    }
  };

  const books = await db
    .prepare("SELECT id, updated_at FROM book_info WHERE deleted_at IS NULL")
    .all<UpdatedRow>();
  append(books.results ?? [], (id) => `/book/${id}/`);

  const volumes = await db
    .prepare(
      "SELECT c.id, c.source_book_id, c.updated_at FROM book_chapter c " +
        "WHERE c.deleted_at IS NULL AND EXISTS " +
        "(SELECT 1 FROM book_info b WHERE b.id = c.source_book_id AND b.deleted_at IS NULL)",
    )
    .all<VolumeRow>();
  for (const row of volumes.results ?? []) {
    entries.push({
      loc: `${base}/book/${String(row.source_book_id)}/v/${String(row.id)}/`,
      lastmod: toW3C(row.updated_at),
    });
  }

  // 表名写成字面量，静态门禁才能逐条核对 deleted_at IS NULL。
  const fangs = await db
    .prepare("SELECT id, updated_at FROM fang_yao WHERE deleted_at IS NULL")
    .all<UpdatedRow>();
  append(fangs.results ?? [], (id) => `/fang-yao/${id}/`);

  const yaos = await db
    .prepare("SELECT id, updated_at FROM zhong_yao WHERE deleted_at IS NULL")
    .all<UpdatedRow>();
  append(yaos.results ?? [], (id) => `/zhongyao/${id}/`);

  const terms = await db
    .prepare("SELECT id, updated_at FROM ming_ci WHERE deleted_at IS NULL")
    .all<UpdatedRow>();
  append(terms.results ?? [], (id) => `/ming-ci/${id}/`);

  return entries;
}

export async function buildSitemapXml(
  db: D1Database,
  origin: string,
): Promise<string> {
  const entries = await listSitemapEntries(db, origin);
  const body = entries
    .map((entry) => {
      const lastmod = entry.lastmod
        ? `\n    <lastmod>${escapeXml(entry.lastmod)}</lastmod>`
        : "";
      return `  <url>\n    <loc>${escapeXml(entry.loc)}</loc>${lastmod}\n  </url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `${body}\n</urlset>\n`;
}
