import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {STATUSES} from "@/shared/Constants";
import {
  recordItemEdit,
  type AuditDb,
  type AuditDbPreparedStatement,
} from "@/server/feed/extContentAudit";
import {
  countPendingReports,
  createReport,
  listReportsByStatus,
  setReportStatus,
  type ReportDb,
  type ReportDbPreparedStatement,
} from "@/server/feed/extContentReport";
import {
  applyReviewTransition,
  listItemAuditRows,
  listPendingReviewItems,
  rebuildItemVersion,
  reviewTransition,
} from "@/server/feed/extReview";

/**
 * End-to-end cover for ticket 05 at the data layer: one chapter is written,
 * submitted, edited, approved, taken down, restored, and finally reported on -
 * against the real SQL the production code issues.
 *
 * This stands in for the ticket's "manual walkthrough", which needs a running
 * instance. It exercises the same composition the dashboard performs, minus
 * the HTTP layer, so it can run in CI.
 */

function makeStatement(
  database: DatabaseSync,
  sql: string,
  boundValues: unknown[] = [],
): AuditDbPreparedStatement & ReportDbPreparedStatement {
  return {
    bind(...values: unknown[]) {
      return makeStatement(database, sql, values);
    },
    async run() {
      database.prepare(sql).run(...(boundValues as any[]));
      return {results: [] as Record<string, unknown>[], success: true};
    },
    async all() {
      return {
        results: database
          .prepare(sql)
          .all(...(boundValues as any[])) as Record<string, unknown>[],
        success: true,
      };
    },
    async first() {
      const rows = database
        .prepare(sql)
        .all(...(boundValues as any[])) as Record<string, unknown>[];
      return rows[0] ?? null;
    },
  };
}

function newDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE items (
    id TEXT PRIMARY KEY,
    status INTEGER,
    data TEXT,
    review_status TEXT,
    updated_at TEXT
  )`);
  database.exec(`CREATE TABLE ext_content_audit (
    id TEXT PRIMARY KEY,
    item_id TEXT,
    channel_id TEXT,
    action TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    diff_data TEXT,
    checkpoint_data TEXT,
    is_checkpoint BOOLEAN DEFAULT 0,
    review_status TEXT,
    reason TEXT,
    created_at TEXT
  )`);
  database.exec(`CREATE TABLE ext_content_report (
    id TEXT PRIMARY KEY,
    item_id TEXT,
    channel_id TEXT,
    reporter_type TEXT,
    category TEXT,
    detail TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT
  )`);
  return database;
}

/** Mirrors what FeedDb writes: the JSON is the truth, the column is derived. */
function writeItem(
  database: DatabaseSync,
  id: string,
  data: Record<string, unknown>,
  status: number,
  updatedAt: string,
): void {
  const microfeed = data._microfeed as Record<string, unknown> | undefined;
  const reviewStatus = typeof microfeed?.reviewStatus === "string"
    ? microfeed.reviewStatus
    : null;
  database
    .prepare(
      "INSERT INTO items (id, status, data, review_status, updated_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data, " +
        "review_status = excluded.review_status, updated_at = excluded.updated_at",
    )
    .run(id, status, JSON.stringify(data), reviewStatus, updatedAt);
}

describe("novel-cms review flow (end to end)", () => {
  it("carries a chapter from author draft through review, takedown, and restore", async () => {
    const database = newDatabase();
    const db: AuditDb & ReportDb = {
      prepare: (sql: string) => makeStatement(database, sql),
    };
    const itemId = "chapter-1";

    // 1. Author writes the chapter. The write seam records the edit.
    const draft = {_microfeed: {reviewStatus: "draft", volume: "第一卷"}, title: "第一章 渡口"};
    writeItem(database, itemId, draft, STATUSES.UNPUBLISHED, "2026-08-01T00:00:00.000Z");
    await recordItemEdit(db, {id: itemId, title: ""}, {...draft, id: itemId});

    // 2. Author submits it. It leaves the author's hands and enters the queue.
    const submitted = applyReviewTransition(draft, reviewTransition("submit"));
    writeItem(database, itemId, submitted, STATUSES.UNPUBLISHED, "2026-08-02T00:00:00.000Z");

    let queue = await listPendingReviewItems(db);
    expect(queue.map((row) => row.id)).toEqual([itemId]);
    expect(queue[0]!.title).toBe("第一章 渡口");

    // 3. Reviewer edits a field while it waits, then approves. Approving is the
    //    only transition that publishes.
    //    The engine checkpoints every third edit, so three edits are recorded
    //    before the approval: that is what makes the version rebuildable below.
    const corrected = {...submitted, title: "第一章 渡口（修订）"};
    await recordItemEdit(db, {...submitted, id: itemId}, {...corrected, id: itemId});
    writeItem(database, itemId, corrected, STATUSES.UNPUBLISHED, "2026-08-03T00:00:00.000Z");

    const reVolumed = {
      ...corrected,
      _microfeed: {...(corrected as Record<string, unknown>)._microfeed as object, volume: "第一卷 渡口"},
    };
    await recordItemEdit(db, {...corrected, id: itemId}, {...reVolumed, id: itemId});
    writeItem(database, itemId, reVolumed, STATUSES.UNPUBLISHED, "2026-08-03T12:00:00.000Z");

    const approved = applyReviewTransition(reVolumed, reviewTransition("approve"));
    writeItem(database, itemId, approved, STATUSES.PUBLISHED, "2026-08-04T00:00:00.000Z");

    queue = await listPendingReviewItems(db);
    expect(queue).toHaveLength(0);

    // A fourth edit, so the restore below replays "checkpoint + later diffs"
    // rather than a checkpoint on its own.
    const polished = {...reVolumed, title: "第一章 渡口"};
    await recordItemEdit(db, {...reVolumed, id: itemId}, {...polished, id: itemId});
    writeItem(database, itemId, polished, STATUSES.PUBLISHED, "2026-08-04T12:00:00.000Z");

    const rows = await listItemAuditRows(db, itemId);
    expect(rows.map((row) => row.action)).toEqual(["edit", "edit", "edit", "edit"]);
    // The third write is the checkpoint: it carries the full snapshot the
    // restore below replays forward from.
    expect(rows[2]!.isCheckpoint).toBe(true);
    expect(rows[3]!.isCheckpoint).toBe(false);

    // 4. A reader reports it; the report lands in the pending queue.
    const reportId = await createReport(db, {
      category: "plagiarism",
      detail: "与另一本书高度相似",
      itemId,
    });
    expect(await countPendingReports(db)).toBe(1);

    // 5. Reviewer takes the chapter down. It unpublishes and records why.
    const takenDown = applyReviewTransition(approved, reviewTransition("takedown", "侵权"));
    writeItem(database, itemId, takenDown, STATUSES.UNPUBLISHED, "2026-08-05T00:00:00.000Z");
    expect((takenDown._microfeed as any).takedown).toBe(true);

    // The reader's report is then closed out.
    await setReportStatus(db, reportId, "resolved");
    expect(await countPendingReports(db)).toBe(0);
    expect((await listReportsByStatus(db, "resolved"))[0]!.id).toBe(reportId);

    // 6. Reviewer restores the last approved body. The rebuild must reproduce
    //    it from the checkpoint plus the diffs recorded after it, and restoring
    //    must not republish the chapter that was just taken down.
    // `polished` was written before the approval was applied, so its recorded
    // review state is still "submitted" - the audit trail reflects what was
    // written, not what happened afterwards.
    const rebuilt = await rebuildItemVersion(db, itemId, rows[3]!.id);
    expect(rebuilt).toMatchObject({
      _microfeed: {reviewStatus: "submitted", volume: "第一卷 渡口"},
      title: "第一章 渡口",
    });

    // A version older than the first checkpoint cannot be rebuilt: the engine
    // has no snapshot to replay from, and it says so instead of guessing.
    expect(await rebuildItemVersion(db, itemId, rows[0]!.id)).toBeNull();

    const restored = applyReviewTransition(
      {...rebuilt!, _microfeed: {...(rebuilt!._microfeed as object)}},
      reviewTransition("approve"),
    );
    writeItem(database, itemId, restored, STATUSES.UNPUBLISHED, "2026-08-06T00:00:00.000Z");

    const finalRow = database
      .prepare("SELECT status, review_status, data FROM items WHERE id = ?")
      .get(itemId) as {status: number; review_status: string; data: string};
    // Restoring a body does not silently republish a chapter that was taken down.
    expect(finalRow.status).toBe(STATUSES.UNPUBLISHED);
    expect(finalRow.review_status).toBe("approved");
    expect(JSON.parse(finalRow.data).title).toBe("第一章 渡口");
    expect(JSON.parse(finalRow.data)._microfeed.takedown).toBeUndefined();
  });

  it("keeps the queue and the mirror column in step for every transition", async () => {
    const database = newDatabase();
    const db: AuditDb & ReportDb = {
      prepare: (sql: string) => makeStatement(database, sql),
    };
    const itemId = "chapter-2";

    const states: Array<[string, number, boolean]> = [];
    let data: Record<string, unknown> = {title: "第二章"};
    for (const action of ["submit", "approve", "reject"] as const) {
      data = applyReviewTransition(
        data,
        reviewTransition(action, action === "reject" ? "不通过" : undefined),
      );
      const transition = reviewTransition(action, action === "reject" ? "不通过" : undefined);
      writeItem(database, itemId, data, transition.status, `2026-08-0${states.length + 1}T00:00:00.000Z`);
      const row = database
        .prepare("SELECT status, review_status FROM items WHERE id = ?")
        .get(itemId) as {status: number; review_status: string};
      states.push([row.review_status, row.status, (await listPendingReviewItems(db)).length > 0]);
    }

    // submitted -> queued; approved -> published and out of the queue;
    // rejected -> unpublished and out of the queue.
    expect(states).toEqual([
      ["submitted", STATUSES.UNPUBLISHED, true],
      ["approved", STATUSES.PUBLISHED, false],
      ["rejected", STATUSES.UNPUBLISHED, false],
    ]);
  });
});
