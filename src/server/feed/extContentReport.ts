import {randomShortUUID} from "@/shared/StringUtils";

/**
 * Reader reports for the novel-cms extension.
 *
 * Mirrors the `ext_content_report` table from migration 0023. A reader reports
 * a chapter anonymously; a reviewer later marks the report resolved or
 * dismissed. Reports never touch the public API contract - they are an admin
 * concern only.
 *
 * As with the audit engine, all database access goes through the minimal
 * `ReportDb` port so this module can be unit-tested against in-memory SQLite
 * and run unchanged against a real D1 binding.
 */

export type ReportStatus = "pending" | "resolved" | "dismissed";

export const REPORT_STATUSES: readonly ReportStatus[] = [
  "pending",
  "resolved",
  "dismissed",
];

/** Report categories offered to readers. */
export type ReportCategory =
  | "plagiarism"
  | "pornography"
  | "violence"
  | "advertising"
  | "other";

export const REPORT_CATEGORIES: readonly ReportCategory[] = [
  "plagiarism",
  "pornography",
  "violence",
  "advertising",
  "other",
];

export interface Report {
  id: string;
  itemId: string | null;
  channelId: string | null;
  reporterType: string | null;
  category: string;
  detail: string;
  status: string;
  createdAt: string;
}

export interface ReportDbPreparedStatement {
  bind(...values: unknown[]): ReportDbPreparedStatement;
  run(): Promise<{success: boolean}>;
  all(): Promise<{results: Record<string, unknown>[]}>;
  first(): Promise<Record<string, unknown> | null>;
}

export interface ReportDb {
  prepare(query: string): ReportDbPreparedStatement;
}

export interface CreateReportInput {
  itemId?: string | null;
  channelId?: string | null;
  reporterType?: string | null;
  category: string;
  detail?: string;
}

const INSERT_REPORT = `INSERT INTO ext_content_report (
  id, item_id, channel_id, reporter_type, category, detail, status, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

const SELECT_COLUMNS =
  "id, item_id, channel_id, reporter_type, category, detail, status, created_at";

function toReport(row: Record<string, unknown>): Report {
  return {
    category: String(row.category ?? ""),
    channelId: row.channel_id == null ? null : String(row.channel_id),
    createdAt: String(row.created_at ?? ""),
    detail: String(row.detail ?? ""),
    id: String(row.id ?? ""),
    itemId: row.item_id == null ? null : String(row.item_id),
    reporterType: row.reporter_type == null ? null : String(row.reporter_type),
    status: String(row.status ?? "pending"),
  };
}

/** Record an anonymous reader report. Returns the new report id. */
export async function createReport(
  db: ReportDb,
  input: CreateReportInput,
): Promise<string> {
  const id = randomShortUUID();
  const category = REPORT_CATEGORIES.includes(input.category as ReportCategory)
    ? input.category
    : "other";
  await db
    .prepare(INSERT_REPORT)
    .bind(
      id,
      input.itemId ?? null,
      input.channelId ?? null,
      input.reporterType ?? "anonymous",
      category,
      String(input.detail ?? "").slice(0, 2000),
      "pending",
      new Date().toISOString(),
    )
    .run();
  return id;
}

/** Reports awaiting review, oldest first. */
export async function listReportsByStatus(
  db: ReportDb,
  status: ReportStatus = "pending",
): Promise<Report[]> {
  const result = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM ext_content_report
       WHERE status = ? ORDER BY created_at ASC`,
    )
    .bind(status)
    .all();
  return result.results.map(toReport);
}

export async function getReport(
  db: ReportDb,
  id: string,
): Promise<Report | null> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM ext_content_report WHERE id = ?`)
    .bind(id)
    .first();
  return row == null ? null : toReport(row);
}

/** Move a report out of the pending queue. */
export async function setReportStatus(
  db: ReportDb,
  id: string,
  status: ReportStatus,
): Promise<void> {
  if (!REPORT_STATUSES.includes(status)) {
    throw new Error(`extContentReport: unknown status ${status}`);
  }
  await db
    .prepare("UPDATE ext_content_report SET status = ? WHERE id = ?")
    .bind(status, id)
    .run();
}

/** How many reports are still waiting, for the admin navigation badge. */
export async function countPendingReports(db: ReportDb): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS c FROM ext_content_report WHERE status = 'pending'",
    )
    .first();
  if (row == null) return 0;
  const value = row.c;
  return typeof value === "number" ? value : Number(value);
}
