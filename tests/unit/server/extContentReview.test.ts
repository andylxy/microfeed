import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {
  approveChapterVersions,
  listChapterReviews,
  listPendingChapters,
  recordContentChange,
  rejectChapterVersions,
  type AuditDb,
  type AuditDbPreparedStatement,
} from "@/server/feed/extContentReview";
import {listItemAuditRows, rebuildItemVersion} from "@/server/feed/extReview";

type SqlInputValue = null | number | bigint | string | NodeJS.ArrayBufferView;

class SqliteStatement implements AuditDbPreparedStatement {
  private readonly statement: ReturnType<DatabaseSync["prepare"]>;
  private values: SqlInputValue[] = [];

  constructor(database: DatabaseSync, query: string) {
    this.statement = database.prepare(query);
  }

  bind(...values: unknown[]): AuditDbPreparedStatement {
    this.values = values as SqlInputValue[];
    return this;
  }

  async all(): Promise<{results: Record<string, unknown>[]; success: boolean}> {
    return {
      results: this.statement.all(...this.values) as Record<string, unknown>[],
      success: true,
    };
  }

  async first(): Promise<Record<string, unknown> | null> {
    return (this.statement.get(...this.values) as Record<string, unknown> | undefined)
      ?? null;
  }

  async run(): Promise<{results: Record<string, unknown>[]; success: boolean}> {
    this.statement.run(...this.values);
    return {results: [], success: true};
  }
}

class SqliteAuditDb implements AuditDb {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): AuditDbPreparedStatement {
    return new SqliteStatement(this.database, query);
  }
}

