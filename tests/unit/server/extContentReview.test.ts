import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {
  approveChapterVersions,
  listChapterReviews,
  listPendingChapters,
  planContentChange,
  rejectChapterVersions,
  type AuditDb,
  type AuditDbPreparedStatement,
} from "@/server/feed/extContentReview";
import {listItemAuditRows, rebuildItemVersion} from "@/server/feed/extReview";
import {SETTINGS_CATEGORIES} from "@/shared/Constants";

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

// 本地回退：把 plan 语句逐条提交。生产路径走 db.batch() 与 item 写同批，
// 这里只是测试用的非批式等价实现——替代已删除的 recordContentChange 薄封装。
async function commitChange(
  db: AuditDb,
  params: Parameters<typeof planContentChange>[1],
): Promise<Awaited<ReturnType<typeof planContentChange>>["review"]> {
  const plan = await planContentChange(db, params);
  for (const statement of plan.statements) await statement.run();
  return plan.review;
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
    CREATE TABLE settings (
      category TEXT PRIMARY KEY,
      data TEXT
    );
  `);
  // The fixture represents an instance with the review gate ON: the chain tests
  // below are about checkpoint cadence, pinning and confirm/reject, not about
  // the switch. `setReviewEnabled` flips this row for the switch's own tests —
  // and with no row at all the gate is OFF (the production default).
  database.prepare("INSERT INTO settings (category, data) VALUES (?, ?)").run(
    SETTINGS_CATEGORIES.CONTENT_REVIEW,
    JSON.stringify({enabled: true}),
  );
  return {database, db: new SqliteAuditDb(database)};
}

/** Flip the `contentReview` switch in the fixture's settings row. */
function setReviewEnabled(database: DatabaseSync, enabled: boolean): void {
  database.prepare("UPDATE settings SET data = ? WHERE category = ?").run(
    JSON.stringify({enabled}),
    SETTINGS_CATEGORIES.CONTENT_REVIEW,
  );
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

    const review = await commitChange(db, {
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
    await commitChange(db, {
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

    await commitChange(db, {
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

  it("restores a Markdown body as Markdown, not as rendered HTML", async () => {
    // The body is stored as written, so restoring an old version must bring back
    // the Markdown source together with its format flag. Losing the flag would
    // make the reader print raw Markdown; rendering at save time would degrade
    // the source on every round trip.
    const {database, db} = emptyDatabase();
    const before = {
      content_format: "markdown",
      description: "# 一\n\n旧正文。",
      id: "chap1",
      title: "第一章 起锚",
    };
    const after = {
      ...before,
      description: "# 一\n\n新正文。",
    };
    writeItem(database, "chap1", before);
    writeItem(database, "chap1", after);
    await commitChange(db, {
      action: "edit", after, before, itemId: "chap1",
    });

    const trail = await listItemAuditRows(db, "chap1");
    expect(trail).toHaveLength(1);
    const rebuilt = await rebuildItemVersion(db, "chap1", trail[0]!.id);
    expect(rebuilt?.description).toBe(after.description);
    expect(rebuilt?.content_format).toBe("markdown");
  });

  it("queues the newest unconfirmed version's changes for review", async () => {
    const {database, db} = emptyDatabase();
    writeItem(database, "chap1", v1);
    writeItem(database, "chap1", v2);
    await commitChange(db, {
      action: "edit", after: v2, before: v1, itemId: "chap1",
    });
    // A second edit before anyone confirms: the queue shows ONE chapter with
    // two pending versions, and the diff belongs to the newest one.
    const v3 = {...v1, title: "第一章 归航"};
    writeItem(database, "chap1", v3);
    await commitChange(db, {
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
    expect(await commitChange(db, {
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
    await commitChange(db, {
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
    await commitChange(db, {
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
    await commitChange(db, {
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
    await commitChange(db, {
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

describe("content review switch", () => {
  it("records the change but opens no version when the switch is off", async () => {
    const {database, db} = emptyDatabase();
    setReviewEnabled(database, false);
    writeItem(database, "chap1", v1);

    const change = await commitChange(db, {
      action: "edit",
      after: v2,
      before: v1,
      itemId: "chap1",
    });

    expect(change).toBeNull();
    expect(await listPendingChapters(db)).toHaveLength(0);
    // The change is still on the record — "off" means no gate, not no history.
    const audit = database.prepare(
      "SELECT COUNT(*) AS c FROM ext_content_audit WHERE item_id = ?",
    ).get("chap1") as {c: number};
    expect(audit.c).toBeGreaterThan(0);
  });

  it("treats a missing settings row as off", async () => {
    const {database, db} = emptyDatabase();
    database.prepare("DELETE FROM settings WHERE category = ?")
      .run(SETTINGS_CATEGORIES.CONTENT_REVIEW);
    writeItem(database, "chap1", v1);

    expect(await commitChange(db, {
      action: "edit",
      after: v2,
      before: v1,
      itemId: "chap1",
    })).toBeNull();
    expect(await listPendingChapters(db)).toHaveLength(0);
  });

  it("still opens a version when a caller forces openReview", async () => {
    const {database, db} = emptyDatabase();
    setReviewEnabled(database, false);
    writeItem(database, "chap1", v1);

    expect(await commitChange(db, {
      action: "edit",
      after: v2,
      before: v1,
      itemId: "chap1",
      openReview: true,
    })).not.toBeNull();
    expect(await listPendingChapters(db)).toHaveLength(1);
  });

  it("omits a pending version whose chapter no longer exists", async () => {
    const {database, db} = emptyDatabase();
    writeItem(database, "chap1", v1);
    await commitChange(db, {
      action: "edit",
      after: v2,
      before: v1,
      itemId: "chap1",
    });
    expect(await listPendingChapters(db)).toHaveLength(1);

    // A delete that bypassed this chain (raw SQL, an import, a bulk cleanup)
    // leaves the pending row behind. It can never be confirmed, so the queue
    // must not list it as something to act on.
    database.prepare("DELETE FROM items WHERE id = ?").run("chap1");
    expect(await listPendingChapters(db)).toHaveLength(0);
  });
});
