/**
 * 前台卷章与条文正文只读层（ADR-0066 决策 8/9，规范 §2.2）。
 *
 * 分流口径：`bencao_yao_name` 非空的 930 行拼 `section_note`，其余 7,136 行
 * 只用 `section_text`。排序键是 `receipt_no`（全序且全局唯一），表里没有
 * `position` 与 `section_title` 列。
 *
 * 每条同时给两份 HTML：
 *  - `bodyHtml`：转义 → 标记渲染（不带链接）→ 包 `<p>`，供不需要浮层的场景；
 *  - `bodySource`：转义 → 包 `<p>`，标记保持字面，供 `buildTcmMarkerLayer`
 *    一次渲染成可点实体并注入浮层。两份都由同一段原文派生，不会分叉。
 */
import {escapeHtml} from "@/shared/StringUtils";
import {renderTcmMarkers, type TcmMarkerStyle} from "@/shared/TcmMarkers";
import {getAppStyleConfig} from "@/server/tcm/reads";

export interface CatalogVolume {
  id: string;
  name: string;
}

export interface CatalogSectionRow {
  id: string;
  bodyHtml: string;
  bodySource: string;
}

export interface CatalogVolumeDetail {
  id: string;
  name: string;
  sections: CatalogSectionRow[];
}

/** App 下发的样式目录 → 渲染器消费的形状；与标注层用同一张标记字典。 */
export async function loadMarkerStyles(
  db: D1Database,
): Promise<TcmMarkerStyle[]> {
  const rows = await getAppStyleConfig(db);
  return rows.map((row) => ({
    code: row.marker,
    color: row.color,
    smallFont: row.isSmallFont,
    smallFontScale: row.smallFontScale,
    linkType: row.linkType,
  }));
}

/** 转义后包 `<p>`，标记保持字面，供标注层再渲染一次。 */
export function renderBodySource(text: string): string {
  return `<p>${escapeHtml(String(text ?? ""))}</p>`;
}

/** 转义 → 标记渲染 → 包 `<p>`；不把正文原文当 HTML 直接输出。 */
export function renderBodyHtml(
  text: string,
  styles: TcmMarkerStyle[],
): string {
  return `<p>${renderTcmMarkers(escapeHtml(String(text ?? "")), styles, {})}</p>`;
}

/** 按 `bencao_yao_name` 分流拼接，不 trim、不归一换行、不折叠空白。 */
export function sectionText(row: {
  section_text: string | null;
  section_note: string | null;
  bencao_yao_name: string | null;
}): string {
  const body = String(row.section_text ?? "");
  if (row.bencao_yao_name == null || String(row.bencao_yao_name) === "") {
    return body;
  }
  return body + String(row.section_note ?? "");
}

export async function listVolumesByBook(
  db: D1Database,
  bookInfoId: string,
): Promise<CatalogVolume[]> {
  const {results} = await db
    .prepare(
      "SELECT id, chapter_header FROM book_chapter " +
        "WHERE source_book_id = ? AND deleted_at IS NULL ORDER BY chapter_no",
    )
    .bind(bookInfoId)
    .all<{id: string; chapter_header: string | null}>();
  return (results ?? []).map((row) => ({
    id: String(row.id),
    name: String(row.chapter_header ?? ""),
  }));
}

export async function getVolumeWithSections(
  db: D1Database,
  chapterId: string,
): Promise<CatalogVolumeDetail | null> {
  const chapter = await db
    .prepare(
      "SELECT id, chapter_header FROM book_chapter " +
        "WHERE id = ? AND deleted_at IS NULL LIMIT 1",
    )
    .bind(chapterId)
    .first<{id: string; chapter_header: string | null}>();
  if (!chapter) return null;

  const {results} = await db
    .prepare(
      "SELECT id, section_text, section_note, bencao_yao_name " +
        "FROM book_chapter_body " +
        "WHERE book_chapter_id = ? AND deleted_at IS NULL ORDER BY receipt_no",
    )
    .bind(chapterId)
    .all<{
      id: string;
      section_text: string | null;
      section_note: string | null;
      bencao_yao_name: string | null;
    }>();
  const styles = await loadMarkerStyles(db);
  const sections = (results ?? []).map((row) => {
    const text = sectionText(row);
    return {
      id: String(row.id),
      bodyHtml: renderBodyHtml(text, styles),
      bodySource: renderBodySource(text),
    };
  });
  return {
    id: String(chapter.id),
    name: String(chapter.chapter_header ?? ""),
    sections,
  };
}