function emptyDatabase(): {database: DatabaseSync; db: SqliteAuditDb} {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE items (
      id VARCHAR(11) PRIMARY KEY,
      status TINYINT,
      data TEXT,
      content_text TEXT NOT NULL DEFAULT '',
      content_text_updated_at TIMESTAMP,
      review_status TEXT,
      pub_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE ext_content_audit (
      id VARCHAR(11) PRIMARY KEY,
      item_id VARCHAR(11),
      channel_id VARCHAR(11),
      action TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      diff_data TEXT,
      checkpoint_data TEXT,
      is_checkpoint BOOLEAN DEFAULT 0,
      review_status TEXT,
      reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE ext_content_review (
      id VARCHAR(11) PRIMARY KEY,
      item_id VARCHAR(11) NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected')),
      diff_data TEXT,
      snapshot_data TEXT NOT NULL,
      proposed_data TEXT,
      action TEXT NOT NULL,
      submitted_by TEXT,
      submitted_at INTEGER,
      reviewed_by TEXT,
      reviewed_at INTEGER,
      reason TEXT
    );
  `);
  return {database, db: new SqliteAuditDb(database)};
}

/**
 * Mirrors what `FeedDb._putItemToContentStatement` writes: `data` plus the
 * columns derived from it. The review gate has to roll all of them back, not
 * just `data`, so the fixture has to carry them.
 */
function writeItem(database: DatabaseSync, id: string, data: unknown) {
  const row = data as Record<string, unknown>;
  database.prepare(
    "INSERT OR REPLACE INTO items (id, status, data, content_text, " +
      "review_status) VALUES (?,?,?,?,?)",
  ).run(
    id,
    1,
    JSON.stringify(data),
    plainText(row["description"]),
    (row["_microfeed"] as {reviewStatus?: string} | undefined)?.reviewStatus ?? null,
  );
}

function plainText(value: unknown): string {
  return String(value ?? "").replace(/<[^>]*>/g, "");
}

function readRow(database: DatabaseSync, id: string): Record<string, unknown> {
  return database.prepare("SELECT * FROM items WHERE id = ?").get(id) as
    Record<string, unknown>;
}

function readItem(database: DatabaseSync, id: string): Record<string, unknown> {
  const row = database.prepare("SELECT data FROM items WHERE id = ?").get(id) as
    {data: string};
  return JSON.parse(row.data) as Record<string, unknown>;
}

const v1 = {id: "chap1", title: "第一章 起锚", description: "<p>原文</p>"};
const v2 = {...v1, title: "第一章 起航"};

describe("content review chain", () => {
  it("opens a pending version for every real change", async () => {
    const {database, db} = emptyDatabase();
    writeItem(database, "chap1", v1);
    writeItem(database, "chap1", v2);

    const review = await recordContentChange(db, {
      action: "edit",
      actorId: "author-1",
      after: v2,
      before: v1,
      itemId: "chap1",
    });

    expect(review?.status).toBe("pending");
    expect(review?.submittedBy).toBe("author-1");
    expect(review?.changes).toEqual([
      {after: "第一章 起航", before: "第一章 起锚", op: "update", path: "title"},
    ]);

    // The queue is driven by pending versions, not by a status label.
    const queue = await listPendingChapters(db);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({itemId: "chap1", pendingCount: 1, title: "第一章 起锚"});
    // The review page renders `changes` as a git diff, so an empty array here
    // would show an approver an empty diff and no way to tell what they are
    // confirming.
    expect(queue[0]!.changes).toEqual([
      {after: "第一章 起航", before: "第一章 起锚", op: "update", path: "title"},
    ]);

    // Gate: the change must NOT be public until it is confirmed.
    expect(readItem(database, "chap1").title).toBe("第一章 起锚");
  });

  it("holds back the columns derived from data, not just data itself", async () => {
    const {database, db} = emptyDatabase();
    const before = {
      _microfeed: {reviewStatus: "approved"},
      id: "chap1",
      title: "第一章 起锚",
      description: "<p>原文</p>",
    };
    const after = {
      _microfeed: {reviewStatus: "submitted"},
      id: "chap1",
      title: "第一章 起航",
      description: "<p>待审正文</p>",
    };
    // The caller saves `after` first, refreshing the derived columns with the
    // unconfirmed content — exactly what production does.
    writeItem(database, "chap1", after);
    await recordContentChange(db, {
      action: "edit", after, before, itemId: "chap1",
    });

    const row = readRow(database, "chap1");
    expect(JSON.parse(String(row.data)).description).toBe("<p>原文</p>");
    // Search text and the queue index still pointed at the pending content
    // before this was fixed: the FTS index would answer with 待审正文.
    expect(row.content_text).toBe("原文");
    expect(row.review_status).toBe("approved");
  });

  it("rebuilds the chain from scratch when the ledger is empty", async () => {
    // The audit table can legitimately start empty — a fresh site, or one whose
    // trail was cleared. The first change recorded after that MUST be a
    // checkpoint, otherwise nothing is ever restorable again: replaying walks
    // back to the nearest snapshot and an empty ledger has none.
    const {database, db} = emptyDatabase();
    writeItem(database, "chap1", v1);
    writeItem(database, "chap1", v2);

    await recordContentChange(db, {
      action: "edit", after: v2, before: v1, itemId: "chap1",
    });

    expect(await listChapterReviews(db, "chap1")).toHaveLength(1);

    const trail = await listItemAuditRows(db, "chap1");
    expect(trail).toHaveLength(1);
    expect(trail[0]!.isCheckpoint).toBe(true);
    // Without that first snapshot the row could never be replayed, and the
    // dashboard would disable restore for every version of the chapter.
    expect(trail[0]!.restorable).toBe(true);
    expect(await rebuildItemVersion(db, "chap1", trail[0]!.id)).toMatchObject({
      title: v2.title,
    });
  });

  it("restores the Markdown source along with the rendered body", async () => {
    // A Markdown-edited chapter stores two fields: `description` (rendered HTML)
    // and `content_markdown` (the source). Both go through the same
    // checkpoint-and-replay machinery, so restoring a version has to bring back
    // the source too — otherwise the body and its source drift apart and the
    // next Markdown save would quietly rewrite the chapter.
    const {database, db} = emptyDatabase();
    const before = {
      content_markdown: "# 一\n\n旧正文。",
      description: "<h1>一</h1>\n<p>旧正文。</p>",
      id: "chap1",
      title: "第一章 起锚",
    };
    const after = {
      ...before,
      content_markdown: "# 一\n\n新正文。",
      description: "<h1>一</h1>\n<p>新正文。</p>",
    };
    writeItem(database, "chap1", before);
    writeItem(database, "chap1", after);
    await recordContentChange(db, {
      action: "edit", after, before, itemId: "chap1",
    });

    const trail = await listItemAuditRows(db, "chap1");
    expect(trail).toHaveLength(1);
    const rebuilt = await rebuildItemVersion(db, "chap1", trail[0]!.id);
    expect(rebuilt?.description).toBe(after.description);
    expect(rebuilt?.content_markdown).toBe(after.content_markdown);
  });

  it("queues the newest unconfirmed version's changes for review", async () => {
    const {database, db} = emptyDatabase();
    writeItem(database, "chap1", v1);
    writeItem(database, "chap1", v2);
    await recordContentChange(db, {
      action: "edit", after: v2, before: v1, itemId: "chap1",
    });
    // A second edit before anyone confirms: the queue shows ONE chapter with
    // two pending versions, and the diff belongs to the newest one.
    const v3 = {...v1, title: "第一章 归航"};
    writeItem(database, "chap1", v3);
    await recordContentChange(db, {
      action: "edit", after: v3, before: v2, itemId: "chap1",
    });

    const queue = await listPendingChapters(db);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.pendingCount).toBe(2);
    expect(queue[0]!.changes).toEqual([
      {after: "第一章 归航", before: "第一章 起航", op: "update", path: "title"},
    ]);
  });

  it("records nothing when the content did not change", async () => {
    const {database, db} = emptyDatabase();
    writeItem(database, "chap1", v1);
    expect(await recordContentChange(db, {
      action: "edit",
      after: {...v1},
      before: v1,
      itemId: "chap1",
    })).toBeNull();
    expect(await listPendingChapters(db)).toHaveLength(0);
  });

  it("refreshes the derived columns when a version is confirmed", async () => {
    const {database, db} = emptyDatabase();
    const before = {
      _microfeed: {reviewStatus: "approved"},
      id: "chap1",
      title: "第一章 起锚",
      description: "<p>原文</p>",
    };
    const after = {
      _microfeed: {reviewStatus: "approved"},
      id: "chap1",
      title: "第一章 起航",
      description: "<p>新正文</p>",
    };
    writeItem(database, "chap1", after);
    await recordContentChange(db, {
      action: "edit", after, before, itemId: "chap1",
    });
    // The gate pinned everything back to `before`.
    expect(readRow(database, "chap1").content_text).toBe("原文");

    await approveChapterVersions(db, "chap1", "reviewer-1");
    const row = readRow(database, "chap1");
    // Confirming only rewrote `data` before this was fixed, so the searchable
    // text never caught up with the body the reader already shows.
    expect(JSON.parse(String(row.data)).description).toBe("<p>新正文</p>");
    expect(row.content_text).toBe("新正文");
  });

  it("approving confirms the versions and empties the queue", async () => {
    const {database, db} = emptyDatabase();
    writeItem(database, "chap1", v2);
    await recordContentChange(db, {
      action: "edit", after: v2, before: v1, itemId: "chap1",
    });

    const approved = await approveChapterVersions(db, "chap1", "reviewer-1");
    expect(approved).toBe(1);
    expect(await listPendingChapters(db)).toHaveLength(0);
    // Confirming is what makes the change public.
    expect(readItem(database, "chap1").title).toBe("第一章 起航");
    const rows = await listChapterReviews(db, "chap1");
    expect(rows[0]).toMatchObject({status: "approved", reviewedBy: "reviewer-1"});
  });

  it("rejecting restores the chapter to its pre-change content", async () => {
    const {database, db} = emptyDatabase();
    writeItem(database, "chap1", v2);
    await recordContentChange(db, {
      action: "edit", after: v2, before: v1, itemId: "chap1",
    });

    // The chapter never showed the new title — the gate kept it pinned.
    expect(readItem(database, "chap1").title).toBe("第一章 起锚");

    const result = await rejectChapterVersions(db, "chap1", "reviewer-1");
    expect(result).toEqual({rejected: 1, restored: true});

    // Still the approved content; the proposed change was dropped.
    expect(readItem(database, "chap1").title).toBe("第一章 起锚");
    expect(await listPendingChapters(db)).toHaveLength(0);
  });

  it("does not open a pending version for review decisions", async () => {
    const {database, db} = emptyDatabase();
    writeItem(database, "chap1", v2);
    await recordContentChange(db, {
      action: "restore",
      after: v2,
      before: v1,
      itemId: "chap1",
      openReview: false,
    });
    // The audit row is written, but no version waits for confirmation —
    // otherwise a decision would need re-deciding forever.
    expect(await listPendingChapters(db)).toHaveLength(0);
  });
});
